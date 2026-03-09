require('dotenv').config();
const path = require('path');
const fastify = require('fastify')({ logger: true });
const { migrate } = require('./db/migrate');
const logger = require('./services/logger');

const PORT = process.env.PORT || 3100;

// ---------- Plugins ----------
async function registerPlugins() {
  const allowedOrigins = process.env.CORS_ORIGINS
    ? process.env.CORS_ORIGINS.split(',').map(s => s.trim())
    : true; // Allow all in development
  await fastify.register(require('@fastify/cors'), {
    origin: allowedOrigins,
    credentials: true,
  });

  await fastify.register(require('@fastify/cookie'));

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

  await fastify.register(require('@fastify/websocket'));
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
  // Auth routes (no auth required)
  fastify.register(require('./api/auth'), { prefix: '/api/auth' });

  // Public healthcheck (no auth — used by Railway)
  fastify.get('/api/system/health', async () => ({ status: 'ok', timestamp: Date.now() }));

  // Live prices from exchange (no auth — used for real-time display)
  const { queryOne: queryOnePriceLive } = require('./db/connection');
  fastify.get('/api/prices/live', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const results = await Promise.all(
      CANDLE_SYMBOLS.map(async (symbol) => {
        const result = await fetchLivePrice(symbol);
        if (!result) return null;
        // Use CoinGecko's 24h change if available, otherwise compute from DB
        let change24h = result.change24h ?? null;
        if (change24h == null) {
          try {
            const old24h = await queryOnePriceLive(
              `SELECT close FROM market_data WHERE symbol = $1 AND timestamp <= NOW() - interval '24 hours' ORDER BY timestamp DESC LIMIT 1`,
              [symbol]
            );
            const oldPrice = old24h ? parseFloat(old24h.close) : null;
            change24h = oldPrice && oldPrice > 0 ? ((result.price - oldPrice) / oldPrice) * 100 : null;
          } catch (err) {
            logger.debug('24h price change query failed', { err, symbol, error_type: 'price_fallback' });
          }
        }
        return { symbol: result.dashSym, price: result.price, change24h };
      })
    );
    const prices = {};
    for (const r of results) {
      if (r) prices[r.symbol] = { price: r.price, change24h: r.change24h };
    }
    return prices;
  });

  // Protected API routes (GRID system)
  fastify.register(require('./systems/grid/api/portfolio'), { prefix: '/api' });
  fastify.register(require('./systems/grid/api/trades'), { prefix: '/api' });
  fastify.register(require('./systems/grid/api/agents'), { prefix: '/api' });
  fastify.register(require('./systems/grid/api/market-data'), { prefix: '/api' });
  fastify.register(require('./systems/grid/api/signals'), { prefix: '/api' });
  fastify.register(require('./systems/grid/api/templates'), { prefix: '/api' });
  fastify.register(require('./systems/grid/api/learnings'), { prefix: '/api' });
  fastify.register(require('./systems/grid/api/costs'), { prefix: '/api' });
  fastify.register(require('./systems/grid/api/system'), { prefix: '/api' });
  fastify.register(require('./systems/grid/api/analytics'), { prefix: '/api' });
  fastify.register(require('./systems/grid/api/notifications'), { prefix: '/api' });
  fastify.register(require('./systems/grid/api/standing-orders'), { prefix: '/api' });
  fastify.register(require('./systems/grid/api/events'), { prefix: '/api' });
  fastify.register(require('./systems/grid/api/calibration'), { prefix: '/api' });
  fastify.register(require('./systems/grid/api/cycle-reports'), { prefix: '/api' });
  fastify.register(require('./systems/grid/api/backtest'), { prefix: '/api' });

  // Platform API routes (shared across systems)
  fastify.register(require('./api/platform/notifications'), { prefix: '/api/platform' });
  fastify.register(require('./api/platform/health'), { prefix: '/api/platform' });
  fastify.register(require('./api/platform/costs'), { prefix: '/api/platform' });

  // GRID performance digest API
  fastify.register(require('./systems/grid/api/performance-digest'), { prefix: '/api' });

  // GRID patterns API (Phase 5 — learning loop)
  fastify.register(require('./systems/grid/api/patterns'), { prefix: '/api' });

  // ORACLE API routes
  fastify.register(require('./systems/oracle/api/theses'), { prefix: '/api/oracle' });

  // COMPASS API routes
  fastify.register(require('./systems/compass/api/portfolio'), { prefix: '/api/compass' });

  // WebSocket endpoint — requires JWT token as query parameter
  fastify.register(async function (fastify) {
    fastify.get('/ws', { websocket: true }, (socket, req) => {
      // Verify JWT from query string: /ws?token=<jwt>
      const url = new URL(req.url, `http://${req.headers.host}`);
      const token = url.searchParams.get('token');
      if (!token) {
        socket.close(4401, 'Authentication required');
        return;
      }
      try {
        jwt.verify(token, process.env.JWT_SECRET);
      } catch {
        socket.close(4401, 'Invalid token');
        return;
      }
      wsClients.add(socket);
      socket.on('close', () => wsClients.delete(socket));
    });
  });

  // SPA fallback — serve index.html for non-API, non-file routes
  fastify.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith('/api/')) {
      return reply.code(404).send({ error: 'Not found' });
    }
    return reply.sendFile('index.html');
  });
}

