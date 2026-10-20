/**
 * Agent Orchestrator — runs the 3-layer agent execution pipeline.
 * Layer 1: Knowledge agents (parallel) — emit signals
 * Layer 2: Strategy agents (sequential) — Regime → Synthesizer → Risk Manager → Execute
 * Layer 3: Analysis agents (periodic) — Phase 4
 */

const http = require('http');
const crypto = require('crypto');
const decisionsDb = require('../../../db/queries/decisions');
const costsDb = require('../../../db/queries/costs');
const signalsDb = require('../../../db/queries/signals');
const portfolioDb = require('../../../db/queries/portfolio');
const standingOrdersDb = require('../../../db/queries/standing-orders');
const indicatorCacheDb = require('../../../db/queries/indicator-cache');
const equityDb = require('../../../db/queries/equity');
const cycleReportsDb = require('../../../db/queries/cycle-reports');
const positionReviewsDb = require('../../../db/queries/position-reviews');
const marketDataDb = require('../../../db/queries/market-data');
const { queryOne: dbQueryOne, queryAll: dbQueryAll, query: dbQuery, pool: dbPool } = require('../../../db/connection');
const { notifications } = require('../../../services/notifications');
const logger = require('../../../services/logger');
const { symbols: trackedSymbols, timeframes } = require('../../../config/symbols');
const { getRiskLimits, BOOTSTRAP, isManualScram, scramCloseMode } = require('../config/risk-limits');
const { normalizeDirection, toFiniteNumber } = require('./risk-enforcement');
const { linkTradeToTheses } = require('../../../shared/thesis-linker');

// Knowledge agents (8 total — all run in parallel)
const TrendAgent = require('./knowledge/trend');
const MomentumAgent = require('./knowledge/momentum');
const VolatilityAgent = require('./knowledge/volatility');
const VolumeAgent = require('./knowledge/volume');
const PatternAgent = require('./knowledge/pattern');
const OrderflowAgent = require('./knowledge/orderflow');
const MacroAgent = require('./knowledge/macro');
const SentimentAgent = require('./knowledge/sentiment');

// Strategy agents
const RegimeClassifierAgent = require('./strategy/regime-classifier');
const SynthesizerAgent = require('./strategy/synthesizer');
const RiskManagerAgent = require('./strategy/risk-manager');

// Analysis agents
const PerformanceAnalystAgent = require('./analysis/performance-analyst');
const PatternDiscoveryAgent = require('./analysis/pattern-discovery');

const knowledgeAgents = [
  new TrendAgent(),
  new MomentumAgent(),
  new VolatilityAgent(),
  new VolumeAgent(),
  new PatternAgent(),
  new OrderflowAgent(),
  new MacroAgent(),
  new SentimentAgent(),
];

const regimeClassifier = new RegimeClassifierAgent();
const synthesizer = new SynthesizerAgent();
const riskManager = new RiskManagerAgent();

const performanceAnalyst = new PerformanceAnalystAgent();
const patternDiscovery = new PatternDiscoveryAgent();

const tradesDb = require('../../../db/queries/trades');

const PYTHON_ENGINE_TIMEOUT_MS = 30000; // 30s timeout for Python engine calls

function engineBaseUrl() {
  return process.env.PYTHON_ENGINE_URL || 'http://127.0.0.1:5100';
}

/** Headers for every call to the Python engine (X-Engine-Key enforced by the engine when it is set). */
function engineHeaders(extra = {}) {
  const headers = { ...extra };
  if (process.env.ENGINE_API_KEY) headers['X-Engine-Key'] = process.env.ENGINE_API_KEY;
  return headers;
}

/** 'live' only when LIVE_TRADING_ENABLED=true — sent explicitly on every execute-trade. */
function engineMode() {
  return process.env.LIVE_TRADING_ENABLED === 'true' ? 'live' : 'paper';
}

/**
 * JSON request to the Python engine. Timeouts reject with err.isTimeout = true so callers can
 * tell "outcome unknown" apart from a clean failure. Engine `{error}` bodies reject unless
 * rejectOnError is false.
 */
function engineRequest(method, path, body = null, { rejectOnError = true, timeoutMs = PYTHON_ENGINE_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const postData = body == null ? null : JSON.stringify(body);
    const url = new URL(`${engineBaseUrl()}${path}`);
    const headers = engineHeaders(postData == null ? {} : {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(postData),
    });
    const req = http.request({
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method,
      headers,
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (rejectOnError && parsed.error) reject(new Error(parsed.error));
          else resolve(parsed);
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => {
      const err = new Error(`Python engine timeout (${Math.round(timeoutMs / 1000)}s)`);
      err.isTimeout = true;
      req.destroy(err);
    });
    if (postData != null) req.write(postData);
    req.end();
  });
}

