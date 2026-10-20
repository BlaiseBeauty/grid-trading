require('dotenv').config();
const path = require('path');
const fastify = require('fastify')({
  logger: true,
  bodyLimit: 1024 * 1024,     // 1 MB — no route needs more
  requestTimeout: 30_000,     // abort slow/stalled request bodies
  // Behind Railway's proxy: without this every client shares the proxy IP and
  // per-IP rate limits (login etc.) would be global. Set TRUST_PROXY=false if exposed directly.
  trustProxy: process.env.TRUST_PROXY !== 'false',
});
const { migrate } = require('./db/migrate');
const logger = require('./services/logger');
const orchestrator = require('./systems/grid/agents/orchestrator');
const cycleGate = require('./shared/cycle-gate');
const { withAdvisoryLock } = require('./db/connection');
const prices = require('./services/prices');
const { CANDLE_SYMBOLS, PYTHON_ENGINE_URL, fetchLivePrice, refreshCandles, checkStopLossesFallback, getLivePricesWithChange, getOldPrices24h } = prices;

const PORT = process.env.PORT || 3100;

// Routes that failed to register at boot — surfaced by /api/system/ready
const failedRoutes = [];

// ---------- Plugins ----------
async function registerPlugins() {
  if (!process.env.CORS_ORIGINS && process.env.NODE_ENV === 'production') {
    console.warn('[GRID] WARNING: CORS_ORIGINS is not set in production — only localhost origins are allowed, so browsers on the real domain will be blocked.');
  }
  const allowedOrigins = process.env.CORS_ORIGINS
    ? process.env.CORS_ORIGINS.split(',').map(s => s.trim())
    : ['http://localhost:5173', 'http://localhost:3100']; // Explicit dev whitelist — never allow *
  await fastify.register(require('@fastify/cors'), {
    origin: allowedOrigins,
    credentials: true,
  });

  // Basic security headers (no extra dependency)
  fastify.addHook('onSend', async (request, reply, payload) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Referrer-Policy', 'strict-origin-when-cross-origin');
    if (process.env.NODE_ENV === 'production') {
      reply.header('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
    }
    return payload;
  });

  await fastify.register(require('@fastify/cookie'));

  // Rate limiting — protect expensive AI/cycle routes from abuse
  await fastify.register(require('@fastify/rate-limit'), {
    global: false, // Only apply where explicitly configured
    max: 20,
    timeWindow: '1 minute',
    errorResponseBuilder: () => ({ error: 'Too many requests — slow down' }),
  });

  // M-23: Handle empty POST bodies gracefully (Fastify rejects empty body with content-type: json)
  fastify.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
    try {
      done(null, body ? JSON.parse(body) : {});
    } catch (err) {
      done(err);
    }
  });

  // Serve React build in production, fallback to public/
  const fs = require('fs');
  const distPath = path.join(__dirname, 'frontend', 'dist');
  const staticRoot = fs.existsSync(distPath) ? distPath : path.join(__dirname, 'public');
  await fastify.register(require('@fastify/static'), {
    root: staticRoot,
    prefix: '/',
  });

  // maxPayload: the only client → server message is a small {type:'auth', token}
  await fastify.register(require('@fastify/websocket'), { options: { maxPayload: 8 * 1024 } });
}

// ---------- Auth Decorator ----------
const jwt = require('jsonwebtoken');

async function verifyToken(request, reply) {
  const authHeader = request.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return reply.code(401).send({ error: 'Missing token' });
  }
  try {
    const payload = jwt.verify(authHeader.slice(7), process.env.JWT_SECRET);
    request.user = payload;
  } catch {
    return reply.code(401).send({ error: 'Invalid token' });
  }
}

fastify.decorate('authenticate', verifyToken);

// ---------- WebSocket ----------
const wsClients = new Set();
const MAX_WS_CLIENTS = parseInt(process.env.MAX_WS_CLIENTS) || 50;
let wsPending = 0; // sockets connected but not yet authenticated

function broadcast(type, data) {
  const msg = JSON.stringify({ type, data, ts: Date.now() });
  for (const client of wsClients) {
    if (client.readyState === 1) {
      try { client.send(msg); } catch { wsClients.delete(client); }
    } else if (client.readyState > 1) {
      wsClients.delete(client);
    }
  }

  // Trigger calibration when trades close (debounced — runs at most once per 30s)
  if (type === 'positions_closed' || type === 'cycle_complete') {
    scheduleCalibration();
  }
}

let calibrationTimer = null;
function scheduleCalibration() {
  if (calibrationTimer) return; // already scheduled
  calibrationTimer = setTimeout(async () => {
    calibrationTimer = null;
    try {
      const { runCalibration } = require('./systems/grid/agents/calibration-worker');
      const result = await runCalibration();
      broadcast('calibration_update', result);
    } catch (err) {
      console.error('[CALIBRATION] Auto-run failed:', err.message);
    }
  }, 30_000);
}