// ---------- Market Data ----------
const PYTHON_ENGINE_URL = process.env.PYTHON_ENGINE_URL || 'http://127.0.0.1:5100';
const { symbols: trackedSymbolsConfig } = require('./config/symbols');
const CANDLE_SYMBOLS = trackedSymbolsConfig.map(s => s.symbol);
const BINANCE_MAP = { 'BTC/USDT': 'BTCUSDT', 'ETH/USDT': 'ETHUSDT', 'SOL/USDT': 'SOLUSDT' };
const COINGECKO_MAP = { 'BTC/USDT': 'bitcoin', 'ETH/USDT': 'ethereum', 'SOL/USDT': 'solana' };

// Cached CoinGecko prices (fetched in batch, shared across symbols)
let coingeckoCache = { prices: {}, fetchedAt: 0 };

async function fetchCoinGeckoPrices() {
  if (Date.now() - coingeckoCache.fetchedAt < 20_000) return coingeckoCache.prices;
  try {
    const res = await fetch(
      'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum,solana&vs_currencies=usd&include_24hr_change=true',
      { signal: AbortSignal.timeout(8000) }
    );
    if (res.ok) {
      const data = await res.json();
      coingeckoCache = { prices: data, fetchedAt: Date.now() };
      console.log('[PRICE] CoinGecko fetch OK');
      return data;
    }
  } catch (err) {
    console.error('[PRICE] CoinGecko failed:', err.message);
  }
  return coingeckoCache.prices;
}

async function fetchLivePrice(symbol) {
  const dashSym = symbol.replace('/', '-');

  // 1. Try Python engine
  try {
    const res = await fetch(`${PYTHON_ENGINE_URL}/price/${dashSym}`, { signal: AbortSignal.timeout(3000) });
    if (res.ok) {
      const data = await res.json();
      if (data.price) return { dashSym, price: data.price, source: 'engine' };
    }
  } catch (err) {
    logger.debug('Python engine price unavailable', { err, symbol, error_type: 'price_fallback' });
  }

  // 2. Try CoinGecko (skip Binance — geo-blocked on Railway)
  try {
    const cgId = COINGECKO_MAP[symbol];
    if (cgId) {
      const cgData = await fetchCoinGeckoPrices();
      if (cgData[cgId]?.usd) {
        return { dashSym, price: cgData[cgId].usd, change24h: cgData[cgId].usd_24h_change, source: 'coingecko' };
      }
    }
  } catch (err) {
    logger.debug('CoinGecko price unavailable', { err, symbol, error_type: 'price_fallback' });
  }

  // 3. Latest DB candle
  try {
    const { queryOne: qo } = require('./db/connection');
    const row = await qo(`SELECT close FROM market_data WHERE symbol = $1 ORDER BY timestamp DESC LIMIT 1`, [symbol]);
    if (row?.close) return { dashSym, price: parseFloat(row.close), source: 'db' };
  } catch (err) {
    logger.debug('DB candle fallback failed', { err, symbol, error_type: 'price_fallback' });
  }

  return null;
}

/**
 * Node.js fallback for stop-loss enforcement when Python engine is unreachable.
 * Uses the same fetchLivePrice() chain (Python → CoinGecko → DB candle).
 */