/** Fetch a price from the engine with the shared auth header; null when unavailable. */
async function fetchEnginePrice(symbol, timeoutMs = 3000) {
  try {
    const res = await fetch(`${engineBaseUrl()}/price/${symbol.replace('/', '-')}`, {
      headers: engineHeaders(),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.ok) {
      const price = parseFloat((await res.json()).price);
      if (Number.isFinite(price) && price > 0) return price;
    }
  } catch (err) {
    logger.debug('Live price unavailable', { err, symbol, error_type: 'price_fallback' });
  }
  return null;
}

/**
 * Detect system operating mode: BOOTSTRAP or LEARNED.
 * BOOTSTRAP: <50 closed trades or <5 active learnings — Synthesizer must generate trade volume.
 * LEARNED: sufficient data exists for full confidence-based trading.
 */
async function getSystemMode() {
  const tradeCount = await dbQueryOne(
    'SELECT COUNT(*) as count FROM trades WHERE status = $1',
    ['closed']
  );
  const activeLearnings = await dbQueryOne(
    'SELECT COUNT(*) as count FROM learnings WHERE stage = $1',
    ['active']
  );

  const trades = parseInt(tradeCount.count);
  const active = parseInt(activeLearnings.count);

  if (trades < 50 || active < 5) return { mode: 'BOOTSTRAP', trades, active };
  return { mode: 'LEARNED', trades, active };
}

/**
 * Map cumulative closed trade count to the correct bootstrap phase.
 * INFANT:    0–99
 * LEARNING:  100–299
 * MATURING:  300–999
 * GRADUATED: 1000+
 */
function getPhaseForTradeCount(count) {
  if (count >= 1000) return 'graduated';
  if (count >= 300)  return 'maturing';
  if (count >= 100)  return 'learning';
  return 'infant';
}

/**
 * Check the persisted bootstrap phase against the actual closed trade count.
 * If the phase has advanced, INSERT a new bootstrap_status row (preserving history)
 * and log the transition clearly.
 * Safe to call repeatedly — no-ops when phase is already correct.
 */
async function checkAndPromoteBootstrapPhase() {
  try {
    const countRow = await dbQueryOne(
      "SELECT COUNT(*) as count FROM trades WHERE status = 'closed'"
    );
    const closedCount = parseInt(countRow?.count || '0');
    const correctPhase = getPhaseForTradeCount(closedCount);

    const currentRow = await dbQueryOne(
      'SELECT phase FROM bootstrap_status ORDER BY id DESC LIMIT 1'
    );
    const currentPhase = currentRow?.phase || 'infant';

    if (currentPhase !== correctPhase) {
      await dbQuery(
        `INSERT INTO bootstrap_status (phase, total_closed_trades, entered_at)
         VALUES ($1, $2, NOW())`,
        [correctPhase, closedCount]
      );
      console.log(`[BOOTSTRAP] Phase promoted: ${currentPhase.toUpperCase()} → ${correctPhase.toUpperCase()} (${closedCount} trades)`);
    }
  } catch (err) {
    console.error('[BOOTSTRAP] Phase promotion check failed:', err.message);
  }
}

let cycleNumber = null;
let cycleRunning = false;
let cycleStartedAt = null;
let currentCycle = null; // { id, cancelled, stats, releaseLock } — the cycle that currently owns the mutex
const CYCLE_ADVISORY_LOCK_KEY = 7340011; // pg_try_advisory_lock key for runCycle (cross-process guard)

/**
 * Take the cross-process advisory lock for a cycle. The lock is session-level, so it is held on a
 * dedicated pool client until released. Returns { release } or null when another process holds it.
 * Throws if the database cannot be reached.
 */
async function acquireCycleLock() {
  const client = await dbPool.connect();
  try {
    const { rows } = await client.query('SELECT pg_try_advisory_lock($1) AS locked', [CYCLE_ADVISORY_LOCK_KEY]);
    if (!rows[0]?.locked) {
      client.release();
      return null;
    }
  } catch (err) {
    client.release(err);
    throw err;
  }
  let released = false;
  return {
    release: async () => {
      if (released) return;
      released = true;
      try {
        await client.query('SELECT pg_advisory_unlock($1)', [CYCLE_ADVISORY_LOCK_KEY]);
        client.release();
      } catch (err) {
        console.warn('[ORCHESTRATOR] Advisory unlock failed (connection discarded):', err.message);
        client.release(err); // destroying the connection drops the session lock
      }
    },
  };
}

function recordAgentOutcome(cycle, ok) {
  if (!cycle) return;
  cycle.stats.run++;
  if (ok) cycle.stats.ok++; else cycle.stats.failed++;
}

function abortedResult(cycle, extra = {}) {
  return {
    ...extra,
    aborted: true,
    agentsRun: cycle?.stats.run || 0,
    agentsSucceeded: cycle?.stats.ok || 0,
    agentsFailed: cycle?.stats.failed || 0,
  };
}
const MAX_CYCLE_DURATION_MS = 15 * 60 * 1000; // 15 minute timeout (was 60min — too long, caused stale locks)
const ANALYSIS_EVERY_N_CYCLES = 6; // Run analysis every 6 cycles (every 24h at 4h intervals)
const ANALYSIS_INFANT_EVERY_N = 1;  // Run every cycle during INFANT phase for maximum learning

/**
 * Fetch indicators from Python engine for a symbol.
 */
async function fetchIndicators(symbol, timeframe = '4h') {
  const urlSymbol = symbol.replace('/', '-');
  const parsed = await engineRequest('GET', `/indicators/${urlSymbol}?timeframe=${encodeURIComponent(timeframe)}`);
  return parsed.indicators || parsed;
}

/**
 * Fetch OHLCV data from Python engine.
 */
function fetchOHLCV(symbol, timeframe = '4h', limit = 200) {
  return engineRequest('POST', '/fetch-ohlcv', { symbol, timeframe, limit });
}

/**
 * Execute approved trade via Python engine.
 */
function executeTrade(tradeData) {
  return engineRequest('POST', '/execute-trade', tradeData);
}

/** New idempotency key — one per trade ATTEMPT (standing orders derive a stable one, see below). */
function newClientOrderId() {
  return crypto.randomUUID();
}

/** Stable UUID derived from a seed, so every retry of the same standing order dedupes in the engine. */
function deterministicClientOrderId(seed) {
  const h = crypto.createHash('sha1').update(String(seed)).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/**
 * Execute a trade with an idempotency key and an explicit mode.
 *  - sends mode ('live' | 'paper', from LIVE_TRADING_ENABLED) and client_order_id (engine dedupes on it)
 *  - on TIMEOUT the outcome is unknown: look the trade up by client_order_id. If found, return it
 *    (flag recovered_after_timeout). If not found, rethrow with err.confirmedAbsent = true;
 *    if the lookup itself fails, err.confirmedAbsent = false (unknown — caller must NOT retry live).
 */
async function executeTradeIdempotent(tradeData) {
  const data = {
    ...tradeData,
    mode: engineMode(), // never trust a caller-supplied mode
    client_order_id: tradeData.client_order_id || newClientOrderId(),
  };
  try {
    return await executeTrade(data);
  } catch (err) {
    if (!err.isTimeout) throw err;
    console.error(`[ORCHESTRATOR] execute-trade timed out for ${data.symbol} (client_order_id ${data.client_order_id}) — checking whether it was placed`);
    try {
      const existing = await dbQueryOne('SELECT * FROM trades WHERE client_order_id = $1', [data.client_order_id]);
      if (existing) {
        console.warn(`[ORCHESTRATOR] Trade #${existing.id} exists for client_order_id ${data.client_order_id} — treating timeout as success`);
        return {
          trade_id: existing.id,
          fill_price: existing.actual_fill_price ?? existing.entry_price,
          recovered_after_timeout: true,
        };
      }
      err.confirmedAbsent = true;
    } catch (lookupErr) {
      err.confirmedAbsent = false;
      console.error('[ORCHESTRATOR] client_order_id lookup failed after timeout:', lookupErr.message);
    }
    err.client_order_id = data.client_order_id;
    throw err;
  }
}

/** Amend the exchange SL/TP orders for a live trade via the engine. Throws on any failure. */
function amendEngineStops(tradeId, { sl_price, tp_price }) {
  return engineRequest('POST', '/amend-stops', { trade_id: tradeId, sl_price: sl_price ?? null, tp_price: tp_price ?? null });
}

/**
 * Monitor open positions — check TP/SL via Python engine.
 */
function monitorPositions() {
  return engineRequest('POST', '/monitor-positions', {}, { rejectOnError: false });
}

/**
 * Check active standing orders against current prices. Trigger + execute as paper trades.
 */
async function checkStandingOrders(broadcast) {
  // 1. Fetch active, non-expired standing orders
  let orders;
  try {
    orders = await standingOrdersDb.fetchActive();
  } catch (err) {
    console.error('[MONITOR] Failed to fetch standing orders:', err.message);
    return [];
  }

  if (orders.length === 0) return [];

  console.log(`[MONITOR] Checking ${orders.length} active standing order(s)...`);
  const triggered = [];

  for (const order of orders) {
    // 2. Get current price — prefer live exchange price, fall back to DB candle close
    let currentPrice = await fetchEnginePrice(order.symbol, 10000);

    if (!currentPrice) {
      try {
        const row = await marketDataDb.getLatestClose(order.symbol);
        if (!row) continue;
        currentPrice = parseFloat(row.close);
      } catch (err) {
        console.warn(`[MONITOR] Could not get price for ${order.symbol}:`, err.message);
        continue;
      }
    }

    // 3. Check trigger conditions
    const cond = typeof order.conditions === 'string' ? JSON.parse(order.conditions) : (order.conditions || {});
    let shouldTrigger = false;

    if (cond.price_above != null && cond.price_below != null) {
      // Range condition: price must be WITHIN [price_above, price_below]
      shouldTrigger = currentPrice >= cond.price_above && currentPrice <= cond.price_below;
    } else if (cond.price_below != null) {
      // Single lower boundary: trigger when price drops to or below
      shouldTrigger = currentPrice <= cond.price_below;
    } else if (cond.price_above != null) {
      // Single upper boundary: trigger when price rises to or above
      shouldTrigger = currentPrice >= cond.price_above;
    }

    if (!shouldTrigger) continue;

    // 4. Trigger: atomically claim the order to prevent duplicate execution
    try {
      // Atomic claim: only succeeds if status is still 'active' (prevents concurrent triggers)
      const claimed = await standingOrdersDb.claimOrder(order.id);
      if (claimed.rowCount === 0) {
        console.log(`[MONITOR] Standing order #${order.id} already claimed by another process — skipping`);
        continue;
      }

      // Position deduplication: skip if symbol already has an open trade
      const existingOpen = await dbQueryOne(
        "SELECT id FROM trades WHERE symbol = $1 AND status IN ('open', 'close_failed') LIMIT 1",
        [order.symbol]
      );
      if (existingOpen) {
        console.log(`[MONITOR] Skipping standing order #${order.id} — open trade #${existingOpen.id} on ${order.symbol} already exists`);
        await standingOrdersDb.markFailed(order.id, 'duplicate_position')
          .catch(() => standingOrdersDb.revertToActive(order.id)
            .catch(revertErr => logger.error('Failed to fail/revert standing order', { err: revertErr, error_type: 'standing_order', symbol: order.symbol })));
        continue;
      }

      // Parse execution params for TP/SL / size
      const exec = typeof order.execution_params === 'string' ? JSON.parse(order.execution_params) : (order.execution_params || {});

      // --- Hard-limit pre-flight: the SAME gate the risk manager uses (SCRAM, drawdown with
      // reset-aware HWM, rolling-24h daily loss incl. unrealised, real size + real pair
      // correlations, event blackout, max positions, mandatory stop-loss, signed R:R).
      // Fails CLOSED: any DB/check error rejects with 'risk_check_unavailable'.
      const verdict = await RiskManagerAgent.checkEntry({
        symbol: order.symbol,
        direction: order.side === 'sell' ? 'short' : 'long',
        confidence: order.confidence,
        entry_price: currentPrice,
        sl_price: exec.stop_loss,
        tp_price: exec.take_profit,
        approved_size_pct: exec.position_size_pct || 1.0,
        asset_class: order.asset_class || 'crypto',
      });

      if (!verdict.ok) {
        const reason = verdict.reasons.join('; ');
        console.log(`[MONITOR] Standing order #${order.id} rejected by risk pre-flight: ${reason}`);
        if (reason.includes('risk_check_unavailable')) {
          // Infrastructure problem, not a verdict on the order — release the claim so the
          // next monitor tick re-evaluates it (nothing was executed).
          await standingOrdersDb.revertToActive(order.id)
            .catch(revertErr => logger.error('Failed to revert standing order to active', { err: revertErr, error_type: 'standing_order', symbol: order.symbol }));
        } else {
          await standingOrdersDb.markFailed(order.id, reason.slice(0, 200))
            .catch(() => standingOrdersDb.revertToActive(order.id)
              .catch(revertErr => logger.error('Failed to fail/revert standing order', { err: revertErr, error_type: 'standing_order', symbol: order.symbol })));
        }
        continue;
      }
      const approvedOrder = verdict.proposal;

      // Mark risk validated NOW (after passing all checks)
      await dbQuery('UPDATE standing_orders SET risk_validated_at = NOW() WHERE id = $1', [order.id])
        .catch(e => logger.warn('Failed to stamp risk_validated_at', { err: e, error_type: 'standing_order', symbol: order.symbol }));

      // Execute via Python engine. client_order_id is stable per standing order so any retry
      // (including after a timeout) dedupes in the engine instead of double-filling.
      const tradeResult = await executeTradeIdempotent({
        symbol: order.symbol,
        side: order.side,
        quantity: await calculateQuantity({
          approved_size_pct: approvedOrder.approved_size_pct,
          entry_price: currentPrice,
        }),
        entry_price: currentPrice,
        tp_price: approvedOrder.tp_price,
        sl_price: approvedOrder.sl_price,
        confidence: order.confidence,
        agent_decision_id: order.agent_decision_id,
        reasoning: `Standing order #${order.id} triggered at $${currentPrice}`,
        asset_class: order.asset_class || 'crypto',
        exchange: 'kucoin',
        client_order_id: deterministicClientOrderId(`standing_order:${order.id}`),
      });

      // Link trade back to standing order
      await standingOrdersDb.linkTrade(order.id, tradeResult.trade_id);

      const triggerPrice = cond.price_below || cond.price_above || currentPrice;
      console.log(`[MONITOR] Standing order triggered: ${order.symbol} ${order.side} @ ${triggerPrice}`);

      if (broadcast) {
        broadcast('standing_order_triggered', {
          order_id: order.id,
          symbol: order.symbol,
          side: order.side,
          trigger_price: triggerPrice,
          fill_price: tradeResult.fill_price,
          trade_id: tradeResult.trade_id,
        });
      }

      triggered.push({ order_id: order.id, trade_id: tradeResult.trade_id, symbol: order.symbol });
    } catch (err) {
      console.error(`[MONITOR] Failed to execute standing order #${order.id} for ${order.symbol}:`, err.message);
      // Determine if failure is transient (network) or permanent.
      // A TIMEOUT on a LIVE order means the outcome is unknown: it is only retryable when the
      // trade was confirmed absent by client_order_id (the retry reuses the same key, so the
      // engine dedupes even if the first attempt lands late). Paper timeouts stay transient.
      // (ECONNRESET can happen after the request was sent, so it is only transient in paper mode)
      let isTransient = err.message.includes('ECONNREFUSED') || (engineMode() !== 'live' && err.message.includes('ECONNRESET'));
      if (err.isTimeout || err.message.includes('timeout')) {
        isTransient = engineMode() === 'live' ? err.confirmedAbsent === true : true;
      }
      if (isTransient) {
        // Transient failure: mark as pending_retry (auto-retries after 15 min cooldown)
        await standingOrdersDb.markPendingRetry(order.id, err.message.slice(0, 100))
          .catch(retryErr => logger.error('Failed to mark standing order pending_retry', { err: retryErr, error_type: 'standing_order', symbol: order.symbol }));
      } else {
        // Permanent failure: mark as failed (requires manual intervention)
        await standingOrdersDb.markFailed(order.id, err.message.slice(0, 100))
          .catch(failErr => logger.error('Failed to mark standing order as failed', { err: failErr, error_type: 'standing_order', symbol: order.symbol }));
      }
    }
  }

  if (triggered.length > 0) {
    console.log(`[MONITOR] ${triggered.length} standing order(s) triggered`);
  }

  return triggered;
}

// Freshness thresholds: data is stale if older than 2× the timeframe interval
const FRESHNESS_THRESHOLDS_MS = {
  '5m': 10 * 60 * 1000,
  '1h': 2 * 60 * 60 * 1000,
  '4h': 8 * 60 * 60 * 1000,
  '1d': 48 * 60 * 60 * 1000,
};

/**
 * Fetch fresh market data for all tracked symbols.
 * Returns { results, dataQuality, report } where report is a per-symbol/per-timeframe DataQualityReport.
 */
async function refreshMarketData() {
  console.log('[ORCHESTRATOR] Refreshing market data...');
  const results = [];
  const report = {}; // { symbol: { timeframe: { fetched, latestTimestamp, ageMinutes, ok } } }
  let freshCount = 0;
  let staleCount = 0;
  let failedCount = 0;

  for (const { symbol } of trackedSymbols) {
    report[symbol] = {};
    for (const tf of timeframes) {
      try {
        const result = await fetchOHLCV(symbol, tf, 200);
        results.push({ symbol, timeframe: tf, ...result });

        if ((result.fetched || 0) > 0) {
          // Check actual freshness from DB
          let latestTimestamp = null;
          let ageMinutes = null;
          let ok = true;
          try {
            const latest = await dbQueryOne(
              'SELECT MAX(timestamp) as latest FROM market_data WHERE symbol = $1 AND timeframe = $2',
              [symbol, tf]
            );
            if (latest?.latest) {
              latestTimestamp = latest.latest;
              ageMinutes = Math.round((Date.now() - new Date(latestTimestamp).getTime()) / 60000);
              const threshold = FRESHNESS_THRESHOLDS_MS[tf] || FRESHNESS_THRESHOLDS_MS['4h'];
              ok = (Date.now() - new Date(latestTimestamp).getTime()) < threshold;
            }
          } catch (freshErr) {
            // DB freshness check failed — assume ok if fetch succeeded
            logger.debug('Market data freshness check failed', { err: freshErr, symbol, timeframe: tf, error_type: 'freshness_check' });
          }

          report[symbol][tf] = { fetched: result.fetched, latestTimestamp, ageMinutes, ok };
          if (ok) {
            freshCount++;
          } else {
            staleCount++;
            console.warn(`[DATA] ${symbol} ${tf}: data stale — ${ageMinutes}min old`);
          }
          console.log(`[DATA] ${symbol} ${tf}: ${result.stored || 0} candles stored`);
        } else {
          staleCount++;
          report[symbol][tf] = { fetched: 0, latestTimestamp: null, ageMinutes: null, ok: false };
          console.warn(`[DATA] ${symbol} ${tf}: exchange returned 0 candles — data may be stale`);
        }
      } catch (err) {
        failedCount++;
        report[symbol][tf] = { fetched: 0, latestTimestamp: null, ageMinutes: null, ok: false, error: err.message };
        console.error(`[DATA] ${symbol} ${tf} failed:`, err.message);
      }
    }
  }

  const totalAttempts = trackedSymbols.length * timeframes.length;
  const freshPct = totalAttempts > 0 ? Math.round((freshCount / totalAttempts) * 100) : 0;

  const dataQuality = {
    total: totalAttempts,
    fresh: freshCount,
    stale: staleCount,
    failed: failedCount,
    freshPct,
    status: freshPct >= 75 ? 'healthy' : freshPct >= 50 ? 'degraded' : 'critical',
  };

  console.log(`[ORCHESTRATOR] DataQualityReport: ${JSON.stringify(dataQuality)}`);

  if (failedCount === totalAttempts) {
    console.error(`[ORCHESTRATOR] CRITICAL: ALL ${totalAttempts} market data fetches failed — aborting recommended`);
  } else if (dataQuality.status === 'degraded') {
    console.warn(`[ORCHESTRATOR] DATA QUALITY DEGRADED: ${freshCount}/${totalAttempts} fresh (${freshPct}%)`);
  } else if (failedCount > 0 || staleCount > 0) {
    console.warn(`[ORCHESTRATOR] ${freshCount}/${totalAttempts} fresh, ${staleCount} stale, ${failedCount} failed`);
  }

  return { results, dataQuality, report };
}

/**
 * Get indicators for all tracked symbols.
 */
async function getIndicatorsForAll(timeframe = '4h') {
  const indicators = {};

  for (const { symbol } of trackedSymbols) {
    try {
      indicators[symbol] = await fetchIndicators(symbol, timeframe);
    } catch (err) {
      console.error(`[INDICATORS] ${symbol} failed:`, err.message);
      indicators[symbol] = null;
    }
  }

  return indicators;
}

/**
 * Indicator domain mappings — split flat indicator dict into domain-specific caches.
 */
const INDICATOR_DOMAINS = {
  trend: ['sma_20', 'sma_50', 'sma_200', 'ema_12', 'ema_26', 'adx', 'dmp', 'dmn'],
  momentum: ['rsi_14', 'macd', 'macd_signal', 'macd_histogram', 'stoch_k', 'stoch_d', 'cci', 'willr', 'roc'],
  volatility: ['bb_upper', 'bb_mid', 'bb_lower', 'bb_bandwidth', 'bb_pct', 'atr_14'],
  volume: ['obv', 'mfi', 'volume_sma_20', 'volume_ratio'],
};

/**
 * Cache indicators in external_data_cache, split by domain, so context builders can query them.
 */
async function cacheIndicators(indicators) {
  // Clean expired indicator cache entries
  try {
    await indicatorCacheDb.cleanExpired();
  } catch (err) {
    logger.debug('Indicator cache cleanup skipped', { err, error_type: 'cache_cleanup' });
  }

  for (const [symbol, data] of Object.entries(indicators)) {
    if (!data) continue;

    for (const [domain, keys] of Object.entries(INDICATOR_DOMAINS)) {
      const domainData = {};
      for (const key of keys) {
        if (data[key] !== undefined) domainData[key] = data[key];
      }
      // Also include current_price in every domain for convenience
      if (data.current_price !== undefined) domainData.current_price = data.current_price;

      if (Object.keys(domainData).length === 0) continue;

      try {
        await indicatorCacheDb.upsertDomain(domain, symbol, domainData);
      } catch (err) {
        console.error(`[CACHE] Failed to cache ${domain} indicators for ${symbol}:`, err.message);
      }
    }

    // Also cache a 'pattern' domain with all indicators (pattern agent needs everything)
    try {
      await indicatorCacheDb.upsertDomain('pattern', symbol, data);
    } catch (err) {
      console.error(`[CACHE] Failed to cache pattern indicators for ${symbol}:`, err.message);
    }
  }

  console.log(`[CACHE] Indicators cached for ${Object.keys(indicators).filter(s => indicators[s]).length} symbols`);
}

/**
 * Run all knowledge agents in parallel.
 */
async function runKnowledgeLayer(cycleNum, indicators, broadcast, dataQuality, bootstrapPhase = 'infant', cycle = null) {
  console.log(`[ORCHESTRATOR] Running knowledge layer (cycle ${cycleNum})...`);

  // Run in batches of 2 to stay within rate limits (30k input tokens/min)
  const BATCH_SIZE = 2;
  const allResults = [];
  // Agents not reached because the cycle was superseded/cancelled are reported as skipped
  let skippedFrom = knowledgeAgents.length;

  for (let i = 0; i < knowledgeAgents.length; i += BATCH_SIZE) {
    if (cycle?.cancelled) {
      console.warn(`[ORCHESTRATOR] Cycle ${cycleNum} cancelled — stopping knowledge layer before batch ${Math.floor(i / BATCH_SIZE) + 1}`);
      skippedFrom = i;
      break;
    }
    const batch = knowledgeAgents.slice(i, i + BATCH_SIZE);
    const batchResults = await Promise.allSettled(
      batch.map(agent => {
        const agentStart = Date.now();
        return agent.run({
          symbols: trackedSymbols,
          indicators,
          cycleNumber: cycleNum,
          bootstrapPhase,
          // Inject data quality so agents can adjust confidence when data is degraded
          ...(dataQuality?.status === 'degraded' ? { data_quality: 'degraded' } : {}),
        }).then(decision => {
          if (broadcast) {
            broadcast('agent_complete', {
              cycleNumber: cycleNum,
              agent_name: agent.name,
              layer: 'knowledge',
              signals_count: decision?.output_json?.signals?.length || 0,
              cost_usd: decision?.cost_usd || 0,
              duration_ms: Date.now() - agentStart,
            });
          }
          return decision;
        }).catch(err => {
          if (broadcast) {
            broadcast('agent_complete', {
              cycleNumber: cycleNum,
              agent_name: agent.name,
              layer: 'knowledge',
              error: err.message,
              duration_ms: Date.now() - agentStart,
            });
          }
          throw err;
        });
      })
    );
    allResults.push(...batchResults);

    // Wait 60s between batches to respect rate limits
    if (i + BATCH_SIZE < knowledgeAgents.length) {
      console.log(`[ORCHESTRATOR] Batch ${Math.floor(i / BATCH_SIZE) + 1} done, waiting 60s for rate limit...`);
      await new Promise(r => setTimeout(r, 60000));
    }
  }

  // BaseAgent.run() never rejects — it returns a decision with .error set on failure — so
  // 'fulfilled' alone does not mean success. An agent is OK only if fulfilled AND decision.error is empty.
  return allResults.slice(0, skippedFrom).map((r, i) => {
    const decision = r.status === 'fulfilled' ? r.value : null;
    const error = r.status === 'rejected'
      ? (r.reason?.message || String(r.reason))
      : (decision?.error || null);
    const ok = r.status === 'fulfilled' && !error;
    recordAgentOutcome(cycle, ok);
    return { agent: knowledgeAgents[i].name, status: r.status, decision, error, ok };
  });
}

/**
 * Run the strategy layer: Regime → Synthesizer → Risk Manager → Execute.
 */
async function runStrategyLayer(cycleNum, indicators, broadcast, quietMarket = false, systemMode = 'LEARNED', compassConstraints = null, cycle = null) {
  const cancelledResult = () => ({ regime: null, proposals: [], approved: [], rejected: [], trades: [], standing_orders: [], cancelled: true });
  console.log(`[ORCHESTRATOR] Running strategy layer (cycle ${cycleNum})${quietMarket ? ' [QUIET MARKET]' : ''}...`);

  // Step 1: Classify market regime
  console.log('[ORCHESTRATOR] → Regime Classifier');
  let regime = null;
  try {
    const regimeStart = Date.now();
    const regimeResult = await regimeClassifier.run({
      cycleNumber: cycleNum,
      indicators,
      broadcast,
    });
    recordAgentOutcome(cycle, !regimeResult?.error);
    const oj = regimeResult?.output_json || {};
    let regimeList = oj.regimes || [];
    // Handle flat output: { regime: "ranging", confidence: 62, ... }
    if (regimeList.length === 0 && oj.regime) {
      regimeList = [{ ...oj, asset_class: oj.asset_class || 'crypto' }];
    }
    regime = regimeList.reduce((acc, r) => {
      acc[r.asset_class || 'crypto'] = r;
      return acc;
    }, {}) || null;
    console.log(`[ORCHESTRATOR] Regime classified: ${JSON.stringify(Object.entries(regime || {}).map(([k, v]) => `${k}=${v.regime}`))}`);
    if (broadcast) {
      broadcast('agent_complete', {
        cycleNumber: cycleNum, agent_name: 'regime_classifier', layer: 'strategy',
        regime: oj.regime, confidence: oj.confidence,
        cost_usd: regimeResult?.cost_usd || 0, duration_ms: Date.now() - regimeStart,
      });
    }
  } catch (err) {
    recordAgentOutcome(cycle, false);
    console.error('[ORCHESTRATOR] Regime classifier failed:', err.message);
    if (broadcast) broadcast('agent_complete', { cycleNumber: cycleNum, agent_name: 'regime_classifier', layer: 'strategy', error: err.message });
  }

  // Step 1.5: Regime-flip detection — trigger immediate position review if direction reversed
  const BEARISH_REGIMES = ['trending_down'];
  const BULLISH_REGIMES = ['trending_up'];
  const newRegime = regime?.crypto?.regime;
  if (newRegime) {
    try {
      // Get the PREVIOUS regime (second most recent, since the new one was just stored)
      const prevRow = await dbQueryOne(`
        SELECT regime FROM market_regime ORDER BY created_at DESC LIMIT 1 OFFSET 1
      `);
      const prevRegime = prevRow?.regime;
      const flippedBearishToBullish = BEARISH_REGIMES.includes(prevRegime) && BULLISH_REGIMES.includes(newRegime);
      const flippedBullishToBearish = BULLISH_REGIMES.includes(prevRegime) && BEARISH_REGIMES.includes(newRegime);

      if (flippedBearishToBullish || flippedBullishToBearish) {
        console.log(`[ORCHESTRATOR] REGIME FLIP detected: ${prevRegime} → ${newRegime} — triggering immediate position review`);
        try {
          const flipReview = await reviewOpenPositions(cycleNum, broadcast);
          console.log(`[ORCHESTRATOR] Regime-flip position review: ${flipReview.reviews.length} reviewed — ${flipReview.actions.close || 0} closed`);
        } catch (reviewErr) {
          console.error('[ORCHESTRATOR] Regime-flip position review failed:', reviewErr.message);
        }
      }
    } catch (err) {
      console.warn('[ORCHESTRATOR] Regime-flip detection failed:', err.message);
    }
  }

  // Step 1.5b: Last trade check for forced exploration
  let hoursSinceLastTrade = null;
  let forcedExploration = false;
  try {
    const lastTrade = await dbQueryOne('SELECT opened_at FROM trades ORDER BY opened_at DESC LIMIT 1');
    if (lastTrade?.opened_at) {
      hoursSinceLastTrade = Math.round((Date.now() - new Date(lastTrade.opened_at).getTime()) / 3600000 * 10) / 10;
    }
    const isPaperMode = process.env.LIVE_TRADING_ENABLED !== 'true';
    if (isPaperMode && (hoursSinceLastTrade === null || hoursSinceLastTrade > 6)) {
      forcedExploration = true;
      console.log(`[ORCHESTRATOR] Forced exploration mode active — ${hoursSinceLastTrade !== null ? `no trades in ${hoursSinceLastTrade}h` : 'no trades ever'}`);
    }
  } catch (err) {
    console.warn('[ORCHESTRATOR] Last trade check failed:', err.message);
  }

  // H-8: Rate limit pacing — wait 15s between Regime Classifier and Synthesizer
  if (!forcedExploration) {
    console.log('[ORCHESTRATOR] Rate limit pacing — waiting 15s before Synthesizer');
    await new Promise(r => setTimeout(r, 15000));
  }

  if (cycle?.cancelled) { console.warn(`[ORCHESTRATOR] Cycle ${cycleNum} cancelled — skipping Synthesizer`); return cancelledResult(); }

  // Step 2: Synthesizer — match signals to templates, produce trade proposals
  console.log('[ORCHESTRATOR] → Synthesizer');
  let proposals = [];
  let synthDecision = null;
  let standingOrders = [];
  try {
    const synthStart = Date.now();
    synthDecision = await synthesizer.run({
      cycleNumber: cycleNum,
      regime,
      broadcast,
      hoursSinceLastTrade,
      forcedExploration,
      systemMode,
    });
    recordAgentOutcome(cycle, !synthDecision?.error);
    // [SYNTH_DEBUG] Log raw synthesizer output for diagnostics
    const outputJson = synthDecision?.output_json || {};
    const noActionReasons = outputJson.no_action_reasons || [];
    const marketAssessment = outputJson.market_assessment || null;
    console.log(`[SYNTH_DEBUG] Cycle ${cycleNum} | actions: ${(outputJson.actions || []).length} | standing_orders: ${(outputJson.standing_orders || []).length} | no_action_reasons: ${noActionReasons.length > 0 ? noActionReasons.map(r => typeof r === 'string' ? r : JSON.stringify(r)).join('; ') : 'none'} | market: ${marketAssessment ? JSON.stringify(marketAssessment).slice(0, 200) : 'N/A'}`);

    // Synthesizer outputs trade proposals in "actions" array (type: "trade_proposal")
    const rawActions = synthDecision?.output_json?.actions || [];
    const candidateProposals = rawActions
      .filter(a => a.type === 'trade_proposal')
      .map(a => ({
        ...a,
        // Normalize exit_plan fields to top-level for risk manager + executeTrade
        tp_price: a.exit_plan?.take_profit ?? a.tp_price,
        sl_price: a.exit_plan?.stop_loss ?? a.sl_price,
      }));

    // H-7: Validate required fields before passing to Risk Manager
    const REQUIRED_PROPOSAL_FIELDS = ['symbol', 'direction'];
    for (const p of candidateProposals) {
      const missing = REQUIRED_PROPOSAL_FIELDS.filter(f => !p[f]);
      // Also check for entry_price or trigger_price (standing orders use trigger)
      // Market orders don't require entry_price — it's resolved at execution time
      if (!p.entry_price && !p.trigger_price && p.entry_type !== 'market') missing.push('entry_price');
      if (!p.sl_price && !p.stop_loss) missing.push('stop_loss');
      if (!p.tp_price && !p.take_profit) missing.push('take_profit');
      if (missing.length === 0) {
        proposals.push(p);
      } else {
        console.warn(`[ORCHESTRATOR] Proposal rejected — missing fields: [${missing.join(', ')}]. Raw: ${JSON.stringify(p).slice(0, 200)}`);
      }
    }
    console.log(`[ORCHESTRATOR] Synthesizer produced ${proposals.length} valid proposals (from ${rawActions.length} actions, ${candidateProposals.length - proposals.length} rejected)`);

    // Persist standing orders to DB (dedup: skip if active order already exists for same symbol+side)
    standingOrders = synthDecision?.output_json?.standing_orders || [];
    if (standingOrders.length > 0) {
      const existingActive = await standingOrdersDb.fetchActive();
      const activeKeys = new Set(existingActive.map(o => `${o.symbol}:${o.side}`));
      let soStored = 0;
      for (const so of standingOrders) {
        try {
          const side = so.direction === 'long' ? 'buy' : 'sell';
          if (activeKeys.has(`${so.symbol}:${side}`)) {
            console.log(`[ORCHESTRATOR] Standing order skipped (active exists): ${so.symbol} ${side}`);
            continue;
          }
          const expiresHours = so.expires_in_hours || 24;
          await standingOrdersDb.createFromSynthesizer({
            agentName: 'strategySynthesizer',
            agentDecisionId: synthDecision?.id || null,
            symbol: so.symbol,
            side,
            conditions: so.trigger_conditions,
            executionParams: so.exit_plan,
            templateId: so.template_id || null,
            confidence: so.confidence,
            expiresHours,
          });
          const triggerPrice = so.trigger_conditions?.price_below || so.trigger_conditions?.price_above || so.entry_price || '—';
          console.log(`[ORCHESTRATOR] Standing order saved: ${so.symbol} ${side} @ ${triggerPrice}`);
          soStored++;
        } catch (soErr) {
          console.warn(`[ORCHESTRATOR] Failed to store standing order for ${so.symbol}:`, soErr.message);
        }
      }
      console.log(`[ORCHESTRATOR] Stored ${soStored}/${standingOrders.length} standing orders`);
    }

    if (broadcast) {
      broadcast('agent_complete', {
        cycleNumber: cycleNum, agent_name: 'synthesizer', layer: 'strategy',
        proposals: proposals.length,
        standing_orders: standingOrders.length,
        cost_usd: synthDecision?.cost_usd || 0, duration_ms: Date.now() - synthStart,
      });
    }
  } catch (err) {
    if (!synthDecision) recordAgentOutcome(cycle, false);
    console.error('[ORCHESTRATOR] Synthesizer failed:', err.message);
    if (broadcast) broadcast('agent_complete', { cycleNumber: cycleNum, agent_name: 'synthesizer', layer: 'strategy', error: err.message });
  }

  // Track learning influence — which learnings were in Synthesizer context this cycle
  // Include all pipeline stages: candidate, provisional, and active
  try {
    const activeLearnings = await dbQueryAll(`
      SELECT id, insight_text FROM learnings
      WHERE stage IN ('active', 'provisional', 'candidate') AND invalidated_at IS NULL
      ORDER BY decayed_confidence DESC NULLS LAST LIMIT 30
    `);
    if (activeLearnings.length > 0) {
      await trackLearningInfluence(cycleNum, synthDecision?.output_json || {}, activeLearnings, regime);
    }
  } catch (err) {
    console.error('[ORCHESTRATOR] Learning influence tracking failed:', err.message);
  }

  if (proposals.length === 0) {
    const reasons = synthDecision?.output_json?.no_action_reasons || [];
    console.log(`[SYNTH_DEBUG] 0 proposals — reasons: ${reasons.length > 0 ? reasons.join('; ') : 'none provided'} | regime: ${regime?.regime || 'unknown'} (${regime?.confidence || '?'}%) | standing_orders: ${standingOrders.length}`);
    console.log('[ORCHESTRATOR] No proposals to evaluate — strategy layer complete');
    return { regime, proposals: [], approved: [], rejected: [], trades: [], standing_orders: standingOrders };
  }

  // COMPASS reduce mode — keep only the highest-confidence proposal before Risk Manager
  if (compassConstraints?.maxPositions === 1 && proposals.length > 1) {
    proposals.sort((a, b) => (b.confidence || 0) - (a.confidence || 0));
    const droppedSymbols = proposals.splice(1).map(p => p.symbol).join(', ');
    console.log(`[COMPASS_GATE] Elevated risk: capped to 1 proposal (dropped: ${droppedSymbols})`);
  }

  // Resolve entry_price for market-order proposals BEFORE Risk Manager
  // so fee-adjusted R:R can be validated on every proposal (not just limit orders)
  for (const p of proposals) {
    if (!p.entry_price) {
      try {
        const row = await marketDataDb.getLatestClose(p.symbol);
        if (row?.close) {
          p.entry_price = parseFloat(row.close);
          console.log(`[ORCHESTRATOR] Pre-resolved entry_price for ${p.symbol}: ${p.entry_price}`);
        }
      } catch (err) {
        console.warn(`[ORCHESTRATOR] Could not resolve entry_price for ${p.symbol}:`, err.message);
      }
    }
  }

  // Step 3: Risk Manager — validate proposals against limits
  console.log(`[ORCHESTRATOR] Passing ${proposals.length} proposals to Risk Manager`);
  for (const p of proposals) {
    console.log(`[ORCHESTRATOR]   → ${p.symbol} ${p.direction} conf=${p.confidence} entry=${p.entry_price} sl=${p.sl_price} tp=${p.tp_price}`);
  }
  if (cycle?.cancelled) { console.warn(`[ORCHESTRATOR] Cycle ${cycleNum} cancelled — skipping Risk Manager`); return cancelledResult(); }
  console.log('[ORCHESTRATOR] → Risk Manager');
  let riskResult = { approved: [], rejected: [] };
  try {
    const riskStart = Date.now();
    const riskDecision = await riskManager.run({
      cycleNumber: cycleNum,
      proposals,
      broadcast,
    });
    recordAgentOutcome(cycle, !riskDecision?.decision?.error);
    // Risk Manager returns { approved, rejected, decision } — use directly
    riskResult = {
      approved: (riskDecision?.approved || []).map(t => ({
        ...t,
        tp_price: t.tp_price ?? t.exit_plan?.take_profit ?? t.take_profit,
        sl_price: t.sl_price ?? t.exit_plan?.stop_loss ?? t.stop_loss,
      })),
      rejected: riskDecision?.rejected || [],
    };
    // COMPASS reduce mode — halve approved_size_pct so positions are half-sized
    if (compassConstraints?.halveSizes && riskResult.approved.length > 0) {
      riskResult.approved = riskResult.approved.map(t => ({
        ...t,
        approved_size_pct: (t.approved_size_pct || 1.0) * 0.5,
      }));
      console.log(`[COMPASS_GATE] Elevated risk: position sizes halved for ${riskResult.approved.length} approved trade(s)`);
    }
    console.log(`[ORCHESTRATOR] Risk Manager: ${riskResult.approved.length} approved, ${riskResult.rejected.length} rejected`);
    if (broadcast) {
      broadcast('agent_complete', {
        cycleNumber: cycleNum, agent_name: 'risk_manager', layer: 'strategy',
        approved: riskResult.approved.length, rejected: riskResult.rejected.length,
        cost_usd: riskDecision?.cost_usd || 0, duration_ms: Date.now() - riskStart,
      });
    }
  } catch (err) {
    recordAgentOutcome(cycle, false);
    console.error('[ORCHESTRATOR] Risk Manager failed:', err.message);
    if (broadcast) broadcast('agent_complete', { cycleNumber: cycleNum, agent_name: 'risk_manager', layer: 'strategy', error: err.message });
  }

  // Step 4: Execute approved trades
  const trades = [];
  // Pre-check position limits
  const currentLimits = getRiskLimits();
  let maxPos = currentLimits.MAX_OPEN_POSITIONS;
  try {
    const bsRow = await dbQueryOne('SELECT phase FROM bootstrap_status ORDER BY id DESC LIMIT 1');
    if (bsRow?.phase && BOOTSTRAP[bsRow.phase]?.MAX_OPEN_POSITIONS != null) {
      maxPos = BOOTSTRAP[bsRow.phase].MAX_OPEN_POSITIONS;
    }
  } catch (bsErr) {
    // Fail closed on the stricter side: unknown phase -> infant limits
    console.error('[ORCHESTRATOR] Bootstrap phase read failed — using infant limits:', bsErr.message);
    if (BOOTSTRAP.infant?.MAX_OPEN_POSITIONS != null) maxPos = Math.min(maxPos, BOOTSTRAP.infant.MAX_OPEN_POSITIONS);
  }
  let currentOpenCount = parseInt((await dbQueryOne("SELECT COUNT(*)::int as cnt FROM trades WHERE status IN ('open', 'close_failed')"))?.cnt || 0);

  // Daily loss gate — rolling 24h incl. unrealised, % of the same equity used for sizing.
  // Fails closed: if it cannot be computed, no new trades this cycle.
  let dailyLossBreached = false;
  let dailyLossUnavailable = false;
  try {
    const dailyLossPct = await RiskManagerAgent.getRollingDailyLossPct();
    if (dailyLossPct >= currentLimits.MAX_DAILY_LOSS_PCT) {
      dailyLossBreached = true;
      console.warn(`[ORCHESTRATOR] DAILY LOSS LIMIT BREACHED: ${dailyLossPct.toFixed(1)}% (max ${currentLimits.MAX_DAILY_LOSS_PCT}%) — no new trades`);
    }
  } catch (err) {
    dailyLossUnavailable = true;
    console.error('[ORCHESTRATOR] Daily loss check failed — blocking new trades (fail closed):', err.message);
  }

  for (const trade of riskResult.approved) {
    if (cycle?.cancelled) {
      console.warn(`[ORCHESTRATOR] Cycle ${cycleNum} cancelled — not executing ${trade.symbol}`);
      break;
    }
    try {
      // Check daily loss limit
      if (dailyLossBreached || dailyLossUnavailable) {
        const why = dailyLossUnavailable ? 'risk_check_unavailable (daily_loss)' : `Daily loss limit breached (max ${currentLimits.MAX_DAILY_LOSS_PCT}%)`;
        console.log(`[ORCHESTRATOR] Skipping ${trade.symbol} — ${why}`);
        await dbQuery(`INSERT INTO rejected_opportunities (cycle_number, rejected_by, symbol, direction, confidence, rejection_reason, rejection_detail, created_at) VALUES ($1, 'code_enforced', $2, $3, $4, $5, $6, NOW())`,
          [cycleNum, trade.symbol, trade.direction, trade.confidence, dailyLossUnavailable ? 'risk_check_unavailable' : 'daily_loss_limit', why]);
        continue;
      }

      // Check MAX_OPEN_POSITIONS limit
      if (currentOpenCount >= maxPos) {
        console.log(`[ORCHESTRATOR] Skipping ${trade.symbol} — ${currentOpenCount} open positions (max ${maxPos})`);
        await dbQuery(`INSERT INTO rejected_opportunities (cycle_number, rejected_by, symbol, direction, confidence, rejection_reason, rejection_detail, created_at) VALUES ($1, 'code_enforced', $2, $3, $4, 'position_limit_reached', $5, NOW())`,
          [cycleNum, trade.symbol, trade.direction, trade.confidence, `max_positions_reached (${currentOpenCount}/${maxPos})`]);
        continue;
      }

      // Position deduplication: skip if symbol already has an open trade
      const existingOpen = await dbQueryOne(
        "SELECT id FROM trades WHERE symbol = $1 AND status IN ('open', 'close_failed') LIMIT 1",
        [trade.symbol]
      );
      if (existingOpen) {
        console.log(`[ORCHESTRATOR] Skipping ${trade.symbol} — open trade #${existingOpen.id} already exists`);
        await dbQuery(`INSERT INTO rejected_opportunities (cycle_number, rejected_by, symbol, direction, confidence, rejection_reason, rejection_detail, created_at) VALUES ($1, 'code_enforced', $2, $3, $4, 'duplicate_symbol_open', $5, NOW())`,
          [cycleNum, trade.symbol, trade.direction, trade.confidence, `open trade #${existingOpen.id} already exists`]);
        continue;
      }

      // M-17: Check correlated exposure
      try {
        const openSymbolTrades = await dbQueryOne(
          "SELECT COUNT(*)::int as cnt, COALESCE(SUM(quantity * entry_price), 0) as exposure FROM trades WHERE symbol = $1 AND status = 'open'",
          [trade.symbol]
        );
        const pv = await RiskManagerAgent.getEquity();
        const existingExposurePct = (parseFloat(openSymbolTrades?.exposure || 0) / pv.total_value) * 100;
        const proposedSizePct = trade.approved_size_pct || 1.0;
        if (existingExposurePct + proposedSizePct > currentLimits.MAX_CORRELATED_EXPOSURE_PCT) {
          console.warn(`[ORCHESTRATOR] Skipping ${trade.symbol} — correlated exposure ${(existingExposurePct + proposedSizePct).toFixed(1)}% > max ${currentLimits.MAX_CORRELATED_EXPOSURE_PCT}%`);
          await dbQuery(`INSERT INTO rejected_opportunities (cycle_number, rejected_by, symbol, direction, confidence, rejection_reason, rejection_detail, created_at) VALUES ($1, 'code_enforced', $2, $3, $4, 'correlated_exposure', $5, NOW())`,
            [cycleNum, trade.symbol, trade.direction, trade.confidence, `correlated exposure ${(existingExposurePct + proposedSizePct).toFixed(1)}% > max ${currentLimits.MAX_CORRELATED_EXPOSURE_PCT}%`]);
          continue;
        }
      } catch (err) {
        // Fail closed: a trade whose exposure cannot be verified is not executed
        console.error(`[ORCHESTRATOR] Correlated exposure check failed — skipping ${trade.symbol} (fail closed):`, err.message);
        await dbQuery(`INSERT INTO rejected_opportunities (cycle_number, rejected_by, symbol, direction, confidence, rejection_reason, rejection_detail, created_at) VALUES ($1, 'code_enforced', $2, $3, $4, 'risk_check_unavailable', $5, NOW())`,
          [cycleNum, trade.symbol, trade.direction, trade.confidence, `exposure check failed: ${err.message}`.slice(0, 200)]);
        continue;
      }

      // Resolve entry_price for market orders
      if (!trade.entry_price) {
        try {
          const row = await marketDataDb.getLatestClose(trade.symbol);
          if (row) trade.entry_price = parseFloat(row.close);
        } catch (e) {
          // calculateQuantity will throw if entry_price is still null
          console.warn(`[ORCHESTRATOR] Could not resolve entry_price for ${trade.symbol} at execution:`, e.message);
        }
      }
      // SL minimum distance: reject stops too tight for crypto 4h noise (< 1.5%)
      if (trade.entry_price && trade.sl_price) {
        const slDistance = Math.abs(trade.entry_price - trade.sl_price) / trade.entry_price;
        if (slDistance < 0.015) {
          console.warn(`[ORCHESTRATOR] Skipping ${trade.symbol} — SL too tight: ${(slDistance * 100).toFixed(2)}% < 1.5% minimum`);
          await dbQuery(
            `INSERT INTO rejected_opportunities (cycle_number, rejected_by, symbol, direction, confidence, rejection_reason, rejection_detail, created_at) VALUES ($1, 'code_enforced', $2, $3, $4, 'sl_too_tight', $5, NOW())`,
            [cycleNum, trade.symbol, trade.direction, trade.confidence, `SL distance ${(slDistance * 100).toFixed(2)}% < 1.5% minimum (entry=${trade.entry_price}, sl=${trade.sl_price})`]
          );
          continue;
        }
      }

      // R:R check (fee-adjusted) — runs AFTER entry_price is resolved so market orders are covered
      // Round-trip cost: ~0.2% (entry fee + slippage + exit fee)
      // Signed distances: a stop/target on the wrong side of entry yields risk<=0 / reward<=0 (rejected below)
      if (trade.entry_price && trade.tp_price && trade.sl_price) {
        const ROUND_TRIP_COST = trade.entry_price * 0.002;
        const dirSign = normalizeDirection(trade.direction) === 'short' ? -1 : 1;
        const reward = dirSign * (trade.tp_price - trade.entry_price) - ROUND_TRIP_COST;
        const risk   = dirSign * (trade.entry_price - trade.sl_price);
        if (!(risk > 0) || !(reward > 0)) {
          console.warn(`[ORCHESTRATOR] Skipping ${trade.symbol} — stop/target on wrong side of entry (entry=${trade.entry_price}, sl=${trade.sl_price}, tp=${trade.tp_price}, ${trade.direction})`);
          await dbQuery(
            `INSERT INTO rejected_opportunities (cycle_number, rejected_by, symbol, direction, confidence, rejection_reason, rejection_detail, created_at) VALUES ($1, 'code_enforced', $2, $3, $4, 'invalid_stop_geometry', $5, NOW())`,
            [cycleNum, trade.symbol, trade.direction, trade.confidence, `Stop/target on wrong side (entry=${trade.entry_price}, tp=${trade.tp_price}, sl=${trade.sl_price}, ${trade.direction})`]
          );
          continue;
        }
        if (risk > 0) {
          const rrRatio = reward / risk;
          if (rrRatio < currentLimits.MIN_RISK_REWARD_RATIO) {
            console.warn(`[ORCHESTRATOR] Skipping ${trade.symbol} — fee-adjusted R:R ${rrRatio.toFixed(2)} < min ${currentLimits.MIN_RISK_REWARD_RATIO} (reward=${reward.toFixed(2)}, risk=${risk.toFixed(2)}, fees=${ROUND_TRIP_COST.toFixed(2)})`);
            await dbQuery(
              `INSERT INTO rejected_opportunities (cycle_number, rejected_by, symbol, direction, confidence, rejection_reason, rejection_detail, created_at) VALUES ($1, 'code_enforced', $2, $3, $4, 'low_risk_reward', $5, NOW())`,
              [cycleNum, trade.symbol, trade.direction, trade.confidence, `Fee-adjusted R:R ${rrRatio.toFixed(2)} < min ${currentLimits.MIN_RISK_REWARD_RATIO} (entry=${trade.entry_price}, tp=${trade.tp_price}, sl=${trade.sl_price})`]
            );
            continue;
          }
        }
      }

      console.log(`[ORCHESTRATOR] Executing ${trade.direction} ${trade.symbol} @ ${trade.entry_price}`);
      const result = await executeTradeIdempotent({
        symbol: trade.symbol,
        side: trade.direction === 'long' ? 'buy' : 'sell',
        quantity: await calculateQuantity(trade),
        entry_price: trade.entry_price,
        tp_price: trade.tp_price,
        sl_price: trade.sl_price,
        template_id: trade.template_id || null,
        confidence: trade.confidence,
        cycle_number: cycleNum,
        agent_decision_id: synthDecision?.id,
        reasoning: trade.risk_notes || trade.reasoning,
        asset_class: 'crypto',
        exchange: 'kucoin',
      });
      // Recalibrate SL/TP if fill price differs from proposed entry by > 0.3%
      if (result.trade_id && result.fill_price && trade.tp_price && trade.sl_price) {
        const fillPrice = parseFloat(result.fill_price);
        const proposedEntry = parseFloat(trade.entry_price);
        const priceDiff = Math.abs(fillPrice - proposedEntry) / proposedEntry;
        if (priceDiff > 0.003) {
          const scale = fillPrice / proposedEntry;
          const newSl = parseFloat((trade.sl_price * scale).toFixed(2));
          const newTp = parseFloat((trade.tp_price * scale).toFixed(2));
          try {
            // Must be on the correct side of the ACTUAL fill; live trades also amend the exchange orders
            const dirSign = normalizeDirection(trade.direction) === 'short' ? -1 : 1;
            if (!(dirSign * (fillPrice - newSl) > 0) || !(dirSign * (newTp - fillPrice) > 0)) {
              throw new Error(`recalibrated levels on wrong side of fill ${fillPrice} (sl=${newSl}, tp=${newTp}, ${trade.direction})`);
            }
            await amendTradeStops({ id: result.trade_id, mode: engineMode() }, { sl_price: newSl, tp_price: newTp });
            console.log(`[ORCHESTRATOR] Recalibrated stops for #${result.trade_id}: SL ${trade.sl_price}→${newSl}, TP ${trade.tp_price}→${newTp} (fill slippage ${(priceDiff * 100).toFixed(2)}%)`);
          } catch (stopErr) {
            console.warn(`[ORCHESTRATOR] Stop recalibration failed for #${result.trade_id} (levels unchanged):`, stopErr.message);
          }
        }
      }

      trades.push(result);
      currentOpenCount++;
      console.log(`[ORCHESTRATOR] Trade executed: #${result.trade_id} ${trade.symbol} fill=${result.fill_price}`);

      // Notify
      notifications.tradeExecuted({ ...trade, ...result }).catch(err => logger.debug('Trade notification failed', { err, error_type: 'notification' }));

      // Link contributing signals to this trade
      if (result.trade_id) {
        try {
          await linkSignalsToTrade(result.trade_id, trade);
        } catch (linkErr) {
          console.error(`[ORCHESTRATOR] Signal linking failed for trade #${result.trade_id}:`, linkErr.message);
        }
      }
    } catch (err) {
      console.error(`[ORCHESTRATOR] Trade execution failed for ${trade.symbol}:`, err.message);
    }
  }

  if (broadcast && trades.length > 0) {
    broadcast('trades_executed', { cycleNumber: cycleNum, trades });
  }

  return {
    regime, proposals, approved: riskResult.approved, rejected: riskResult.rejected, trades,
    standing_orders: standingOrders,
    _synthOutput: synthDecision?.output_json || {},
  };
}

/**
 * Link active signals to an executed trade in the trade_signals junction table.
 */
async function linkSignalsToTrade(tradeId, trade) {
  const activeSignals = await signalsDb.getActive(trade.symbol);
  if (!activeSignals.length) return;

  const supportingNames = trade.supporting_signals || [];
  let linked = 0;

  for (const signal of activeSignals) {
    // Match by signal_type if the synthesizer provided supporting_signals list
    const isSupporting = supportingNames.length === 0 ||
      supportingNames.some(name =>
        signal.signal_type === name ||
        signal.signal_type.includes(name) ||
        name.includes(signal.signal_type)
      );

    if (isSupporting) {
      await signalsDb.linkToTrade(tradeId, signal.id, signal.current_strength || signal.strength);
      linked++;
    }
  }

  console.log(`[ORCHESTRATOR] Linked ${linked} signals to trade #${tradeId}`);
}

/**
 * Calculate position quantity from approved trade data.
 */
async function calculateQuantity(trade) {
  const sizePct = trade.approved_size_pct || 1.0;
  // ONE equity function (starting capital + realised + unrealised) shared with every % limit.
  // Fails closed: if equity cannot be determined (or is <= 0) no position is sized (H-11).
  const portfolioValue = (await RiskManagerAgent.getEquity()).total_value;
  if (!trade.entry_price || trade.entry_price <= 0) {
    throw new Error(`Invalid entry_price: ${trade.entry_price}`);
  }
  // Scale position size by conviction: high confidence = full size, low confidence = reduced size
  // 85%+ → 1.0x | 75–85% → 0.8x | 65–75% → 0.65x | <65% → 0.5x
  const confidence = parseFloat(trade.confidence) || 70;
  const convictionMultiplier = confidence >= 85 ? 1.0
    : confidence >= 75 ? 0.8
    : confidence >= 65 ? 0.65
    : 0.5;
  if (convictionMultiplier < 1.0) {
    console.log(`[ORCHESTRATOR] Conviction scaling: ${trade.symbol} conf=${confidence}% → ${(convictionMultiplier * 100).toFixed(0)}% size (${sizePct}% → ${(sizePct * convictionMultiplier).toFixed(2)}%)`);
  }
  const positionValue = portfolioValue * (sizePct / 100) * convictionMultiplier;
  return positionValue / trade.entry_price;
}

/**
 * Run the analysis layer: Performance Analyst → Pattern Discovery.
 * Runs periodically (not every cycle) to review and learn from trades.
 */
async function runAnalysisLayer(cycleNum, broadcast, cycle = null) {
  console.log(`[ORCHESTRATOR] Running analysis layer (cycle ${cycleNum})...`);
  const results = [];

  // Step 1: Performance Analyst — review trades, extract learnings
  console.log('[ORCHESTRATOR] → Performance Analyst');
  try {
    const perfResult = await performanceAnalyst.run({
      cycleNumber: cycleNum,
      broadcast,
    });
    // BaseAgent.run() returns decision.error instead of throwing
    const perfOk = !perfResult?.error;
    recordAgentOutcome(cycle, perfOk);
    results.push({
      agent: 'performance_analyst',
      status: perfOk ? 'fulfilled' : 'rejected',
      decision: perfResult,
      error: perfResult?.error || undefined,
      learnings: perfResult?.output_json?.learnings?.length || 0,
    });
    console.log(`[ORCHESTRATOR] Performance Analyst: ${perfResult?.output_json?.learnings?.length || 0} learnings extracted`);
  } catch (err) {
    recordAgentOutcome(cycle, false);
    results.push({ agent: 'performance_analyst', status: 'rejected', error: err.message });
    console.error('[ORCHESTRATOR] performanceAnalyst failed:', err.stack);
  }

  // Step 2: Pattern Discovery — find patterns, manage templates
  console.log('[ORCHESTRATOR] → Pattern Discovery');
  try {
    const patternResult = await patternDiscovery.run({
      cycleNumber: cycleNum,
      broadcast,
    });
    const patternOk = !patternResult?.error;
    recordAgentOutcome(cycle, patternOk);
    results.push({
      agent: 'pattern_discovery',
      status: patternOk ? 'fulfilled' : 'rejected',
      decision: patternResult,
      error: patternResult?.error || undefined,
      templates_created: patternResult?.output_json?.new_templates?.length || 0,
      anti_patterns: patternResult?.output_json?.anti_patterns?.length || 0,
    });
    console.log(`[ORCHESTRATOR] Pattern Discovery: ${patternResult?.output_json?.new_templates?.length || 0} templates, ${patternResult?.output_json?.anti_patterns?.length || 0} anti-patterns`);
  } catch (err) {
    recordAgentOutcome(cycle, false);
    results.push({ agent: 'pattern_discovery', status: 'rejected', error: err.message });
    console.error('[ORCHESTRATOR] patternDiscovery failed:', err.stack);
  }

  if (broadcast) {
    broadcast('analysis_complete', { cycleNumber: cycleNum, results });
  }

  return results;
}

/**
 * Track which learnings influenced this cycle's Synthesizer decision.
 * Called after Synthesizer runs each cycle.
 */
async function trackLearningInfluence(cycleNumber, synthesizerOutput, activeLearnings, currentRegime) {
  if (!activeLearnings || activeLearnings.length === 0) return;

  const STOP_WORDS = new Set(['the', 'a', 'an', 'is', 'in', 'of', 'to', 'for', 'and', 'or', 'with', 'on', 'at', 'by', 'it', 'be', 'as', 'that', 'this', 'was', 'are', 'not', 'but', 'has', 'had', 'have']);

  function getSignificantWords(text) {
    if (!text) return [];
    return text.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(w => w.length > 2 && !STOP_WORDS.has(w));
  }

  const synthReasoning = synthesizerOutput?.market_assessment || synthesizerOutput?.reasoning || '';
  const synthWords = new Set(getSignificantWords(synthReasoning));

  const regime = currentRegime?.regime || currentRegime?.crypto?.regime || 'unknown';

  for (const learning of activeLearnings) {
    try {
      // 1. Insert 'referenced' event — learning was in context
      await dbQuery(`
        INSERT INTO learning_influence_events (learning_id, cycle_number, event_type, regime)
        VALUES ($1, $2, 'referenced', $3)
      `, [learning.id, cycleNumber, regime]);

      // 2. Update reference counts
      await dbQuery(`
        UPDATE learnings SET
          times_referenced = times_referenced + 1,
          last_referenced_at = NOW()
        WHERE id = $1
      `, [learning.id]);

      // 3. Check if Synthesizer reasoning cited this learning (>3 word overlap)
      const learningWords = getSignificantWords(learning.insight_text);
      const overlap = learningWords.filter(w => synthWords.has(w));
      if (overlap.length > 3) {
        await dbQuery(`
          INSERT INTO learning_influence_events (learning_id, cycle_number, event_type, regime)
          VALUES ($1, $2, 'cited', $3)
        `, [learning.id, cycleNumber, regime]);
      }
    } catch (err) {
      console.error(`[ORCHESTRATOR] trackLearningInfluence failed for learning #${learning.id}:`, err.message);
    }
  }
  console.log(`[ORCHESTRATOR] Tracked influence for ${activeLearnings.length} learnings (cycle ${cycleNumber})`);
}

/**
 * After a trade closes, find learnings that were active when the trade was opened
 * and record the trade outcome against them (sample_size, influenced_trades, win/loss).
 *
 * Primary path: look for 'referenced'/'cited' events in learning_influence_events for the
 * opening cycle (written by trackLearningInfluence each cycle).
 *
 * Bootstrap fallback: if no referenced events exist yet (system is in candidate-only mode
 * or trackLearningInfluence hadn't run), credit all learnings that existed and were not
 * invalidated at trade open time.
 */
async function recordTradeCloseLearningOutcome(tradeId, pnl) {
  try {
    console.log(`[LEARNING] recordTradeCloseLearningOutcome — trade #${tradeId}, pnl=${pnl}`);

    const trade = await dbQueryOne(`SELECT opened_at, symbol FROM trades WHERE id = $1`, [tradeId]);
    if (!trade) {
      console.log(`[LEARNING] Trade #${tradeId} not found — skipping`);
      return;
    }

    // Find the cycle report closest to (and before) trade open time
    // Note: cycle_reports stores cycle_id, not cycle_number
    const cycleRow = await dbQueryOne(`
      SELECT cycle_id FROM cycle_reports
      WHERE created_at <= $1
      ORDER BY created_at DESC LIMIT 1
    `, [trade.opened_at]);
    const openCycle = cycleRow?.cycle_id ?? null;
    console.log(`[LEARNING] Trade #${tradeId} opened_at=${trade.opened_at}, opening cycle=${openCycle}`);

    // Primary: learnings referenced/cited in the opening cycle
    let learningIds = [];
    if (openCycle !== null) {
      const fromEvents = await dbQueryAll(`
        SELECT DISTINCT learning_id FROM learning_influence_events
        WHERE cycle_number = $1 AND event_type IN ('referenced', 'cited')
      `, [openCycle]);
      learningIds = fromEvents.map(r => r.learning_id);
      console.log(`[LEARNING] Primary path: ${learningIds.length} learning(s) from cycle ${openCycle} events`);
    }

    // Bootstrap fallback: no referenced events (candidates never tracked as active)
    if (learningIds.length === 0) {
      console.log(`[LEARNING] No referenced events found — bootstrap fallback: querying learnings active at trade open time`);
      const fallback = await dbQueryAll(`
        SELECT id FROM learnings
        WHERE created_at <= $1
          AND stage != 'invalidated'
          AND (invalidated_at IS NULL OR invalidated_at > $1)
      `, [trade.opened_at]);
      learningIds = fallback.map(r => r.id);
      console.log(`[LEARNING] Bootstrap fallback: ${learningIds.length} learning(s) to credit`);
    }

    if (learningIds.length === 0) {
      console.log(`[LEARNING] No learnings to credit for trade #${tradeId} — nothing to record`);
      return;
    }

    const isWin = parseFloat(pnl) > 0;
    const eventType = isWin ? 'trade_won' : 'trade_lost';
    const regimeRow = await dbQueryOne(`SELECT regime FROM market_regime ORDER BY created_at DESC LIMIT 1`);
    const regime = regimeRow?.regime || 'unknown';

    let credited = 0;
    for (const learning_id of learningIds) {
      try {
        // Deduplicate: skip if this trade's outcome was already recorded for this learning
        const existing = await dbQueryOne(`
          SELECT id FROM learning_influence_events
          WHERE learning_id = $1 AND trade_id = $2 AND event_type IN ('trade_won', 'trade_lost')
        `, [learning_id, tradeId]);
        if (existing) {
          console.log(`[LEARNING] Already recorded: learning #${learning_id} / trade #${tradeId} — skipping`);
          continue;
        }

        // Write outcome event
        await dbQuery(`
          INSERT INTO learning_influence_events (learning_id, cycle_number, trade_id, event_type, regime)
          VALUES ($1, $2, $3, $4, $5)
        `, [learning_id, openCycle, tradeId, eventType, regime]);

        // Increment sample_size, influenced_trades, and influenced_wins
        const updateResult = await dbQuery(`
          UPDATE learnings SET
            sample_size       = sample_size + 1,
            influenced_trades = influenced_trades + 1
            ${isWin ? ', influenced_wins = influenced_wins + 1' : ''}
          WHERE id = $1
        `, [learning_id]);
        if (updateResult.rowCount === 0) {
          console.error(`[LEARNING] WARNING: influence event written but learning row not updated — id: ${learning_id}`);
        }

        // Update regime_breakdown JSONB — use single-level jsonb_set with jsonb_build_object
        // so the intermediate key is created atomically even when it doesn't yet exist.
        await dbQuery(`
          UPDATE learnings SET
            regime_breakdown = jsonb_set(
              COALESCE(regime_breakdown, '{}'),
              ARRAY[$2],
              jsonb_build_object(
                'trades', (COALESCE((regime_breakdown->$2->>'trades')::int, 0) + 1),
                'wins',   (COALESCE((regime_breakdown->$2->>'wins')::int,   0) + ${isWin ? 1 : 0})
              ),
              true
            )
          WHERE id = $1
        `, [learning_id, regime]);

        credited++;
      } catch (err) {
        console.error(`[LEARNING] Failed to credit learning #${learning_id} for trade #${tradeId}:`, err.message);
      }
    }

    console.log(`[LEARNING] Trade #${tradeId} (${eventType}): credited ${credited}/${learningIds.length} learning(s)`);
  } catch (err) {
    console.error(`[LEARNING] recordTradeCloseLearningOutcome failed for trade #${tradeId}:`, err.message);
  }
}

/**
 * Close a trade via Python engine's /close-trade endpoint.
 */
function closeTradePython(tradeId) {
  return engineRequest('POST', '/close-trade', { trade_id: tradeId });
}

/**
 * Post-close bookkeeping shared by every close path (learning credit + thesis link).
 */
async function afterTradeClosed(tradeId, symbol, closed, closeReason) {
  const pnl = closed.pnl_realised || closed.pnl || 0;
  await recordTradeCloseLearningOutcome(tradeId, pnl);
  try {
    await linkTradeToTheses({
      id: tradeId, symbol, side: closed.side || 'buy',
      pnl_usd: pnl, pnl_pct: closed.pnl_pct || 0,
      close_reason: closeReason, hold_hours: closed.hold_hours || 0,
    });
  } catch (linkErr) {
    console.warn(`[ORCHESTRATOR] Thesis linking failed for #${tradeId} (non-critical):`, linkErr.message);
  }
}

/**
 * Close a trade through the engine, with the exchange/DB-divergence rules:
 *  - engine close OK                       -> closed
 *  - engine close FAILS, trade is LIVE     -> NEVER close in the DB only (the exchange position
 *                                              would stay open untracked). Mark status 'close_failed',
 *                                              raise a critical notification, leave it for retry.
 *  - engine close FAILS, trade is PAPER    -> atomic DB fallback (no exchange position exists)
 * @returns {Promise<{closed: boolean, closeFailed?: boolean, result?: object}>}
 */
async function closeTradeWithFallback(tradeId, { symbol, reasoning, closeReason = 'position_review' } = {}) {
  const trade = await tradesDb.getById(tradeId);
  if (!trade) {
    console.warn(`[ORCHESTRATOR] close: trade #${tradeId} not found`);
    return { closed: false };
  }
  if (trade.status === 'closed') return { closed: false };
  const sym = symbol || trade.symbol;

  try {
    const result = await closeTradePython(tradeId);
    console.log(`[ORCHESTRATOR] Closed trade #${tradeId} via Python — P&L: ${result.pnl_pct}%`);
    await afterTradeClosed(tradeId, sym, result, closeReason);
    return { closed: true, result };
  } catch (pyErr) {
    if (trade.mode === 'live') {
      console.error(`[ORCHESTRATOR] LIVE close failed for #${tradeId} (${sym}) — NOT closing in DB:`, pyErr.message);
      try {
        await dbQuery("UPDATE trades SET status = 'close_failed' WHERE id = $1 AND status IN ('open', 'close_failed')", [tradeId]);
      } catch (dbErr) {
        console.error(`[ORCHESTRATOR] Could not mark #${tradeId} close_failed:`, dbErr.message);
      }
      if (trade.status !== 'close_failed') {
        notifications.systemError('close_failed',
          `LIVE close of trade #${tradeId} ${sym} failed: ${pyErr.message}. Position may still be open on the exchange — retrying each cycle.`)
          .catch(nErr => logger.error('close_failed notification failed', { err: nErr, error_type: 'notification' }));
      }
      return { closed: false, closeFailed: true };
    }

    console.warn(`[ORCHESTRATOR] Python close failed for paper #${tradeId}, using DB fallback:`, pyErr.message);
    // Fallback: close directly in DB using atomic transaction (SELECT FOR UPDATE)
    const closed = await tradesDb.closeTradeAtomic(
      tradeId,
      async (t) => {
        const priceRow = await marketDataDb.getLatestClose(t.symbol);
        const exitPrice = priceRow ? parseFloat(priceRow.close) : parseFloat(t.entry_price);
        const entryPrice = parseFloat(t.entry_price);
        const pnl = t.side === 'buy'
          ? (exitPrice - entryPrice) * parseFloat(t.quantity)
          : (entryPrice - exitPrice) * parseFloat(t.quantity);
        const pnlPct = t.side === 'buy'
          ? ((exitPrice - entryPrice) / entryPrice) * 100
          : ((entryPrice - exitPrice) / entryPrice) * 100;
        return { exit_price: exitPrice, pnl, pnlPct };
      },
      { outcome_reasoning: reasoning, close_reason: closeReason }
    );
    if (!closed) {
      console.log(`[ORCHESTRATOR] Trade #${tradeId} already closed — skipping`);
      return { closed: false };
    }
    console.log(`[ORCHESTRATOR] Closed trade #${tradeId} via DB fallback (atomic) — P&L: ${closed.pnl_pct}%`);
    await afterTradeClosed(tradeId, sym, closed, closeReason);
    return { closed: true, result: closed };
  }
}

/**
 * Retry closes that previously failed on the engine (status 'close_failed'). Runs at cycle start.
 * Contract: the engine's /close-trade must accept trades in status 'open' OR 'close_failed'.
 */
async function retryFailedCloses() {
  let failed;
  try {
    failed = await dbQueryAll("SELECT id, symbol FROM trades WHERE status = 'close_failed' ORDER BY id");
  } catch (err) {
    console.error('[ORCHESTRATOR] close_failed lookup failed:', err.message);
    return { retried: 0, closed: 0 };
  }
  let closedCount = 0;
  for (const t of failed) {
    try {
      const out = await closeTradeWithFallback(t.id, { symbol: t.symbol, reasoning: 'retry after close_failed', closeReason: 'close_retry' });
      if (out.closed) closedCount++;
    } catch (err) {
      console.error(`[ORCHESTRATOR] Retry close of #${t.id} threw:`, err.message);
    }
  }
  if (failed.length > 0) console.log(`[ORCHESTRATOR] close_failed retry: ${closedCount}/${failed.length} closed`);
  return { retried: failed.length, closed: closedCount };
}

/**
 * Execute the closing action a SCRAM row asks for (CLOSE_ALL_POSITIONS / CLOSE_LOSING_POSITIONS),
 * through the same close path as position reviews. Manual SCRAMs only do this when close_mode is set.
 */
async function executeScramActions(scramRow) {
  const mode = scramCloseMode(scramRow);
  if (!mode) return { mode: null, closed: 0 };

  const open = await dbQueryAll("SELECT * FROM trades WHERE status IN ('open', 'close_failed') ORDER BY id");
  let closedCount = 0;
  for (const t of open) {
    try {
      if (mode === 'losing') {
        const price = (await fetchEnginePrice(t.symbol, 3000))
          || parseFloat((await marketDataDb.getLatestClose(t.symbol))?.close);
        const entry = parseFloat(t.actual_fill_price || t.entry_price);
        if (!Number.isFinite(price) || !(entry > 0)) {
          console.warn(`[SCRAM] No price for ${t.symbol} — cannot classify #${t.id} as losing, leaving it`);
          continue;
        }
        const pnlPositive = t.side === 'buy' ? price >= entry : price <= entry;
        if (pnlPositive) continue;
      }
      const out = await closeTradeWithFallback(t.id, { symbol: t.symbol, reasoning: `SCRAM ${scramRow.level} (${mode})`, closeReason: 'scram' });
      if (out.closed) closedCount++;
    } catch (err) {
      console.error(`[SCRAM] Failed to close #${t.id} ${t.symbol}:`, err.message);
    }
  }
  console.log(`[SCRAM] ${scramRow.level} close_mode=${mode}: closed ${closedCount}/${open.length} open position(s)`);
  return { mode, closed: closedCount };
}

/**
 * Change SL/TP on a trade. LIVE trades amend the exchange orders FIRST via the engine; if that
 * fails we throw and the DB levels are left untouched (DB must never claim a stop the exchange lacks).
 */
async function amendTradeStops(trade, { sl_price, tp_price }) {
  if (trade.mode === 'live') {
    await amendEngineStops(trade.id, { sl_price, tp_price });
  }
  const updated = await tradesDb.updateStops(trade.id, { sl_price, tp_price });
  if (!updated) throw new Error(`trade #${trade.id} not open — stops not updated`);
  return updated;
}

/**
 * Store a position review record in the position_reviews table.
 */
async function storePositionReview(review, cycleNum, agentDecisionId) {
  try {
    await positionReviewsDb.insert(review, cycleNum, agentDecisionId);
  } catch (err) {
    console.error(`[ORCHESTRATOR] Failed to store position review for trade #${review.trade_id}:`, err.message);
  }
}

/**
 * Execute a single review decision (HOLD, CLOSE, TIGHTEN, PARTIAL_CLOSE).
 * Enforces minimum 1-hour hold time unless SL/TP hit, regime flipped against position, or bleeding out (>-3%).
 */
const MIN_HOLD_HOURS = 1;

async function executeReviewDecision(review, cycleNum) {
  // Minimum hold time enforcement: skip CLOSE/TIGHTEN/PARTIAL_CLOSE if trade is too young
  if (review.decision !== 'hold') {
    const trade = await tradesDb.getById(review.trade_id);
    if (trade && trade.opened_at) {
      const hoursHeld = (Date.now() - new Date(trade.opened_at).getTime()) / (1000 * 60 * 60);

      if (hoursHeld < MIN_HOLD_HOURS) {
        // Reason 1: SL/TP hit — always allowed
        const isSlTpHit = review.close_reason === 'sl_hit' || review.close_reason === 'tp_hit'
          || review.reasoning?.toLowerCase().includes('stop loss')
          || review.reasoning?.toLowerCase().includes('take profit');

        // Reason 2: Regime flipped against position direction
        let regimeFlippedAgainst = false;
        try {
          const currentRegime = await dbQueryOne(
            "SELECT regime FROM market_regime WHERE asset_class = 'crypto' ORDER BY created_at DESC LIMIT 1"
          );
          if (currentRegime?.regime) {
            const r = currentRegime.regime;
            regimeFlippedAgainst =
              (trade.side === 'buy' && r === 'trending_down') ||
              (trade.side === 'sell' && r === 'trending_up');
          }
        } catch (regimeErr) {
          // regime check failure — enforce hold
          console.warn(`[ORCHESTRATOR] Regime check failed for #${review.trade_id} (enforcing hold):`, regimeErr.message);
        }

        // Reason 3: Bleeding out — unrealised P&L worse than -3%
        let bleedingOut = false;
        try {
          let currentPrice = await fetchEnginePrice(trade.symbol, 3000); // falls through to DB when null
          if (!currentPrice) {
            const row = await marketDataDb.getLatestClose(trade.symbol);
            if (row) currentPrice = parseFloat(row.close);
          }
          if (currentPrice) {
            const entry = parseFloat(trade.actual_fill_price || trade.entry_price);
            const pnlPct = trade.side === 'buy'
              ? ((currentPrice - entry) / entry) * 100
              : ((entry - currentPrice) / entry) * 100;
            bleedingOut = pnlPct <= -3;
          }
        } catch (priceErr) {
          // price fetch failure — enforce hold
          console.warn(`[ORCHESTRATOR] Price check failed for #${review.trade_id} (enforcing hold):`, priceErr.message);
        }

        if (!isSlTpHit && !regimeFlippedAgainst && !bleedingOut) {
          console.log(`[ORCHESTRATOR] Position #${review.trade_id} (${review.symbol}): ${review.decision.toUpperCase()} blocked — held only ${hoursHeld.toFixed(1)}h (min ${MIN_HOLD_HOURS}h). Forcing HOLD.`);
          review.decision = 'hold';
          review.hold_reason = `min_hold_time (${hoursHeld.toFixed(1)}h < ${MIN_HOLD_HOURS}h)`;
        } else {
          const reason = isSlTpHit ? 'sl_tp_hit' : regimeFlippedAgainst ? 'regime_flipped' : 'bleeding_out';
          console.log(`[ORCHESTRATOR] Position #${review.trade_id}: early ${review.decision} allowed (${reason})`);
        }
      }
    }
  }

  switch (review.decision) {
    case 'hold':
      console.log(`[ORCHESTRATOR] Position #${review.trade_id} (${review.symbol}): HOLD`);
      break;

    case 'close':
      console.log(`[ORCHESTRATOR] Position #${review.trade_id} (${review.symbol}): CLOSE`);
      try {
        // Live: engine failure => status 'close_failed' + notification (never a DB-only close).
        // Paper: atomic DB fallback.
        const out = await closeTradeWithFallback(review.trade_id, {
          symbol: review.symbol, reasoning: review.reasoning, closeReason: 'position_review',
        });
        if (out.closed) review.close_executed = true;
        if (out.closeFailed) review.close_failed = true;
      } catch (closeErr) {
        console.error(`[ORCHESTRATOR] Close failed for #${review.trade_id}:`, closeErr.message);
      }
      break;

    case 'tighten':
      console.log(`[ORCHESTRATOR] Position #${review.trade_id} (${review.symbol}): TIGHTEN TP=${review.new_tp} SL=${review.new_sl}`);
      try {
        // Get old stops for audit trail
        const trade = await tradesDb.getById(review.trade_id);
        if (!trade) throw new Error('trade not found');
        review.old_tp = trade.tp_price;
        review.old_sl = trade.sl_price;
        if (trade.status !== 'open') throw new Error(`trade status is ${trade.status} — not tightening`);

        // Validate: a tighten may only move the stop TOWARD price and must sit on the correct side
        // of the current price; the target may only move closer, never beyond the current one.
        const sign = trade.side === 'sell' ? -1 : 1;
        const price = (await fetchEnginePrice(trade.symbol, 3000))
          || parseFloat((await marketDataDb.getLatestClose(trade.symbol))?.close);
        if (!Number.isFinite(price) || price <= 0) throw new Error('no current price — cannot validate tighten');

        const oldSl = parseFloat(trade.sl_price);
        const oldTp = parseFloat(trade.tp_price);
        const reqSl = toFiniteNumber(review.new_sl);
        const reqTp = toFiniteNumber(review.new_tp);
        let newSl = null;
        let newTp = null;
        if (Number.isFinite(reqSl)) {
          const tighter = !Number.isFinite(oldSl) || sign * (reqSl - oldSl) > 0;   // long: higher stop
          const correctSide = sign * (price - reqSl) > 0;                          // long: stop below price
          if (tighter && correctSide) newSl = reqSl;
          else console.warn(`[ORCHESTRATOR] Rejected new SL ${reqSl} for #${review.trade_id}: tighter=${tighter} correctSide=${correctSide} (old=${oldSl}, price=${price})`);
        }
        if (Number.isFinite(reqTp)) {
          const closer = !Number.isFinite(oldTp) || sign * (oldTp - reqTp) > 0;    // long: lower target
          const correctSide = sign * (reqTp - price) > 0;                          // long: target above price
          if (closer && correctSide) newTp = reqTp;
          else console.warn(`[ORCHESTRATOR] Rejected new TP ${reqTp} for #${review.trade_id}: closer=${closer} correctSide=${correctSide} (old=${oldTp}, price=${price})`);
        }
        if (newSl == null && newTp == null) throw new Error('no valid tighter stop/target — levels unchanged');

        // Live: amend exchange orders first; on failure the DB levels stay as they are
        await amendTradeStops(trade, { sl_price: newSl, tp_price: newTp });
        review.new_sl = newSl;
        review.new_tp = newTp;
        console.log(`[ORCHESTRATOR] Updated stops for trade #${review.trade_id} (SL ${oldSl}→${newSl ?? oldSl}, TP ${oldTp}→${newTp ?? oldTp})`);
      } catch (err) {
        console.error(`[ORCHESTRATOR] Failed to tighten stops for #${review.trade_id}:`, err.message);
      }
      break;

    case 'partial_close':
      console.log(`[ORCHESTRATOR] Position #${review.trade_id} (${review.symbol}): PARTIAL_CLOSE ${review.close_pct}% (logged for future implementation)`);
      break;

    default:
      console.warn(`[ORCHESTRATOR] Unknown review decision "${review.decision}" for trade #${review.trade_id}`);
  }
}

/**
 * Review all open positions — Step 3.5 of the cycle.
 */
async function reviewOpenPositions(cycleNum, broadcast, cycle = null) {
  // Quick check: any open positions?
  const countResult = await dbQueryOne("SELECT COUNT(*) as cnt FROM trades WHERE status = 'open'");
  const openCount = parseInt(countResult?.cnt) || 0;

  if (openCount === 0) {
    console.log('[ORCHESTRATOR] No open positions — skipping position review');
    return { reviews: [], actions: [] };
  }

  console.log(`[ORCHESTRATOR] → Position Review (${openCount} open positions)`);
  const reviewStart = Date.now();

  const result = await riskManager.reviewPositions({ cycleNumber: cycleNum, broadcast });
  recordAgentOutcome(cycle, !result?.decision?.error);
  const reviews = result.reviews || [];

  // Execute each decision and store review
  const summary = { hold: 0, close: 0, tighten: 0, partial_close: 0 };
  for (const review of reviews) {
    await executeReviewDecision(review, cycleNum);
    await storePositionReview(review, cycleNum, result.decision?.id);
    summary[review.decision] = (summary[review.decision] || 0) + 1;
  }

  const elapsed = Date.now() - reviewStart;
  console.log(`[ORCHESTRATOR] Position review: ${reviews.length} reviewed — ${summary.hold} hold, ${summary.close} close, ${summary.tighten} tighten, ${summary.partial_close} partial_close (${elapsed}ms)`);

  if (broadcast) {
    broadcast('agent_complete', {
      cycleNumber: cycleNum,
      agent_name: 'position_reviewer',
      layer: 'strategy',
      reviews_count: reviews.length,
      summary,
      cost_usd: result.decision?.cost_usd || 0,
      duration_ms: elapsed,
    });
    const summaryText = `${summary.hold} hold, ${summary.close} close, ${summary.tighten} tighten, ${summary.partial_close} partial_close`;
    broadcast('position_review', {
      cycleNumber: cycleNum,
      reviews,
      summary: summaryText,
      portfolio_notes: result.portfolio_notes,
    });
  }

  return { reviews, actions: summary };
}

/**
 * Full agent cycle: refresh data → Knowledge → Position Review → Strategy → Analysis (periodic)
 */
async function runCycle({ broadcast } = {}) {
  if (cycleRunning) {
    // Check for stuck cycle — take over after timeout, ABORTING the stale one
    if (cycleStartedAt && (Date.now() - cycleStartedAt) > MAX_CYCLE_DURATION_MS) {
      console.error(`[ORCHESTRATOR] Previous cycle stuck for ${Math.round((Date.now() - cycleStartedAt) / 60000)}min — aborting it and taking over the mutex`);
      if (currentCycle) {
        currentCycle.cancelled = true;             // old cycle stops at its next layer/agent boundary
        await currentCycle.releaseLock().catch(err => console.warn('[ORCHESTRATOR] Stale cycle lock release failed:', err.message));
      }
      cycleRunning = false;
    } else {
      console.log('[ORCHESTRATOR] Cycle already running — skipping');
      return null;
    }
  }

  // This cycle's identity. Only the cycle that still owns the mutex may release it (see finally).
  const cycle = {
    id: crypto.randomUUID(),
    cancelled: false,
    stats: { run: 0, ok: 0, failed: 0 },
    releaseLock: async () => {},
  };
  cycleRunning = true;
  currentCycle = cycle;
  cycleStartedAt = Date.now();
  try {
  // Cross-process guard: a second process (deploy overlap / replica) must not run a cycle concurrently
  let lock = null;
  try {
    lock = await acquireCycleLock();
  } catch (lockErr) {
    console.error('[ORCHESTRATOR] Could not acquire cycle advisory lock — skipping cycle (fail closed):', lockErr.message);
    return null;
  }
  if (!lock) {
    console.log('[ORCHESTRATOR] Another process holds the cycle advisory lock — skipping');
    return null;
  }
  cycle.releaseLock = lock.release;
  console.log(`[ORCHESTRATOR] Cycle id ${cycle.id}`);

  // Resume cycle number from DB on first cycle after restart
  if (cycleNumber === null) {
    try {
      const lastCycle = await decisionsDb.getLastCycleNumber();
      cycleNumber = lastCycle;
      console.log(`[ORCHESTRATOR] Resumed cycle number from DB: ${cycleNumber}`);
    } catch (err) {
      cycleNumber = 0;
      logger.debug('No previous cycle found, starting from 0', { err, error_type: 'cycle_resume' });
    }
  }
  cycleNumber++;
  const cycleStart = Date.now();
  console.log(`\n[ORCHESTRATOR] ═══ Starting cycle ${cycleNumber} ═══`);

  // Detect system operating mode (BOOTSTRAP vs LEARNED)
  const { mode: systemMode, trades: closedTrades, active: activeLearnings } = await getSystemMode();
  console.log(`[ORCHESTRATOR] System mode: ${systemMode} (${closedTrades} closed trades, ${activeLearnings} active learnings)`);

  // Read bootstrap phase once per cycle — drives phase-gated token budgets in all agents
  const bootstrapPhaseRow = await dbQueryOne('SELECT phase FROM bootstrap_status ORDER BY id DESC LIMIT 1').catch(err => {
    console.warn('[ORCHESTRATOR] Bootstrap phase read failed — defaulting to infant:', err.message);
    return null;
  });
  const bootstrapPhase = bootstrapPhaseRow?.phase || 'infant';
  console.log(`[ORCHESTRATOR] Bootstrap phase: ${bootstrapPhase}`);

  // Broadcast cycle start
  if (broadcast) {
    broadcast('cycle_start', {
      cycleNumber,
      agents: knowledgeAgents.map(a => a.name),
    });
  }

  // COMPASS risk gate — evaluate posture before spending any API budget
  const COMPASS_ABORT_THRESHOLD  = parseFloat(process.env.COMPASS_ABORT_THRESHOLD  || '9.5');
  const COMPASS_REDUCE_THRESHOLD = parseFloat(process.env.COMPASS_REDUCE_THRESHOLD || '6.5');
  let compassConstraints = null;
  try {
    const [riskBusRow, postureBusRow] = await Promise.all([
      dbQueryOne(`
        SELECT payload FROM intelligence_bus
        WHERE source_system = 'compass'
          AND event_type    = 'portfolio_risk_state'
          AND (expires_at IS NULL OR expires_at > NOW())
          AND created_at   > NOW() - INTERVAL '24 hours'
        ORDER BY created_at DESC LIMIT 1`),
      dbQueryOne(`
        SELECT payload FROM intelligence_bus
        WHERE source_system = 'compass'
          AND event_type    = 'allocation_guidance'
          AND (expires_at IS NULL OR expires_at > NOW())
          AND created_at   > NOW() - INTERVAL '24 hours'
        ORDER BY created_at DESC LIMIT 1`),
    ]);

    if (!riskBusRow && !postureBusRow) {
      console.warn('[COMPASS_GATE] No fresh COMPASS signal in bus (stale or absent) — proceeding without gate');
    } else {
      const riskScore = riskBusRow  ? parseFloat(riskBusRow.payload?.risk_score   ?? -1) : -1;
      const posture   = postureBusRow ? String(postureBusRow.payload?.risk_posture || '').toUpperCase() : '';

      // In paper mode COMPASS is advisory — it informs the Synthesizer prompt but does not abort or reduce cycles.
      // Hard gates only engage when LIVE_TRADING_ENABLED=true.
      const isLive = process.env.LIVE_TRADING_ENABLED === 'true';
      const shouldAbort  = isLive && riskScore > COMPASS_ABORT_THRESHOLD;
      const shouldReduce = isLive && !shouldAbort && (riskScore >= COMPASS_REDUCE_THRESHOLD || posture === 'DEFENSIVE' || posture === 'CASH');

      if (shouldAbort) {
        const riskLabel = riskScore >= 0 ? `${riskScore.toFixed(1)}/10` : 'N/A';
        const reason    = `COMPASS ${posture || 'HIGH_RISK'} posture (risk: ${riskLabel})`;
        console.log(`[ORCHESTRATOR] Cycle aborted — ${reason}`);
        if (broadcast) {
          broadcast('cycle_skipped', {
            cycleNumber,
            reason,
            risk_score: riskScore >= 0 ? riskScore : null,
            posture,
          });
        }
        try {
          await dbQuery(
            `INSERT INTO agent_decisions (agent_name, agent_layer, cycle_number, reasoning, output_json)
             VALUES ($1, $2, $3, $4, $5)`,
            [
              'COMPASS_GATE',
              'strategy',
              cycleNumber,
              `Cycle skipped — ${reason}`,
              JSON.stringify({ risk_score: riskScore, posture, threshold_abort: COMPASS_ABORT_THRESHOLD, threshold_reduce: COMPASS_REDUCE_THRESHOLD }),
            ]
          );
        } catch (dbErr) {
          console.error('[COMPASS_GATE] Failed to record gate decision:', dbErr.message);
        }
        return abortedResult(cycle, { cycleNumber, reason: 'compass_gate', risk_score: riskScore, posture });
      }

      if (shouldReduce) {
        compassConstraints = { maxPositions: 1, halveSizes: true };
        console.log(`[COMPASS_GATE] Elevated risk (${riskScore.toFixed(1)}/10) — capping to 1 position, halving sizes this cycle`);
      } else {
        const gateStatus = !isLive && (riskScore > COMPASS_ABORT_THRESHOLD || posture === 'DEFENSIVE' || posture === 'CASH')
          ? 'paper mode — gate bypassed, COMPASS context injected into Synthesizer'
          : 'proceeding normally';
        console.log(`[COMPASS_GATE] Risk ${riskScore >= 0 ? riskScore.toFixed(1) + '/10' : 'N/A'} posture=${posture || 'NONE'} — ${gateStatus}`);
      }
    }
  } catch (gateErr) {
    if (process.env.LIVE_TRADING_ENABLED === 'true' && process.env.COMPASS_POSTURE_REQUIRED !== 'false') {
      // Live: COMPASS posture is mandatory — an unreadable gate means no cycle (fail closed)
      console.error('[COMPASS_GATE] Gate check failed in LIVE mode — aborting cycle (fail closed):', gateErr.message);
      if (broadcast) broadcast('cycle_skipped', { cycleNumber, reason: 'compass_gate_unavailable' });
      return abortedResult(cycle, { cycleNumber, reason: 'compass_gate_unavailable' });
    }
    console.error('[COMPASS_GATE] Gate check failed — proceeding without gate (paper mode):', gateErr.message);
  }


  // Step 0: Expire old standing orders
  let expiredStandingOrders = 0;
  try {
    const expired = await standingOrdersDb.expireOld();
    expiredStandingOrders = expired.rowCount || 0;
    if (expiredStandingOrders > 0) console.log(`[ORCHESTRATOR] Expired ${expiredStandingOrders} standing orders`);
  } catch (err) {
    logger.debug('Standing order expiry skipped', { err, cycle_id: cycleNumber, error_type: 'standing_order' });
  }

  // Step 0a: retry live closes the engine previously rejected (status 'close_failed')
  try {
    await retryFailedCloses();
  } catch (retryErr) {
    console.error('[ORCHESTRATOR] close_failed retry pass failed:', retryErr.message);
  }

  // Step 0b: SCRAM — execute the closing action the SCRAM asks for, then (automatic SCRAMs only)
  // auto-clear once drawdown has recovered. MANUAL SCRAMs are never auto-cleared: only an explicit
  // authenticated POST /system/scram/clear lifts them. Any error here leaves the SCRAM in force.
  try {
    const activeScram = await RiskManagerAgent.getActiveScram();
    if (activeScram) {
      try {
        await executeScramActions(activeScram);
      } catch (actErr) {
        console.error('[SCRAM] Close action failed (SCRAM stays active):', actErr.message);
      }

      if (isManualScram(activeScram)) {
        console.log(`[ORCHESTRATOR] Manual SCRAM ${activeScram.level} active — stays until explicitly reset`);
      } else {
        const currentDrawdown = await riskManager.computeCurrentDrawdown();
        const threshold = parseFloat(activeScram.threshold_value) || 10;
        if (currentDrawdown < threshold * 0.7) {
          await dbQuery(
            "UPDATE scram_events SET cleared_at = NOW(), duration_seconds = EXTRACT(EPOCH FROM (NOW() - activated_at))::int WHERE id = $1",
            [activeScram.id]
          );
          console.log(`[ORCHESTRATOR] SCRAM auto-cleared — drawdown ${currentDrawdown.toFixed(2)}% recovered below ${(threshold * 0.7).toFixed(1)}% (70% of trigger threshold)`);
        } else {
          console.log(`[ORCHESTRATOR] SCRAM still active — drawdown ${currentDrawdown.toFixed(2)}% vs threshold ${threshold}%`);
        }
      }
    }
  } catch (scramErr) {
    console.error('[ORCHESTRATOR] SCRAM handling failed (state left unchanged):', scramErr.message);
  }

  if (cycle.cancelled) return abortedResult(cycle, { cycleNumber, reason: 'cancelled' });

  // Step 1: Refresh market data
  const { dataQuality, report: dataQualityReport } = await refreshMarketData();
  if (cycle.cancelled) return abortedResult(cycle, { cycleNumber, reason: 'cancelled' });

  // Gate: abort cycle if data quality is critical (>50% stale/failed)
  if (dataQuality.status === 'critical') {
    console.error(`[ORCHESTRATOR] ABORTING cycle ${cycleNumber} — data quality critical: ${dataQuality.fresh}/${dataQuality.total} fresh (${dataQuality.freshPct}%)`);
    if (broadcast) {
      broadcast('cycle_aborted', {
        cycleNumber,
        reason: `Data quality critical: ${dataQuality.freshPct}% fresh data`,
        dataQuality,
      });
    }
    return abortedResult(cycle, { cycleNumber, reason: 'data_quality_critical', dataQuality });
  }

  // Step 2: Get indicators (shared between knowledge and strategy layers)
  const indicators = await getIndicatorsForAll('4h');
  if (cycle.cancelled) return abortedResult(cycle, { cycleNumber, reason: 'cancelled' });

  // Step 2b: Cache indicators in external_data_cache for context builders
  try {
    await cacheIndicators(indicators);
  } catch (err) {
    console.error('[ORCHESTRATOR] Indicator caching failed:', err.message);
  }

  // Step 3: Run knowledge agents (parallel — emit signals)
  // Inject data quality status so agents can adjust confidence when degraded
  const knowledge = await runKnowledgeLayer(cycleNumber, indicators, broadcast, dataQuality, bootstrapPhase, cycle);
  if (cycle.cancelled) return abortedResult(cycle, { cycleNumber, reason: 'cancelled' });

  // Step 3.5: Active Position Management
  let positionReview = { reviews: [], actions: [] };
  try {
    positionReview = await reviewOpenPositions(cycleNumber, broadcast, cycle);
  } catch (err) {
    recordAgentOutcome(cycle, false);
    console.error('[ORCHESTRATOR] Position review failed:', err.message);
  }
  if (cycle.cancelled) return abortedResult(cycle, { cycleNumber, reason: 'cancelled' });

  // Step 4: Run strategy layer (sequential — consume signals, produce trades)
  // H-6: Never skip the Synthesizer — in quiet markets, run with a "quiet_market" flag
  const successfulAgents = knowledge.filter(k => k.ok && k.decision?.output_json?.signals?.length > 0);
  const isQuietMarket = successfulAgents.length < 3;
  let strategy = { regime: null, proposals: [], approved: [], rejected: [], trades: [] };

  if (isQuietMarket) {
    console.warn(`[ORCHESTRATOR] Quiet market: only ${successfulAgents.length}/${knowledgeAgents.length} agents produced signals — running Synthesizer with quiet_market flag`);
    if (broadcast) {
      broadcast('agent_complete', {
        cycleNumber, agent_name: 'strategy_gate', layer: 'strategy',
        quiet_market: true, reason: `Quiet market: ${successfulAgents.length} agents produced signals`,
      });
    }
  }
  // H-8: Rate limit pacing — wait 30s after knowledge layer before starting Layer 2
  console.log('[ORCHESTRATOR] Rate limit pacing — waiting 30s before Layer 2 (strategy)');
  await new Promise(r => setTimeout(r, 30000));
  if (cycle.cancelled) return abortedResult(cycle, { cycleNumber, reason: 'cancelled' });

  // Always run strategy layer — even in quiet markets, the Synthesizer should evaluate
  // existing standing orders and check for opportunistic entries
  try {
    strategy = await runStrategyLayer(cycleNumber, indicators, broadcast, isQuietMarket, systemMode, compassConstraints, cycle);
  } catch (err) {
    console.error('[ORCHESTRATOR] Strategy layer failed:', err.message);
  }
  if (cycle.cancelled) return abortedResult(cycle, { cycleNumber, reason: 'cancelled' });

  // Step 5: Run analysis layer (every Nth cycle — not every cycle)
  // cycleNumber is derived from COUNT(cycle_reports) in DB via decisionsDb.getLastCycleNumber()
  // — immune to in-memory resets on restart, always DB-persisted.
  const analysisInterval = systemMode === 'BOOTSTRAP' ? ANALYSIS_INFANT_EVERY_N : ANALYSIS_EVERY_N_CYCLES;
  const shouldRunAnalysis = cycleNumber % analysisInterval === 0;
  let analysis = [];
  if (shouldRunAnalysis) {
    try {
      analysis = await runAnalysisLayer(cycleNumber, broadcast, cycle);
    } catch (err) {
      console.error('[ORCHESTRATOR] Analysis layer failed:', err.stack);
    }
  } else {
    console.log(`[ORCHESTRATOR] Skipping analysis layer (cycle ${cycleNumber}, runs every ${analysisInterval}th)`);
  }

  // Step 6: Record equity snapshot
  try {
    const pv = await portfolioDb.getPortfolioValue();
    const openCountRow = await dbQueryOne("SELECT COUNT(*) as cnt FROM trades WHERE status = 'open'");
    const openCount = parseInt(openCountRow?.cnt) || 0;
    await equityDb.insert({
      cycleNumber, totalValue: pv.total_value,
      realisedPnl: pv.realised_pnl, unrealisedPnl: pv.unrealised_pnl,
      openPositions: openCount,
    });
  } catch (err) {
    console.error('[ORCHESTRATOR] Equity snapshot failed:', err.message);
  }

  // Step 6b: Bootstrap phase promotion check (idempotent — runs every cycle)
  await checkAndPromoteBootstrapPhase();

  const elapsed = ((Date.now() - cycleStart) / 1000).toFixed(1);
  console.log(`[ORCHESTRATOR] ═══ Cycle ${cycleNumber} complete in ${elapsed}s ═══`);
  console.log(`[ORCHESTRATOR] Knowledge: ${knowledge.filter(k => k.ok).length}/${knowledge.length} agents succeeded`);
  console.log(`[ORCHESTRATOR] Agents this cycle: ${cycle.stats.run} run, ${cycle.stats.ok} succeeded, ${cycle.stats.failed} failed`);
  console.log(`[ORCHESTRATOR] Strategy: ${strategy.proposals.length} proposals → ${strategy.approved.length} approved → ${strategy.trades.length} executed`);
  if (analysis.length > 0) {
    console.log(`[ORCHESTRATOR] Analysis: ${analysis.filter(a => a.status === 'fulfilled').length}/${analysis.length} agents succeeded`);
  }

  // Step 7: Assemble and store cycle report
  const regimeData = strategy.regime?.crypto || Object.values(strategy.regime || {})[0] || {};
  const synthOutput = strategy._synthOutput || {};
  const posActions = positionReview.actions || {};

  // Build knowledge agent entries
  const knowledgeReport = knowledge.map(k => ({
    name: k.agent,
    signals: k.decision?.output_json?.signals?.length || 0,
    status: k.ok ? 'ok' : 'error',
    error: k.error || null,
  }));

  // Build rejection reasons from risk manager
  const rejectionReasons = (strategy.rejected || []).map(r =>
    r.reason || r.rejection_reason || `${r.symbol || 'unknown'} rejected`
  );

  // Performance analyst and pattern discovery from analysis layer
  const perfAnalyst = analysis.find(a => a.agent === 'performance_analyst');
  const patternDisc = analysis.find(a => a.agent === 'pattern_discovery');

  // Standing order counts
  let soActive = 0;
  let soExpiredThisCycle = 0;
  try {
    const soActiveRow = await dbQueryOne("SELECT COUNT(*)::int as cnt FROM standing_orders WHERE status = 'active'");
    soActive = parseInt(soActiveRow?.cnt) || 0;
    soExpiredThisCycle = expiredStandingOrders;
  } catch (soErr) {
    logger.debug('Standing order count failed (non-critical)', { err: soErr, cycle_id: cycleNumber, error_type: 'standing_order' });
  }

  // Auto-detect warnings
  const warnings = [];
  for (const k of knowledgeReport) {
    if (k.status === 'error') warnings.push(`${k.name} agent error: ${k.error}`);
    else if (k.signals === 0) warnings.push(`${k.name} returned 0 signals`);
  }
  if (strategy.proposals.length === 0 && (strategy.standing_orders?.length || 0) === 0) {
    warnings.push('Synthesizer produced 0 proposals and 0 standing orders');
  }
  if ((strategy.rejected?.length || 0) > 0 && (strategy.approved?.length || 0) === 0) {
    warnings.push(`Risk Manager rejected all ${strategy.rejected.length} proposals`);
  }
  if (perfAnalyst?.status === 'rejected') {
    warnings.push(`Performance Analyst error: ${perfAnalyst.error}`);
  }
  if (patternDisc?.status === 'rejected') {
    warnings.push(`Pattern Discovery error: ${patternDisc.error}`);
  }
  // Check for standing orders past their expires_at that are still active
  try {
    const staleRow = await dbQueryOne("SELECT COUNT(*)::int as cnt FROM standing_orders WHERE status = 'active' AND expires_at < NOW()");
    const staleSo = parseInt(staleRow?.cnt) || 0;
    if (staleSo > 0) warnings.push(`${staleSo} standing orders past their expires_at`);
  } catch (staleErr) {
    logger.debug('Stale standing order check failed (non-critical)', { err: staleErr, cycle_id: cycleNumber, error_type: 'standing_order' });
  }

  const cycleReport = {
    cycle_id: cycleNumber,
    completed_at: new Date().toISOString(),
    duration_ms: Date.now() - cycleStart,
    regime: {
      classification: regimeData.regime || 'unknown',
      confidence: regimeData.confidence || 0,
    },
    knowledge_agents: knowledgeReport,
    synthesizer: {
      proposals: strategy.proposals.length,
      standing_orders: strategy.standing_orders?.length || 0,
      no_action_reasons: synthOutput.no_action_reasons || [],
      market_assessment: typeof synthOutput.market_assessment === 'string'
        ? synthOutput.market_assessment
        : synthOutput.market_assessment?.summary || '',
    },
    risk_manager: {
      approved: strategy.approved?.length || 0,
      rejected: strategy.rejected?.length || 0,
      rejection_reasons: rejectionReasons,
    },
    position_manager: {
      held: posActions.hold || 0,
      closed: posActions.close || 0,
      tightened: posActions.tighten || 0,
    },
    performance_analyst: {
      status: !perfAnalyst ? 'skipped' : perfAnalyst.status === 'fulfilled' ? 'ok' : 'error',
      error: perfAnalyst?.error || null,
    },
    pattern_discovery: {
      status: !patternDisc ? 'skipped' : patternDisc.status === 'fulfilled' ? 'ok' : 'error',
      error: patternDisc?.error || null,
      signals_found: patternDisc?.decision?.output_json?.anti_patterns?.length || 0,
    },
    standing_orders: {
      active: soActive,
      expired_this_cycle: soExpiredThisCycle,
      triggered_this_cycle: strategy.trades?.length || 0,
    },
    warnings,
  };

  // Persist cycle report
  try {
    await cycleReportsDb.save(cycleNumber, cycleReport);
    console.log(`[ORCHESTRATOR] Cycle report saved for cycle ${cycleNumber}`);
  } catch (err) {
    console.error('[ORCHESTRATOR] Cycle report save failed:', err.message);
  }

  // Broadcast to WebSocket clients
  if (broadcast) {
    broadcast('cycle_report', cycleReport);
    broadcast('cycle_complete', {
      cycleNumber,
      agents: knowledge.map(k => ({
        agent: k.agent,
        status: k.ok ? k.status : 'rejected', // decision.error counts as failed
        signals: k.decision?.output_json?.signals?.length || 0,
      })),
      agentStats: { run: cycle.stats.run, succeeded: cycle.stats.ok, failed: cycle.stats.failed },
      positionReview: {
        reviewed: positionReview.reviews?.length || 0,
        actions: positionReview.actions || {},
      },
      strategy: {
        regime: strategy.regime,
        proposals: strategy.proposals.length,
        approved: strategy.approved.length,
        rejected: strategy.rejected.length,
        trades: strategy.trades.length,
        standing_orders: strategy.standing_orders?.length || 0,
      },
      analysis: analysis.length > 0 ? analysis : null,
      dataQuality,
      elapsed: `${elapsed}s`,
    });
  }

  // Notify cycle complete
  notifications.cycleComplete({
    cycleNumber, elapsed: `${elapsed}s`,
    strategy: { proposals: strategy.proposals.length, approved: strategy.approved.length, trades: strategy.trades.length, standing_orders: strategy.standing_orders?.length || 0 },
  }).catch(err => logger.debug('Cycle complete notification failed', { err, cycle_id: cycleNumber, error_type: 'notification' }));

  return {
    cycleNumber, knowledge, strategy, analysis,
    aborted: false,
    agentsRun: cycle.stats.run,
    agentsSucceeded: cycle.stats.ok,
    agentsFailed: cycle.stats.failed,
  };
  } finally {
    // Always drop the advisory lock (idempotent), but release the in-process mutex ONLY if this
    // cycle still owns it — a stale cycle that was taken over must not free the new owner's lock.
    await cycle.releaseLock().catch(err => console.warn('[ORCHESTRATOR] Cycle lock release failed:', err.message));
    if (currentCycle === cycle) {
      cycleRunning = false;
      currentCycle = null;
    }
  }
}

/**
 * Eagerly initialise cycleNumber from DB at startup (called by server.js).
 * Ensures the resume log appears in deploy output immediately.
 */
async function initCycleNumber() {
  if (cycleNumber !== null) return cycleNumber;
  try {
    const lastCycle = await decisionsDb.getLastCycleNumber();
    cycleNumber = lastCycle;
    console.log(`[ORCHESTRATOR] Resumed cycle number from DB: ${cycleNumber}`);
  } catch (err) {
    cycleNumber = 0;
    console.warn('[ORCHESTRATOR] Could not resume cycle number from DB, starting from 0:', err.message);
  }
  return cycleNumber;
}

module.exports = {
  refreshMarketData,
  getIndicatorsForAll,
  runKnowledgeLayer,
  runStrategyLayer,
  runAnalysisLayer,
  reviewOpenPositions,
  monitorPositions,
  checkStandingOrders,
  runCycle,
  getSystemMode,
  isCycleRunning: () => cycleRunning,
  initCycleNumber,
  recordTradeCloseLearningOutcome,
  checkAndPromoteBootstrapPhase,
  // SCRAM / close-path executors (also callable from the 15-min monitor)
  executeScramActions,
  retryFailedCloses,
  closeTradeWithFallback,
};