// ---------- Routes ----------
async function registerRoutes() {
  // Safe plugin registration — catches require() and plugin init errors
  // so one broken route file cannot prevent WebSocket from registering
  const reg = async (label, path, opts) => {
    try {
      await fastify.register(require(path), opts);
    } catch (err) {
      failedRoutes.push({ label, error: err.message });
      console.error(`[ROUTES] ✗✗✗ ${label} FAILED TO REGISTER — its endpoints are DOWN: ${err.message}`);
      console.error(err.stack);
    }
  };

  // Auth routes (no auth required)
  await reg('auth', './api/auth', { prefix: '/api/auth' });

  // Public healthcheck (no auth — used by Railway)
  fastify.get('/api/system/health', async () => ({ status: 'ok', timestamp: Date.now() }));

  // Readiness: DB + Python engine + route registration. 503 when anything is down.
  // (Liveness stays on /api/system/health — Railway healthcheck path is unchanged.)
  fastify.get('/api/system/ready', async (request, reply) => {
    const checks = { db: false, engine: false, routes: failedRoutes.length === 0 };
    const { queryOne: readyQ } = require('./db/connection');
    try {
      await Promise.race([
        readyQ('SELECT 1 AS ok'),
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 3000)),
      ]);
      checks.db = true;
    } catch (err) {
      console.error('[READY] DB check failed:', err.message);
    }
    try {
      const res = await fetch(`${PYTHON_ENGINE_URL}/health`, { signal: AbortSignal.timeout(3000) });
      checks.engine = res.ok;
    } catch (err) {
      console.error('[READY] Python engine check failed:', err.message);
    }
    let busLag = null;
    if (checks.db) {
      try {
        busLag = await require('./shared/intelligence-bus').getBusLag();
      } catch (err) {
        console.error('[READY] bus lag check failed:', err.message);
      }
    }
    const ready = checks.db && checks.engine && checks.routes;
    reply.header('Cache-Control', 'no-store');
    return reply.code(ready ? 200 : 503).send({
      status: ready ? 'ready' : 'degraded',
      checks,
      bus_lag: busLag,
      failed_routes: failedRoutes,
      timestamp: Date.now(),
    });
  });

  // Live prices from exchange — authenticated; one DB lookup for all symbols
  fastify.get('/api/prices/live', {
    preHandler: fastify.authenticate,
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const rows = await getLivePricesWithChange(CANDLE_SYMBOLS);
    const out = {};
    for (const r of rows) out[r.symbol] = { price: r.price, change24h: r.change24h };
    return out;
  });

  // Protected API routes (GRID system)
  await reg('grid/portfolio', './systems/grid/api/portfolio', { prefix: '/api' });
  await reg('grid/trades', './systems/grid/api/trades', { prefix: '/api' });
  await reg('grid/agents', './systems/grid/api/agents', { prefix: '/api' });
  await reg('grid/market-data', './systems/grid/api/market-data', { prefix: '/api' });
  await reg('grid/signals', './systems/grid/api/signals', { prefix: '/api' });
  await reg('grid/templates', './systems/grid/api/templates', { prefix: '/api' });
  await reg('grid/learnings', './systems/grid/api/learnings', { prefix: '/api' });
  await reg('grid/costs', './systems/grid/api/costs', { prefix: '/api' });
  await reg('grid/system', './systems/grid/api/system', { prefix: '/api' });
  await reg('grid/analytics', './systems/grid/api/analytics', { prefix: '/api' });
  await reg('grid/notifications', './systems/grid/api/notifications', { prefix: '/api' });
  await reg('grid/standing-orders', './systems/grid/api/standing-orders', { prefix: '/api' });
  await reg('grid/events', './systems/grid/api/events', { prefix: '/api' });
  await reg('grid/calibration', './systems/grid/api/calibration', { prefix: '/api' });
  await reg('grid/cycle-reports', './systems/grid/api/cycle-reports', { prefix: '/api' });
  await reg('grid/backtest', './systems/grid/api/backtest', { prefix: '/api' });

  // Platform API routes (shared across systems)
  await reg('platform/notifications', './api/platform/notifications', { prefix: '/api/platform' });
  await reg('platform/health', './api/platform/health', { prefix: '/api/platform' });
  await reg('platform/costs', './api/platform/costs', { prefix: '/api/platform' });

  // GRID performance digest API
  await reg('grid/performance-digest', './systems/grid/api/performance-digest', { prefix: '/api' });

  // GRID patterns API (Phase 5 — learning loop)
  await reg('grid/patterns', './systems/grid/api/patterns', { prefix: '/api' });

  // Observation mode — passive market data collection (no AI, no trades)
  await reg('grid/observation', './systems/grid/api/observation', { prefix: '/api' });

  // ORACLE API routes
  await reg('oracle/theses', './systems/oracle/api/theses', { prefix: '/api/oracle' });

  // COMPASS API routes
  await reg('compass/portfolio', './systems/compass/api/portfolio', { prefix: '/api/compass' });

  // WebSocket endpoint — auth via first message (token never in URL/logs)
  try {
    await fastify.register(async function (fastify) {
      fastify.get('/ws', { websocket: true }, (socket) => {
        let authenticated = false;
        let expiryTimer = null;

        // Connection cap (authenticated + pending) — protects memory/fan-out
        if (wsClients.size + wsPending >= MAX_WS_CLIENTS) {
          socket.close(1013, 'Too many connections');
          return;
        }
        wsPending++;
        let pendingCounted = true;
        const releasePending = () => {
          if (pendingCounted) { pendingCounted = false; wsPending--; }
        };

        // Close unauthenticated connections after 5s
        const authTimeout = setTimeout(() => {
          if (!authenticated) socket.close(4401, 'Authentication timeout');
        }, 5000);

        socket.on('message', (raw) => {
          try {
            const msg = JSON.parse(raw.toString());
            if (msg.type === 'auth' && msg.token) {
              // Also used for in-place re-auth after the frontend refreshes its access token
              const payload = jwt.verify(msg.token, process.env.JWT_SECRET);
              authenticated = true;
              clearTimeout(authTimeout);
              releasePending();
              wsClients.add(socket);

              // Close the socket when this access token expires (client reconnects / re-auths)
              if (expiryTimer) clearTimeout(expiryTimer);
              const msLeft = payload.exp ? payload.exp * 1000 - Date.now() : 15 * 60 * 1000;
              expiryTimer = setTimeout(() => socket.close(4401, 'Token expired'), Math.max(msLeft, 0));
            } else if (!authenticated) {
              socket.close(4401, 'Authentication required');
            }
            // authenticated + non-auth messages are ignored (server → client feed only)
          } catch (err) {
            console.warn('[WS] Auth/message rejected:', err.message);
            socket.close(4401, 'Invalid token');
          }
        });

        socket.on('close', () => {
          clearTimeout(authTimeout);
          if (expiryTimer) clearTimeout(expiryTimer);
          releasePending();
          wsClients.delete(socket);
        });

        socket.on('error', (err) => {
          console.warn('[WS] Socket error:', err.message);
        });
      });
    }, {});
    console.log('[ROUTES] ✓ WebSocket /ws registered');
  } catch (err) {
    failedRoutes.push({ label: 'websocket', error: err.message });
    console.error('[ROUTES] ✗✗✗ WebSocket FAILED TO REGISTER:', err.message);
    console.error(err.stack);
  }

  // SPA fallback — serve index.html for non-API, non-file routes
  fastify.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith('/api/')) {
      return reply.code(404).send({ error: 'Not found' });
    }
    return reply.sendFile('index.html');
  });
}