async function checkStopLossesFallback() {
  const tradesDb = require('./db/queries/trades');
  const openTrades = await tradesDb.getOpen();
  const closed = [];

  for (const trade of openTrades) {
    const sl = parseFloat(trade.sl_price);
    const tp = parseFloat(trade.tp_price);
    if (!sl && !tp) continue;

    const priceData = await fetchLivePrice(trade.symbol);
    if (!priceData?.price) {
      console.warn(`[FALLBACK] Could not fetch price for ${trade.symbol} — skipping trade #${trade.id}`);
      continue;
    }

    const currentPrice = priceData.price;
    const entry = parseFloat(trade.actual_fill_price || trade.entry_price);
    const qty = parseFloat(trade.quantity);
    let action = null;

    if (trade.side === 'buy') {
      if (tp && currentPrice >= tp) action = 'tp_hit';
      else if (sl && currentPrice <= sl) action = 'sl_hit';
    } else {
      if (tp && currentPrice <= tp) action = 'tp_hit';
      else if (sl && currentPrice >= sl) action = 'sl_hit';
    }

    if (action) {
      // Use atomic close with SELECT FOR UPDATE to prevent race with position review
      const result = await tradesDb.closeTradeAtomic(
        trade.id,
        async () => {
          const pnl = trade.side === 'buy'
            ? (currentPrice - entry) * qty
            : (entry - currentPrice) * qty;
          const pnlPct = trade.side === 'buy'
            ? ((currentPrice - entry) / entry) * 100
            : ((entry - currentPrice) / entry) * 100;
          return {
            exit_price: currentPrice,
            pnl: Math.round(pnl * 10000) / 10000,
            pnlPct: Math.round(pnlPct * 10000) / 10000,
          };
        },
        {
          outcome_reasoning: `Node.js fallback: ${action} @ ${currentPrice} (source: ${priceData.source})`,
          close_reason: action,
        }
      );

      if (result) {
        console.log(`[FALLBACK] ${action} — trade #${trade.id} ${trade.symbol} ${trade.side} closed @ ${currentPrice} (P&L: ${result.pnl_pct}%)`);
        closed.push({ trade_id: trade.id, action, exit_price: currentPrice, pnl_pct: result.pnl_pct });
      } else {
        console.log(`[FALLBACK] Trade #${trade.id} already closed — skipping`);
      }
    }
  }

  return closed;
}

async function refreshCandles({ backfill = false } = {}) {
  for (const symbol of CANDLE_SYMBOLS) {
    for (const tf of ['5m', '1h', '4h']) {
      try {
        // On boot/backfill fetch 200 candles for 5m (covers ~16h), otherwise just 10 for incremental
        const limit = backfill ? 200 : 10;
        const res = await fetch(`${PYTHON_ENGINE_URL}/fetch-ohlcv`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ symbol, timeframe: tf, limit }),
        });
        const data = await res.json();
        if (data.error) throw new Error(data.error);
      } catch (err) {
        console.error(`[CANDLES] ${symbol} ${tf}:`, err.message);
      }
    }
  }
}

// ---------- Cron ----------
const cron = require('node-cron');