// ---------- Cron ----------
const cron = require('node-cron');

// ── MASTER PAUSE SWITCH ────────────────────────────────────────────────────
// AI agent cycles (GRID / COMPASS / ORACLE) are gated by shared/cycle-gate.js:
//   CYCLES_PAUSED env (default true), AI_DAILY_BUDGET_USD, 10 cycles / 24h.
// Non-AI crons (SL monitor, data fetch, cleanup) are unaffected.

// Cron/boot gate: pause + daily budget (+ optional 10-cycles/24h). Fails closed on DB errors.
async function cycleAllowedNow(label, { checkCycles = false } = {}) {
  if (cycleGate.isPaused()) { console.log(`[CRON] ${label} skipped — CYCLES_PAUSED`); return false; }
  const g = await cycleGate.gate({ checkCycles });
  if (!g.ok) { console.warn(`[CRON] ${label} skipped — ${g.error}`); return false; }
  return true;
}

function setupCron() {
  const orchestrator = require('./systems/grid/agents/orchestrator');
  const { recordTradeCloseLearningOutcome, checkAndPromoteBootstrapPhase } = orchestrator;
  const { linkTradeToTheses } = require('./shared/thesis-linker');
  const { queryOne: queryOneTrade } = require('./db/connection');
  const standingOrdersDb = require('./db/queries/standing-orders');
  const signalsDb = require('./db/queries/signals');
  const equityDb = require('./db/queries/equity');
  const portfolioDb = require('./db/queries/portfolio');
  const { fetchAll } = require('./systems/grid/agents/external-data-fetcher');
  const { computeCorrelations } = require('./systems/grid/agents/correlation-calculator');
  const { runCalibration } = require('./systems/grid/agents/calibration-worker');
  const { queryOne: queryOneDb } = require('./db/connection');
  const bus = require('./shared/intelligence-bus');

  const { recordHeartbeat } = require('./shared/system-health');

  // --- GRID: 4-hour agent cycle ---
  cron.schedule('0 */4 * * *', async () => {
    console.log('[CRON] 4-hour cycle triggered at', new Date().toISOString());
    // Pause switch + daily AI budget + 10-cycles/24h (fails closed)
    if (!await cycleAllowedNow('GRID cycle', { checkCycles: true })) return;
    // Advisory lock: a second replica skips instead of running a duplicate cycle
    await withAdvisoryLock('grid_cycle', async () => {
      console.log('[CRON] Starting agent cycle...');
      const cycleStart = Date.now();
      try {
        const result = await orchestrator.runCycle({ broadcast });
        if (result?.aborted) {
          console.error(`[CRON] Cycle aborted: ${result.reason}`);
          broadcast('cycle_error', { reason: result.reason });
        }

        // Record successful heartbeat
        await recordHeartbeat({
          system_name:       'grid',
          status:            (result?.aborted || result?.agentsFailed > 0) ? 'degraded' : 'healthy',
          last_cycle_at:     new Date(cycleStart),
          next_cycle_at:     new Date(cycleStart + 4 * 60 * 60 * 1000),
          cycle_duration_ms: Date.now() - cycleStart,
          agents_succeeded:  result?.agentsSucceeded ?? null,
          agents_failed:     result?.agentsFailed || 0,
        });
      } catch (err) {
        console.error('[CRON] Agent cycle failed:', err.message);
        broadcast('cycle_error', { error: err.message });

        await recordHeartbeat({
          system_name:       'grid',
          status:            'down',
          last_cycle_at:     new Date(cycleStart),
          cycle_duration_ms: Date.now() - cycleStart,
          error_message:     err.message,
        });
      }
    });
  });

  /**
   * Called whenever trades close via the position monitor or Node.js fallback.
   * Fires the learning feedback loop and thesis linkage for each closed trade.
   * Each item in `closed` must have at least { trade_id, action }.
   */
  async function processTradeCloseOutcomes(closed) {
    for (const c of closed) {
      try {
        const trade = await queryOneTrade(
          `SELECT id, symbol, side, pnl_realised, pnl_pct, opened_at FROM trades WHERE id = $1`,
          [c.trade_id]
        );
        if (!trade) {
          console.warn(`[LEARNING] processTradeCloseOutcomes: trade #${c.trade_id} not found in DB`);
          continue;
        }
        console.log(`[LEARNING] Processing close for trade #${trade.id} (${c.action})`);
        await recordTradeCloseLearningOutcome(trade.id, trade.pnl_realised ?? 0);
        try {
          await linkTradeToTheses({
            id:           trade.id,
            symbol:       trade.symbol,
            side:         trade.side,
            pnl_usd:      trade.pnl_realised ?? 0,
            pnl_pct:      trade.pnl_pct ?? 0,
            close_reason: c.action,
            hold_hours:   trade.opened_at ? (Date.now() - new Date(trade.opened_at)) / 3600000 : 0,
          });
        } catch (e) {
          console.error(`[LEARNING] linkTradeToTheses failed for trade #${trade.id}:`, e.message);
        }
        try {
          await bus.publish({
            source_system:   'grid',
            event_type:      'trade_closed',
            payload:         { trade_id: trade.id, symbol: trade.symbol, side: trade.side, pnl_usd: trade.pnl_realised, close_reason: c.action },
            affected_assets: [trade.symbol],
          });
        } catch (e) { console.error(`[LEARNING] bus publish failed for trade #${trade.id} (best-effort):`, e.message); }
      } catch (err) {
        console.error(`[LEARNING] processTradeCloseOutcomes failed for trade #${c.trade_id}:`, err.message);
      }
    }
    // After processing all closed trades, re-check bootstrap phase promotion
    checkAndPromoteBootstrapPhase().catch(err =>
      console.error('[BOOTSTRAP] Phase check after trade close failed:', err.message)
    );
  }

  // Stop loss / take profit enforcement — every minute
  let slCheckRunning = false;
  cron.schedule('* * * * *', async () => {
    if (slCheckRunning) return; // skip if previous check still running
    slCheckRunning = true;
    try {
      // Advisory lock: only one replica monitors positions per tick
      // (the learning step below runs only for trades THIS process closed — closes are
      // already exclusive via SELECT ... FOR UPDATE — so it is deliberately not locked:
      // a skipped lock there would silently drop learning outcomes).
      await withAdvisoryLock('grid_sl_monitor', async () => {
        try {
          const result = await orchestrator.monitorPositions();
          const closed = (result?.results || []).filter(r => r.action === 'sl_hit' || r.action === 'tp_hit' || r.action === 'trail_hit');
          if (closed.length > 0) {
            console.log(`[CRON] ${closed.length} position(s) closed by Python monitor`);
            broadcast('positions_closed', { closed });
            processTradeCloseOutcomes(closed).catch(err =>
              console.error('[LEARNING] processTradeCloseOutcomes (monitor) failed:', err.message)
            );
          }
        } catch (err) {
          console.error('[CRON] Python position monitor failed:', err.message);
          console.log('[CRON] Running Node.js stop-loss fallback...');
          try {
            const closed = await checkStopLossesFallback();
            if (closed.length > 0) {
              console.log(`[CRON] ${closed.length} position(s) closed by Node.js fallback`);
              broadcast('positions_closed', { closed });
              processTradeCloseOutcomes(closed).catch(err =>
                console.error('[LEARNING] processTradeCloseOutcomes (fallback) failed:', err.message)
              );
            }
          } catch (fallbackErr) {
            console.error('[CRON] Node.js stop-loss fallback also failed:', fallbackErr.message);
          }
        }
      });
    } finally {
      slCheckRunning = false;
    }
  });

  // Check standing order triggers every 15 minutes
  cron.schedule('*/15 * * * *', async () => {
    // Expiry sweep always runs — even during an active cycle
    try {
      const expired = await standingOrdersDb.expireOld();
      if (expired.rowCount > 0) console.log(`[CRON] Expired ${expired.rowCount} standing orders`);
    } catch (err) {
      console.error('[CRON] Standing order expiry failed:', err.message);
    }
    // M-14: Skip trigger check + retry if a cycle is actively running to prevent race conditions
    if (orchestrator.isCycleRunning()) {
      console.log('[CRON] Skipping standing order trigger check — cycle in progress');
      return;
    }
    console.log('[CRON] Monitoring standing orders...');
    try {
      // Retry orders that failed due to transient errors (15-min cooldown)
      await standingOrdersDb.retryPending();
      await orchestrator.checkStandingOrders(broadcast);
    } catch (err) {
      console.error('[CRON] Standing order check failed:', err.message);
    }
  });

  // Clean expired signals + intelligence bus every hour
  const { checkNoTradeSituation } = require('./systems/grid/agents/no-trade-monitor');
  cron.schedule('0 * * * *', async () => {
    try {
      await signalsDb.cleanExpired();
      console.log('[CRON] Cleaned expired signals');
    } catch (err) {
      console.error('[CRON] Signal cleanup failed:', err.message);
    }
    try {
      const cleaned = await bus.cleanup();
      if (cleaned.deleted > 0) console.log(`[CRON] Bus cleanup: removed ${cleaned.deleted} expired events`);
    } catch (err) {
      console.error('[CRON] Bus cleanup failed:', err.message);
    }
    // Purge processed oracle raw feed items older than 30 days
    try {
      const { query: rawQ } = require('./db/connection');
      const purged = await rawQ(
        `DELETE FROM oracle_raw_feed WHERE processed = TRUE AND created_at < NOW() - INTERVAL '30 days'`
      );
      if (purged.rowCount > 0) console.log(`[CRON] Oracle raw feed purge: ${purged.rowCount} items`);
    } catch (err) {
      console.error('[CRON] Oracle raw feed purge failed:', err.message);
    }
    // No-trade alert — fires if no trades in 48h with diagnosis of why
    try {
      await checkNoTradeSituation();
    } catch (err) {
      console.error('[CRON] No-trade monitor failed:', err.message);
    }
  });

  // ── GRID: weekly performance digest — every Monday at 06:00 ──────────────────
  // Runs BEFORE ORACLE's Monday cycle so ORACLE has fresh data immediately
  const { buildDigest } = require('./systems/grid/agents/performance-digest');
  cron.schedule('0 6 * * 1', async () => {
    if (cycleGate.isPaused()) { console.log('[CRON] Digest skipped — CYCLES_PAUSED'); return; }
    console.log('[CRON] Building weekly performance digest...');
    try {
      await buildDigest();
    } catch (err) {
      console.error('[CRON] Digest build failed:', err.message);
    }
  });

  // Hourly position review (independent of 4h cycle, runs at :30)
  cron.schedule('30 * * * *', async () => {
    if (!await cycleAllowedNow('Position review')) return;
    if (orchestrator.isCycleRunning()) {
      console.log('[CRON] Skipping hourly position review — GRID cycle in progress');
      return;
    }
    console.log('[CRON] Running hourly position review...');
    try {
      // cycleNumber -1 indicates an out-of-cycle hourly review
      const result = await orchestrator.reviewOpenPositions(-1, broadcast);
      console.log(`[CRON] Position review: ${result.reviews.length} reviewed`);
    } catch (err) {
      console.error('[CRON] Hourly position review failed:', err.message);
    }
  });

  // Fetch external data every 30 minutes
  let externalFetchRunning = false;
  cron.schedule('*/30 * * * *', async () => {
    if (externalFetchRunning) return;
    externalFetchRunning = true;
    try { await fetchAll(); }
    catch (err) { console.error('[CRON] External data fetch failed:', err.message); }
    finally { externalFetchRunning = false; }
  });

  // Fetch fresh candles every 5 minutes (keeps market_data current)
  let candleRefreshRunning = false;
  cron.schedule('*/5 * * * *', async () => {
    if (candleRefreshRunning) return;
    candleRefreshRunning = true;
    try { await refreshCandles(); }
    catch (err) { console.error('[CRON] Candle refresh failed:', err.message); }
    finally { candleRefreshRunning = false; }
  });

  // Python engine health check every 5 minutes
  let pythonFailCount = 0;
  cron.schedule('*/5 * * * *', async () => {
    try {
      const res = await fetch(`${PYTHON_ENGINE_URL}/health`, {
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      if (pythonFailCount > 0) console.log('[HEALTH] Python engine recovered');
      pythonFailCount = 0;
    } catch (err) {
      pythonFailCount++;
      console.error(`[HEALTH] Python engine check failed (${pythonFailCount}/3): ${err.message}`);
      if (pythonFailCount >= 3) {
        console.error('[CRITICAL] Python engine unreachable — 3 consecutive failures');
        broadcast('scram_warning', {
          reason: 'Python engine unreachable',
          failures: pythonFailCount,
        });
      }
    }
  });

  // Hourly equity snapshot for drawdown tracking (independent of agent cycles)
  cron.schedule('15 * * * *', async () => {
    try {
      const pv = await portfolioDb.getPortfolioValue();
      const openCountRow = await queryOneDb("SELECT COUNT(*)::int as cnt FROM trades WHERE status = 'open'");
      const openCount = parseInt(openCountRow?.cnt) || 0;
      await equityDb.insert({
        cycleNumber: -1, // -1 indicates hourly snapshot, not a cycle
        totalValue: pv.total_value,
        realisedPnl: pv.realised_pnl,
        unrealisedPnl: pv.unrealised_pnl,
        openPositions: openCount,
      });
      console.log(`[CRON] Equity snapshot recorded: $${pv.total_value.toFixed(2)}`);
    } catch (err) {
      console.error('[CRON] Equity snapshot failed:', err.message);
    }
  });

  // ── OBSERVATION MODE: market data collection every 6h ────────────────────────
  // Zero AI calls. Zero trades. Just watching and logging.
  const { runObservation } = require('./systems/grid/observation/market-observer');
  let observationRunning = false;
  cron.schedule('30 */6 * * *', async () => {
    if (observationRunning) return;
    observationRunning = true;
    try { await runObservation(); }
    catch (err) { console.error('[CRON] Observation failed:', err.message); }
    finally { observationRunning = false; }
  });

  // Correlation matrix recomputation every 6 hours
  let correlationRunning = false;
  cron.schedule('0 */6 * * *', async () => {
    if (correlationRunning) return;
    correlationRunning = true;
    console.log('[CRON] Recomputing correlation matrix...');
    try {
      const result = await computeCorrelations();
      broadcast('correlation_update', result);
      console.log(`[CRON] Correlations updated: ${JSON.stringify(result)}`);
    } catch (err) {
      console.error('[CRON] Correlation computation failed:', err.message);
    } finally {
      correlationRunning = false;
    }
  });

  // Daily confidence calibration at 00:00 UTC
  cron.schedule('0 0 * * *', async () => {
    console.log('[CRON] Running daily confidence calibration...');
    try {
      const result = await runCalibration();
      broadcast('calibration_update', result);
      console.log(`[CRON] Calibration complete: ${result.totalTrades} trades across ${result.buckets.length} buckets`);
    } catch (err) {
      console.error('[CRON] Calibration failed:', err.message);
    }
  });

  // Daily cost summary at 00:00 UTC — log spend and alert if over threshold
  cron.schedule('0 0 * * *', async () => {
    const { queryOne: costQuery } = require('./db/connection');
    try {
      const [costRow, tradeRow] = await Promise.all([
        costQuery(`
          SELECT
            COALESCE(SUM(cost_usd), 0)::float       AS total_cost,
            COUNT(DISTINCT cycle_id)::int            AS cycles
          FROM platform_ai_costs
          WHERE created_at >= CURRENT_DATE
            AND source_system = 'grid'
        `),
        costQuery(`
          SELECT COUNT(*)::int AS trades_today
          FROM trades
          WHERE status = 'closed' AND closed_at >= CURRENT_DATE
        `),
      ]);
      const spend  = parseFloat(costRow?.total_cost || 0);
      const cycles = parseInt(costRow?.cycles       || 0);
      const trades = parseInt(tradeRow?.trades_today || 0);
      console.log(`[COSTS] Daily spend: $${spend.toFixed(2)} | Cycles run: ${cycles} | Trades executed: ${trades}`);
      if (spend > 5.00) {
        broadcast('cost_alert', { daily_spend: spend, cycles, trades, threshold: 5.00 });
        console.warn(`[COSTS] ALERT: Daily spend $${spend.toFixed(2)} exceeds $5.00 threshold`);
      }
    } catch (err) {
      console.error('[COSTS] Daily summary failed:', err.message);
    }
  });

  // Broadcast live prices every 10 seconds

  let priceBroadcastRunning = false;
  setInterval(async () => {
    if (priceBroadcastRunning) return; // don't stack if a round is slow
    priceBroadcastRunning = true;
    try {
      // One batched 24h-ago lookup for all symbols (was one query per symbol)
      const oldPrices = await getOldPrices24h(CANDLE_SYMBOLS);
      for (const symbol of CANDLE_SYMBOLS) {
        try {
          const result = await fetchLivePrice(symbol);
          if (!result) continue;

          const oldPrice = oldPrices[symbol] ?? null;
          const change24h = oldPrice && oldPrice > 0 ? ((result.price - oldPrice) / oldPrice) * 100 : null;
          broadcast('price_update', { symbol: result.dashSym, price: result.price, change24h });
        } catch (err) {
          console.error(`[PRICE] ${symbol} broadcast failed:`, err.message);
        }
      }
    } catch (err) {
      console.error('[PRICE] broadcast round failed:', err.message);
    } finally {
      priceBroadcastRunning = false;
    }
  }, 10_000);

  // --- COMPASS cron ---
  // COMPASS cycle — runs at :15 past 1,7,13,19 (45min after ORACLE finishes)
  const compassOrchestrator = require('./systems/compass/agents/orchestrator');
  cron.schedule('15 1,7,13,19 * * *', async () => {
    if (!await cycleAllowedNow('COMPASS cycle')) return;
    if (compassOrchestrator.isCycleRunning()) {
      console.log('[CRON] Skipping COMPASS cycle — previous still running');
      return;
    }
    await withAdvisoryLock('compass_cycle', async () => {
      console.log('[CRON] Starting COMPASS cycle...');
      try {
        await compassOrchestrator.runCycle({ broadcast });
      } catch (err) {
        console.error('[CRON] COMPASS cycle failed:', err.message);
      }
    });
  });

  // --- ORACLE cron ---
  const { runIngestion } = require('./systems/oracle/ingestion/orchestrator');
  const oracleOrchestrator = require('./systems/oracle/agents/orchestrator');

  // ORACLE ingestion — runs at :00 of 0,6,12,18 (30 min BEFORE agent cycle)
  let ingestionRunning = false;
  cron.schedule('0 0,6,12,18 * * *', async () => {
    if (cycleGate.isPaused()) { console.log('[CRON] ORACLE ingestion skipped — CYCLES_PAUSED'); return; }
    if (ingestionRunning) {
      console.log('[CRON] Skipping ORACLE ingestion — previous still running');
      return;
    }
    ingestionRunning = true;
    console.log('[CRON] Starting ORACLE ingestion...');
    try {
      await runIngestion();
    } catch (err) {
      console.error('[CRON] ORACLE ingestion failed:', err.message);
    } finally {
      ingestionRunning = false;
    }
  });

  // ORACLE agent cycle — runs at :30 of 0,6,12,18 (after ingestion)
  cron.schedule('30 0,6,12,18 * * *', async () => {
    if (!await cycleAllowedNow('ORACLE cycle')) return;
    if (oracleOrchestrator.isCycleRunning()) {
      console.log('[CRON] Skipping ORACLE cycle — previous still running');
      return;
    }
    await withAdvisoryLock('oracle_cycle', async () => {
      console.log('[CRON] Starting ORACLE cycle...');
      try {
        await oracleOrchestrator.runCycle({ broadcast });
      } catch (err) {
        console.error('[CRON] ORACLE cycle failed:', err.message);
      }
    });
  });

  // ORACLE: Graveyard Auditor — every Tuesday at 07:00
  // Runs after Monday's digest (06:00) so trade outcomes are fresh
  cron.schedule('0 7 * * 2', async () => {
    if (!await cycleAllowedNow('Graveyard Auditor')) return;
    console.log('[CRON] Starting Graveyard Auditor...');
    try {
      const { runGraveyardAuditor } = require('./systems/oracle/agents/graveyard-auditor');
      const { updateDomainCalibration } = require('./systems/oracle/agents/calibration');

      const result = await runGraveyardAuditor();

      // Update calibration for each domain that had activity
      const domains = ['macro', 'geopolitical', 'technology', 'commodity', 'equity', 'crypto'];
      for (const domain of domains) {
        try {
          await updateDomainCalibration(domain);
        } catch (err) {
          console.error(`[CRON] Calibration update failed for ${domain}:`, err.message);
        }
      }

      console.log(
        `[CRON] Graveyard Auditor complete: ${result.audited} audited, ` +
        `${result.learnings?.length || 0} learnings`
      );
    } catch (err) {
      console.error('[CRON] Graveyard Auditor failed:', err.message);
    }
  });
}

// ---------- Boot ----------
async function start() {
  // Validate required environment variables
  const required = ['DATABASE_URL', 'JWT_SECRET', 'JWT_REFRESH_SECRET', 'ANTHROPIC_API_KEY', 'ADMIN_PASSWORD'];
  const missing = required.filter(k => !process.env[k]);
  if (missing.length > 0) {
    console.error(`[GRID] FATAL: Missing required environment variables: ${missing.join(', ')}`);
    process.exit(1);
  }

  // Warn if Python engine URL points to localhost (won't work on Railway)
  const pyUrl = process.env.PYTHON_ENGINE_URL || '';
  if (pyUrl.includes('localhost') || pyUrl.includes('127.0.0.1')) {
    console.warn(`[GRID] WARNING: PYTHON_ENGINE_URL (${pyUrl}) points to localhost — this will fail in production. Use the internal service URL.`);
  }

  try {
    // Run migrations
    await migrate();

    // Register plugins & routes
    await registerPlugins();
    await registerRoutes();

    // Make broadcast available to route handlers
    fastify.decorate('broadcast', broadcast);

    // Inject broadcast into intelligence bus so it can fan out WS events
    const bus = require('./shared/intelligence-bus');
    bus.init(broadcast);

    // Bootstrap phase correction — runs before cron starts, corrects any stale phase
    try {
      await orchestrator.checkAndPromoteBootstrapPhase();
    } catch (err) {
      console.error('[BOOTSTRAP] Boot-time phase check failed:', err.message);
    }

    // Start cron
    setupCron();

    // Live trading readiness gate — block startup if conditions not met
    if (process.env.LIVE_TRADING_ENABLED === 'true') {
      const { checkLiveTradingReadiness } = require('./systems/grid/agents/readiness-check');
      const r = await checkLiveTradingReadiness();
      if (!r.ready) {
        console.error('[GRID] LIVE TRADING BLOCKED — CONDITIONS NOT MET:');
        r.conditions.filter(c => !c.passed).forEach(c =>
          console.error(`  ✗ ${c.label}: ${c.current} / ${c.required}`)
        );
        process.exit(1);
      }
      console.log('[GRID] Live trading readiness verified ✓');
    }

    // One-time boot cycle — confirm orchestrator works on this deployment
    // Skipped when CYCLES_PAUSED (observation mode) to avoid AI spend on deploy
    // (uses the module-level `orchestrator`; a local const here would put the earlier
    //  boot-time phase check in the temporal dead zone)
    setTimeout(async () => {
      if (cycleGate.isPaused()) {
        console.log('[BOOT] Boot cycle skipped — CYCLES_PAUSED (observation mode)');
        return;
      }
      console.log('[BOOT] Firing one-time cycle 10s after startup...');
      // Daily budget + 10-cycles/24h, fail closed
      if (!await cycleAllowedNow('Boot cycle', { checkCycles: true })) {
        console.log('[BOOT] Boot cycle skipped — gate closed');
        return;
      }
      withAdvisoryLock('grid_cycle', () => orchestrator.runCycle({ broadcast })).catch(err => {
        console.error('[BOOT] One-time cycle failed:', err.message);
      });
    }, 10000);

    // Crash recovery: restore exchange SL/TP orders for live trades missing them
    if (process.env.LIVE_TRADING_ENABLED === 'true') {
      try {
        const res = await fetch(`${PYTHON_ENGINE_URL}/recover-orders`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
          signal: AbortSignal.timeout(30000),
        });
        const recovery = await res.json();
        if (recovery.recovered > 0) {
          console.log(`[BOOT] Crash recovery: restored ${recovery.recovered} exchange order(s)`);
        } else {
          console.log('[BOOT] Crash recovery: no orphaned live trades');
        }
      } catch (err) {
        console.error('[BOOT] Crash recovery failed (Python engine may not be ready):', err.message);
      }
    }

    // Fetch external data + fresh candles on boot
    const { fetchAll } = require('./systems/grid/agents/external-data-fetcher');
    fetchAll().catch(err => console.error('[BOOT] External data fetch failed:', err.message));
    refreshCandles({ backfill: true }).then(() => console.log('[BOOT] Candle refresh complete')).catch(err => console.error('[BOOT] Candle refresh failed:', err.message));

    // First observation on boot (non-blocking) — starts populating market_observations immediately
    const { runObservation } = require('./systems/grid/observation/market-observer');
    setTimeout(() => {
      runObservation().catch(err => console.error('[BOOT] Initial observation failed:', err.message));
    }, 5000);

    // Eagerly initialise cycle number from DB so deploy log confirms the value
    await orchestrator.initCycleNumber().catch(err => console.error('[BOOT] Cycle number init failed:', err.message));

    // Boot-time phase correction — ensures phase is up-to-date without waiting for next cycle
    await orchestrator.checkAndPromoteBootstrapPhase().catch(err =>
      console.error('[BOOT] Bootstrap phase check failed:', err.message)
    );

    // Listen
    await fastify.listen({ port: PORT, host: '0.0.0.0' });
    console.log(`[GRID] Server running on port ${PORT}`);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
}

// ---------- Graceful Shutdown ----------
async function gracefulShutdown(signal) {
  console.log(`[GRID] ${signal} received — shutting down gracefully`);

  // Stop accepting new connections
  try {
    await fastify.close();
  } catch (err) {
    console.error('[GRID] Error closing Fastify:', err.message);
  }

  // Close DB pool
  try {
    const { pool } = require('./db/connection');
    await pool.end();
    console.log('[GRID] DB pool closed');
  } catch (err) {
    console.error('[GRID] Error closing DB pool:', err.message);
  }

  console.log('[GRID] Shutdown complete');
  process.exit(0);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

start();