function setupCron() {
  const orchestrator = require('./systems/grid/agents/orchestrator');
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
        status:            'healthy',
        last_cycle_at:     new Date(cycleStart),
        next_cycle_at:     new Date(cycleStart + 4 * 60 * 60 * 1000),
        cycle_duration_ms: Date.now() - cycleStart,
        agents_succeeded:  result?.agentsRun || null,
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

  // Stop loss / take profit enforcement — every minute
  let slCheckRunning = false;
  cron.schedule('* * * * *', async () => {
    if (slCheckRunning) return; // skip if previous check still running
    slCheckRunning = true;
    try {
      const result = await orchestrator.monitorPositions();
      const closed = (result?.results || []).filter(r => r.action === 'sl_hit' || r.action === 'tp_hit');
      if (closed.length > 0) {
        console.log(`[CRON] ${closed.length} position(s) closed by Python monitor`);
        broadcast('positions_closed', { closed });
      }
    } catch (err) {
      console.error('[CRON] Python position monitor failed:', err.message);
      console.log('[CRON] Running Node.js stop-loss fallback...');
      try {
        const closed = await checkStopLossesFallback();
        if (closed.length > 0) {
          console.log(`[CRON] ${closed.length} position(s) closed by Node.js fallback`);
          broadcast('positions_closed', { closed });
        }
      } catch (fallbackErr) {
        console.error('[CRON] Node.js stop-loss fallback also failed:', fallbackErr.message);
      }
    } finally {
      slCheckRunning = false;
    }
  });

  // Check standing order triggers every 15 minutes
  // M-14: Skip if a cycle is actively running to prevent race conditions
  cron.schedule('*/15 * * * *', async () => {
    if (orchestrator.isCycleRunning()) {
      console.log('[CRON] Skipping standing order check — cycle in progress');
      return;
    }
    console.log('[CRON] Monitoring standing orders...');
    try {
      // Expire old standing orders (runs even when cycle isn't active)
      const expired = await standingOrdersDb.expireOld();
      if (expired.rowCount > 0) console.log(`[CRON] Expired ${expired.rowCount} standing orders`);
      // Retry orders that failed due to transient errors (15-min cooldown)
      await standingOrdersDb.retryPending();
      await orchestrator.checkStandingOrders(broadcast);
    } catch (err) {
      console.error('[CRON] Standing order check failed:', err.message);
    }
  });

  // Clean expired signals + intelligence bus every hour
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
  });

  // ── GRID: weekly performance digest — every Monday at 06:00 ──────────────────
  // Runs BEFORE ORACLE's Monday cycle so ORACLE has fresh data immediately
  const { buildDigest } = require('./systems/grid/agents/performance-digest');
  cron.schedule('0 6 * * 1', async () => {
    console.log('[CRON] Building weekly performance digest...');
    try {
      await buildDigest();
    } catch (err) {
      console.error('[CRON] Digest build failed:', err.message);
    }
  });

  // Hourly position review (independent of 4h cycle, runs at :30)
  cron.schedule('30 * * * *', async () => {
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
  cron.schedule('*/30 * * * *', async () => {
    try { await fetchAll(); }
    catch (err) { console.error('[CRON] External data fetch failed:', err.message); }
  });

  // Fetch fresh candles every 5 minutes (keeps market_data current)
  cron.schedule('*/5 * * * *', async () => {
    try { await refreshCandles(); }
    catch (err) { console.error('[CRON] Candle refresh failed:', err.message); }
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

  // Correlation matrix recomputation every 6 hours
  cron.schedule('0 */6 * * *', async () => {
    console.log('[CRON] Recomputing correlation matrix...');
    try {
      const result = await computeCorrelations();
      broadcast('correlation_update', result);
      console.log(`[CRON] Correlations updated: ${JSON.stringify(result)}`);
    } catch (err) {
      console.error('[CRON] Correlation computation failed:', err.message);
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

  // Broadcast live prices every 10 seconds

  setInterval(async () => {
    for (const symbol of CANDLE_SYMBOLS) {
      try {
        const result = await fetchLivePrice(symbol);
        if (!result) continue;

        const old24h = await queryOneDb(
          `SELECT close FROM market_data WHERE symbol = $1 AND timestamp <= NOW() - interval '24 hours' ORDER BY timestamp DESC LIMIT 1`,
          [symbol]
        );
        const oldPrice = old24h ? parseFloat(old24h.close) : null;
        const change24h = oldPrice && oldPrice > 0 ? ((result.price - oldPrice) / oldPrice) * 100 : null;
        broadcast('price_update', { symbol: result.dashSym, price: result.price, change24h });
      } catch (err) {
        console.error(`[PRICE] ${symbol} broadcast failed:`, err.message);
      }
    }
  }, 10_000);

  // --- COMPASS cron ---
  // COMPASS cycle — runs at :15 past 1,7,13,19 (45min after ORACLE finishes)
  cron.schedule('15 1,7,13,19 * * *', async () => {
    console.log('[CRON] Starting COMPASS cycle...');
    try {
      const compassOrchestrator = require('./systems/compass/agents/orchestrator');
      await compassOrchestrator.runCycle({ broadcast });
    } catch (err) {
      console.error('[CRON] COMPASS cycle failed:', err.message);
    }
  });

  // --- ORACLE cron ---
  const { runIngestion } = require('./systems/oracle/ingestion/orchestrator');

  // ORACLE ingestion — runs at :00 of 0,6,12,18 (30 min BEFORE agent cycle)
  cron.schedule('0 0,6,12,18 * * *', async () => {
    console.log('[CRON] Starting ORACLE ingestion...');
    try {
      await runIngestion();
    } catch (err) {
      console.error('[CRON] ORACLE ingestion failed:', err.message);
    }
  });

  // ORACLE agent cycle — runs at :30 of 0,6,12,18 (after ingestion)
  cron.schedule('30 0,6,12,18 * * *', async () => {
    console.log('[CRON] Starting ORACLE cycle...');
    try {
      const oracleOrchestrator = require('./systems/oracle/agents/orchestrator');
      await oracleOrchestrator.runCycle({ broadcast });
    } catch (err) {
      console.error('[CRON] ORACLE cycle failed:', err.message);
    }
  });

  // ORACLE: Graveyard Auditor — every Tuesday at 07:00
  // Runs after Monday's digest (06:00) so trade outcomes are fresh
  cron.schedule('0 7 * * 2', async () => {
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
    const orchestrator = require('./systems/grid/agents/orchestrator');
    setTimeout(() => {
      console.log('[BOOT] Firing one-time cycle 10s after startup...');
      orchestrator.runCycle({ broadcast }).catch(err => {
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
