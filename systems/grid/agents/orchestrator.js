/**
 * Agent Orchestrator — runs the 3-layer agent execution pipeline.
 * Layer 1: Knowledge agents (parallel) — emit signals
 * Layer 2: Strategy agents (sequential) — Regime → Synthesizer → Risk Manager → Execute
 * Layer 3: Analysis agents (periodic) — Phase 4
 */

const http = require('http');
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
const { queryOne: dbQueryOne, queryAll: dbQueryAll, query: dbQuery } = require('../../../db/connection');
const { notifications } = require('../../../services/notifications');
const logger = require('../../../services/logger');
const { symbols: trackedSymbols, timeframes } = require('../../../config/symbols');
const { getRiskLimits, BOOTSTRAP, SCRAM: SCRAM_OVERRIDES } = require('../config/risk-limits');
const { getLatestCorrelations } = require('./correlation-calculator');
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

let cycleNumber = null;
let cycleRunning = false;
let cycleStartedAt = null;
const MAX_CYCLE_DURATION_MS = 15 * 60 * 1000; // 15 minute timeout (was 60min — too long, caused stale locks)
const ANALYSIS_EVERY_N_CYCLES = 6; // Run analysis every 6 cycles (every 24h at 4h intervals)
const ANALYSIS_INFANT_EVERY_N = 1;  // Run every cycle during INFANT phase for maximum learning

/**
 * Fetch indicators from Python engine for a symbol.
 */
function fetchIndicators(symbol, timeframe = '4h') {
  const urlSymbol = symbol.replace('/', '-');
  return new Promise((resolve, reject) => {
    const url = `${process.env.PYTHON_ENGINE_URL || 'http://127.0.0.1:5100'}/indicators/${urlSymbol}?timeframe=${timeframe}`;
    const req = http.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.error) reject(new Error(parsed.error));
          else resolve(parsed.indicators || parsed);
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.setTimeout(PYTHON_ENGINE_TIMEOUT_MS, () => { req.destroy(new Error('Python engine timeout (30s)')); });
  });
}

/**
 * Fetch OHLCV data from Python engine.
 */
function fetchOHLCV(symbol, timeframe = '4h', limit = 200) {
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify({ symbol, timeframe, limit });
    const url = new URL(`${process.env.PYTHON_ENGINE_URL || 'http://127.0.0.1:5100'}/fetch-ohlcv`);
    const req = http.request({
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) },
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.error) reject(new Error(parsed.error));
          else resolve(parsed);
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.setTimeout(PYTHON_ENGINE_TIMEOUT_MS, () => { req.destroy(new Error('Python engine timeout (30s)')); });
    req.write(postData);
    req.end();
  });
}

/**
 * Execute approved trade via Python engine.
 */
function executeTrade(tradeData) {
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify(tradeData);
    const url = new URL(`${process.env.PYTHON_ENGINE_URL || 'http://127.0.0.1:5100'}/execute-trade`);
    const req = http.request({
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) },
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.error) reject(new Error(parsed.error));
          else resolve(parsed);
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.setTimeout(PYTHON_ENGINE_TIMEOUT_MS, () => { req.destroy(new Error('Python engine timeout (30s)')); });
    req.write(postData);
    req.end();
  });
}

/**
 * Monitor open positions — check TP/SL via Python engine.
 */
function monitorPositions() {
  return new Promise((resolve, reject) => {
    const postData = '{}';
    const url = new URL(`${process.env.PYTHON_ENGINE_URL || 'http://127.0.0.1:5100'}/monitor-positions`);
    const req = http.request({
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) },
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.setTimeout(PYTHON_ENGINE_TIMEOUT_MS, () => { req.destroy(new Error('Python engine timeout (30s)')); });
    req.write(postData);
    req.end();
  });
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
    let currentPrice;
    try {
      const dashSymbol = order.symbol.replace('/', '-');
      const res = await fetch(`${process.env.PYTHON_ENGINE_URL || 'http://127.0.0.1:5100'}/price/${dashSymbol}`);
      if (res.ok) {
        const data = await res.json();
        currentPrice = data.price;
      }
    } catch (err) {
      logger.debug('Live price unavailable for standing order', { err, symbol: order.symbol, error_type: 'price_fallback' });
    }

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
        "SELECT id FROM trades WHERE symbol = $1 AND status = 'open' LIMIT 1",
        [order.symbol]
      );
      if (existingOpen) {
        console.log(`[MONITOR] Skipping standing order #${order.id} — open trade #${existingOpen.id} on ${order.symbol} already exists`);
        await standingOrdersDb.markFailed(order.id, 'duplicate_position')
          .catch(() => standingOrdersDb.revertToActive(order.id).catch(() => {}));
        continue;
      }

      // --- Comprehensive risk pre-flight (mirrors risk-manager.js preflightCheck) ---
      const limits = getRiskLimits();
      let maxPositions = limits.MAX_OPEN_POSITIONS;
      let minConfidence = limits.MIN_CONFIDENCE_TO_TRADE;
      let scramOverrides = null;
      let bootstrapPhase = null;
      try {
        const bootstrapRow = await dbQueryOne('SELECT phase FROM bootstrap_status ORDER BY id DESC LIMIT 1');
        bootstrapPhase = bootstrapRow?.phase;
        if (bootstrapPhase && BOOTSTRAP[bootstrapPhase]?.MAX_OPEN_POSITIONS != null) {
          maxPositions = BOOTSTRAP[bootstrapPhase].MAX_OPEN_POSITIONS;
        }
        if (bootstrapPhase && BOOTSTRAP[bootstrapPhase]?.MIN_CONFIDENCE_TO_TRADE != null) {
          minConfidence = BOOTSTRAP[bootstrapPhase].MIN_CONFIDENCE_TO_TRADE;
        }
      } catch { /* use default */ }

      const rejectReasons = [];

      // SCRAM check — block all new positions during crisis/emergency
      try {
        const activeScram = await dbQueryOne("SELECT level FROM scram_events WHERE cleared_at IS NULL ORDER BY activated_at DESC LIMIT 1");
        if (activeScram) {
          scramOverrides = SCRAM_OVERRIDES?.[activeScram.level];
          if (scramOverrides?.NO_NEW_POSITIONS) {
            rejectReasons.push(`scram_active (${activeScram.level})`);
          }
          if (scramOverrides?.MAX_OPEN_POSITIONS != null) {
            maxPositions = Math.min(maxPositions, scramOverrides.MAX_OPEN_POSITIONS);
          }
        }
      } catch { /* proceed without scram check */ }

      // Drawdown check — block if max drawdown exceeded
      try {
        const hwmRow = await dbQueryOne('SELECT MAX(total_value) as high_water_mark FROM equity_snapshots');
        const highWaterMark = parseFloat(hwmRow?.high_water_mark);
        if (highWaterMark > 0) {
          const startingCapital = parseFloat(process.env.STARTING_CAPITAL || '10000');
          const [realisedRow, unrealisedRow] = await Promise.all([
            dbQueryOne("SELECT COALESCE(SUM(pnl_realised), 0) as total FROM trades WHERE status = 'closed'"),
            dbQueryOne('SELECT COALESCE(SUM(unrealised_pnl), 0) as total FROM portfolio_state'),
          ]);
          const currentEquity = startingCapital + parseFloat(realisedRow?.total || 0) + parseFloat(unrealisedRow?.total || 0);
          if (currentEquity < highWaterMark) {
            const drawdownPct = ((highWaterMark - currentEquity) / highWaterMark) * 100;
            if (drawdownPct >= limits.MAX_DRAWDOWN_PCT) {
              rejectReasons.push(`max_drawdown_exceeded (${drawdownPct.toFixed(1)}% >= ${limits.MAX_DRAWDOWN_PCT}%)`);
            }
          }
        }
      } catch { /* proceed without drawdown check */ }

      // Daily loss limit check
      try {
        const dailyPnl = await dbQueryOne(`
          SELECT COALESCE(SUM(pnl_realised), 0) as daily_pnl
          FROM trades WHERE status = 'closed' AND closed_at > CURRENT_DATE
        `);
        const portfolioValue = parseFloat(process.env.STARTING_CAPITAL || '10000');
        const dailyLossPct = Math.abs(Math.min(0, (parseFloat(dailyPnl?.daily_pnl) / portfolioValue) * 100));
        if (dailyLossPct >= limits.MAX_DAILY_LOSS_PCT) {
          rejectReasons.push(`daily_loss_limit (${dailyLossPct.toFixed(1)}% >= ${limits.MAX_DAILY_LOSS_PCT}%)`);
        }
      } catch { /* proceed without daily loss check */ }

      // Confidence gate
      if ((order.confidence || 0) < minConfidence) {
        rejectReasons.push(`low_confidence (${order.confidence} < ${minConfidence})`);
      }

      // Correlated exposure check
      try {
        const openTrades = await dbQueryAll("SELECT symbol, side, entry_price, quantity FROM trades WHERE status = 'open'");
        if (openTrades.length > 0) {
          let correlations;
          try { correlations = await getLatestCorrelations(); } catch { correlations = { BTC_ETH: 0.85, BTC_SOL: 0.85, ETH_SOL: 0.85 }; }
          const portfolioValue = parseFloat(process.env.STARTING_CAPITAL || '10000');
          const newSymbol = (order.symbol || '').split('/')[0];
          const newSign = order.side === 'sell' ? -1 : 1;
          const newSizePct = 3; // default standing order size
          let correlatedSum = newSizePct;
          for (const trade of openTrades) {
            const tradeSymbol = (trade.symbol || '').split('/')[0];
            if (tradeSymbol === newSymbol) continue;
            const pairKey1 = `${newSymbol}_${tradeSymbol}`;
            const pairKey2 = `${tradeSymbol}_${newSymbol}`;
            const corr = correlations[pairKey1] ?? correlations[pairKey2] ?? 0;
            if (Math.abs(corr) <= 0.5) continue;
            const existingSizePct = (parseFloat(trade.entry_price) * parseFloat(trade.quantity) / portfolioValue) * 100;
            const existingSign = trade.side === 'sell' ? -1 : 1;
            if (corr * newSign * existingSign > 0) correlatedSum += existingSizePct * Math.abs(corr);
          }
          if (correlatedSum > limits.MAX_CORRELATED_EXPOSURE_PCT) {
            rejectReasons.push(`correlated_exposure (${correlatedSum.toFixed(1)}% > ${limits.MAX_CORRELATED_EXPOSURE_PCT}%)`);
          }
        }
      } catch { /* proceed without correlation check */ }

      // Max open positions check
      const openCount = await dbQueryOne("SELECT COUNT(*)::int as cnt FROM trades WHERE status = 'open'");
      if ((openCount?.cnt || 0) >= maxPositions) {
        rejectReasons.push(`max_positions_reached (${openCount.cnt}/${maxPositions})`);
      }

      // If any risk check failed, reject the order
      if (rejectReasons.length > 0) {
        const reason = rejectReasons.join('; ');
        console.log(`[MONITOR] Standing order #${order.id} rejected by risk pre-flight: ${reason}`);
        await standingOrdersDb.markFailed(order.id, reason.slice(0, 200))
          .catch(() => standingOrdersDb.revertToActive(order.id).catch(() => {}));
        continue;
      }

      // Mark risk validated NOW (after passing all checks)
      await dbQuery('UPDATE standing_orders SET risk_validated_at = NOW() WHERE id = $1', [order.id]).catch(() => {});

      // Parse execution params for TP/SL
      const exec = typeof order.execution_params === 'string' ? JSON.parse(order.execution_params) : (order.execution_params || {});

      // Execute paper trade via Python engine
      const tradeResult = await executeTrade({
        symbol: order.symbol,
        side: order.side,
        quantity: await calculateQuantity({
          approved_size_pct: exec.position_size_pct || 1.0,
          entry_price: currentPrice,
        }),
        entry_price: currentPrice,
        tp_price: exec.take_profit || null,
        sl_price: exec.stop_loss || null,
        confidence: order.confidence,
        agent_decision_id: order.agent_decision_id,
        reasoning: `Standing order #${order.id} triggered at $${currentPrice}`,
        asset_class: order.asset_class || 'crypto',
        exchange: 'kucoin',
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
      // Determine if failure is transient (network/timeout) or permanent
      const isTransient = err.message.includes('timeout') || err.message.includes('ECONNREFUSED') || err.message.includes('ECONNRESET');
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
          } catch { /* DB check failed — assume ok if fetch succeeded */ }

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
async function runKnowledgeLayer(cycleNum, indicators, broadcast, dataQuality) {
  console.log(`[ORCHESTRATOR] Running knowledge layer (cycle ${cycleNum})...`);

  // Run in batches of 2 to stay within rate limits (30k input tokens/min)
  const BATCH_SIZE = 2;
  const allResults = [];

  for (let i = 0; i < knowledgeAgents.length; i += BATCH_SIZE) {
    const batch = knowledgeAgents.slice(i, i + BATCH_SIZE);
    const batchResults = await Promise.allSettled(
      batch.map(agent => {
        const agentStart = Date.now();
        return agent.run({
          symbols: trackedSymbols,
          indicators,
          cycleNumber: cycleNum,
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

  return allResults.map((r, i) => ({
    agent: knowledgeAgents[i].name,
    status: r.status,
    decision: r.status === 'fulfilled' ? r.value : null,
    error: r.status === 'rejected' ? r.reason.message : null,
  }));
}

/**
 * Run the strategy layer: Regime → Synthesizer → Risk Manager → Execute.
 */
async function runStrategyLayer(cycleNum, indicators, broadcast, quietMarket = false, systemMode = 'LEARNED') {
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
    console.error('[ORCHESTRATOR] Synthesizer failed:', err.message);
    if (broadcast) broadcast('agent_complete', { cycleNumber: cycleNum, agent_name: 'synthesizer', layer: 'strategy', error: err.message });
  }

  // Track learning influence — which learnings were in Synthesizer context this cycle
  try {
    const activeLearnings = await dbQueryAll(`
      SELECT id, insight_text FROM learnings
      WHERE stage = 'active' AND invalidated_at IS NULL
      ORDER BY decayed_confidence DESC NULLS LAST LIMIT 20
    `);
    if (activeLearnings.length > 0 && synthDecision) {
      await trackLearningInfluence(cycleNum, synthDecision.output_json || {}, activeLearnings, regime);
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

  // Step 3: Risk Manager — validate proposals against limits
  console.log(`[ORCHESTRATOR] Passing ${proposals.length} proposals to Risk Manager`);
  for (const p of proposals) {
    console.log(`[ORCHESTRATOR]   → ${p.symbol} ${p.direction} conf=${p.confidence} entry=${p.entry_price} sl=${p.sl_price} tp=${p.tp_price}`);
  }
  console.log('[ORCHESTRATOR] → Risk Manager');
  let riskResult = { approved: [], rejected: [] };
  try {
    const riskStart = Date.now();
    const riskDecision = await riskManager.run({
      cycleNumber: cycleNum,
      proposals,
      broadcast,
    });
    // Risk Manager returns { approved, rejected, decision } — use directly
    riskResult = {
      approved: (riskDecision?.approved || []).map(t => ({
        ...t,
        tp_price: t.tp_price ?? t.exit_plan?.take_profit ?? t.take_profit,
        sl_price: t.sl_price ?? t.exit_plan?.stop_loss ?? t.stop_loss,
      })),
      rejected: riskDecision?.rejected || [],
    };
    console.log(`[ORCHESTRATOR] Risk Manager: ${riskResult.approved.length} approved, ${riskResult.rejected.length} rejected`);
    if (broadcast) {
      broadcast('agent_complete', {
        cycleNumber: cycleNum, agent_name: 'risk_manager', layer: 'strategy',
        approved: riskResult.approved.length, rejected: riskResult.rejected.length,
        cost_usd: riskDecision?.cost_usd || 0, duration_ms: Date.now() - riskStart,
      });
    }
  } catch (err) {
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
  } catch { /* use default */ }
  let currentOpenCount = parseInt((await dbQueryOne("SELECT COUNT(*)::int as cnt FROM trades WHERE status = 'open'"))?.cnt || 0);

  // Daily loss gate — use calendar day, not rolling 24h
  let dailyLossBreached = false;
  try {
    const dailyPnl = await dbQueryOne(`
      SELECT COALESCE(SUM(pnl_realised), 0) as daily_pnl
      FROM trades WHERE status = 'closed' AND closed_at::date = CURRENT_DATE
    `);
    const pv = await portfolioDb.getPortfolioValue();
    const dailyLossPct = Math.abs(parseFloat(dailyPnl?.daily_pnl || 0)) / (pv.total_value || 10000) * 100;
    if (parseFloat(dailyPnl?.daily_pnl || 0) < 0 && dailyLossPct >= currentLimits.MAX_DAILY_LOSS_PCT) {
      dailyLossBreached = true;
      console.warn(`[ORCHESTRATOR] DAILY LOSS LIMIT BREACHED: ${dailyLossPct.toFixed(1)}% (max ${currentLimits.MAX_DAILY_LOSS_PCT}%) — no new trades`);
    }
  } catch (err) {
    console.warn('[ORCHESTRATOR] Daily loss check failed:', err.message);
  }

  for (const trade of riskResult.approved) {
    try {
      // Check daily loss limit
      if (dailyLossBreached) {
        console.log(`[ORCHESTRATOR] Skipping ${trade.symbol} — daily loss limit breached`);
        await dbQuery(`INSERT INTO rejected_opportunities (cycle_number, rejected_by, symbol, direction, confidence, rejection_reason, rejection_detail, created_at) VALUES ($1, 'code_enforced', $2, $3, $4, 'daily_loss_limit', $5, NOW())`,
          [cycleNum, trade.symbol, trade.direction, trade.confidence, `Daily loss limit breached (max ${currentLimits.MAX_DAILY_LOSS_PCT}%)`]);
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
        "SELECT id FROM trades WHERE symbol = $1 AND status = 'open' LIMIT 1",
        [trade.symbol]
      );
      if (existingOpen) {
        console.log(`[ORCHESTRATOR] Skipping ${trade.symbol} — open trade #${existingOpen.id} already exists`);
        await dbQuery(`INSERT INTO rejected_opportunities (cycle_number, rejected_by, symbol, direction, confidence, rejection_reason, rejection_detail, created_at) VALUES ($1, 'code_enforced', $2, $3, $4, 'duplicate_symbol_open', $5, NOW())`,
          [cycleNum, trade.symbol, trade.direction, trade.confidence, `open trade #${existingOpen.id} already exists`]);
        continue;
      }

      // M-18: Check minimum risk/reward ratio
      if (trade.entry_price && trade.tp_price && trade.sl_price) {
        const reward = Math.abs(trade.tp_price - trade.entry_price);
        const risk = Math.abs(trade.entry_price - trade.sl_price);
        if (risk > 0) {
          const rrRatio = reward / risk;
          if (rrRatio < currentLimits.MIN_RISK_REWARD_RATIO) {
            console.warn(`[ORCHESTRATOR] Skipping ${trade.symbol} — risk/reward ratio ${rrRatio.toFixed(2)} < min ${currentLimits.MIN_RISK_REWARD_RATIO}`);
            await dbQuery(`INSERT INTO rejected_opportunities (cycle_number, rejected_by, symbol, direction, confidence, rejection_reason, rejection_detail, created_at) VALUES ($1, 'code_enforced', $2, $3, $4, 'low_risk_reward', $5, NOW())`,
              [cycleNum, trade.symbol, trade.direction, trade.confidence, `R:R ${rrRatio.toFixed(2)} < min ${currentLimits.MIN_RISK_REWARD_RATIO}`]);
            continue;
          }
        }
      }

      // M-17: Check correlated exposure
      try {
        const openSymbolTrades = await dbQueryOne(
          "SELECT COUNT(*)::int as cnt, COALESCE(SUM(quantity * entry_price), 0) as exposure FROM trades WHERE symbol = $1 AND status = 'open'",
          [trade.symbol]
        );
        const pv = await portfolioDb.getPortfolioValue();
        const existingExposurePct = (parseFloat(openSymbolTrades?.exposure || 0) / (pv.total_value || 10000)) * 100;
        const proposedSizePct = trade.approved_size_pct || 1.0;
        if (existingExposurePct + proposedSizePct > currentLimits.MAX_CORRELATED_EXPOSURE_PCT) {
          console.warn(`[ORCHESTRATOR] Skipping ${trade.symbol} — correlated exposure ${(existingExposurePct + proposedSizePct).toFixed(1)}% > max ${currentLimits.MAX_CORRELATED_EXPOSURE_PCT}%`);
          await dbQuery(`INSERT INTO rejected_opportunities (cycle_number, rejected_by, symbol, direction, confidence, rejection_reason, rejection_detail, created_at) VALUES ($1, 'code_enforced', $2, $3, $4, 'correlated_exposure', $5, NOW())`,
            [cycleNum, trade.symbol, trade.direction, trade.confidence, `correlated exposure ${(existingExposurePct + proposedSizePct).toFixed(1)}% > max ${currentLimits.MAX_CORRELATED_EXPOSURE_PCT}%`]);
          continue;
        }
      } catch (err) {
        console.warn('[ORCHESTRATOR] Correlated exposure check failed:', err.message);
      }

      // Resolve entry_price for market orders
      if (!trade.entry_price) {
        try {
          const row = await marketDataDb.getLatestClose(trade.symbol);
          if (row) trade.entry_price = parseFloat(row.close);
        } catch (e) { /* will fail at calculateQuantity if still null */ }
      }
      console.log(`[ORCHESTRATOR] Executing ${trade.direction} ${trade.symbol} @ ${trade.entry_price}`);
      const result = await executeTrade({
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
  let portfolioValue;
  try {
    const pv = await portfolioDb.getPortfolioValue();
    portfolioValue = pv.total_value;
  } catch (err) {
    logger.warn('Portfolio value unavailable, using starting capital', { err, error_type: 'portfolio' });
    portfolioValue = parseFloat(process.env.STARTING_CAPITAL || '10000');
  }
  // H-11: Guard against zero/negative portfolio value
  if (!portfolioValue || portfolioValue <= 0) {
    throw new Error(`Portfolio value is zero or negative (${portfolioValue}) — cannot calculate position size`);
  }
  if (!trade.entry_price || trade.entry_price <= 0) {
    throw new Error(`Invalid entry_price: ${trade.entry_price}`);
  }
  const positionValue = portfolioValue * (sizePct / 100);
  return positionValue / trade.entry_price;
}

/**
 * Run the analysis layer: Performance Analyst → Pattern Discovery.
 * Runs periodically (not every cycle) to review and learn from trades.
 */
async function runAnalysisLayer(cycleNum, broadcast) {
  console.log(`[ORCHESTRATOR] Running analysis layer (cycle ${cycleNum})...`);
  const results = [];

  // Step 1: Performance Analyst — review trades, extract learnings
  console.log('[ORCHESTRATOR] → Performance Analyst');
  try {
    const perfResult = await performanceAnalyst.run({
      cycleNumber: cycleNum,
      broadcast,
    });
    results.push({
      agent: 'performance_analyst',
      status: 'fulfilled',
      decision: perfResult,
      learnings: perfResult?.output_json?.learnings?.length || 0,
    });
    console.log(`[ORCHESTRATOR] Performance Analyst: ${perfResult?.output_json?.learnings?.length || 0} learnings extracted`);
  } catch (err) {
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
    results.push({
      agent: 'pattern_discovery',
      status: 'fulfilled',
      decision: patternResult,
      templates_created: patternResult?.output_json?.new_templates?.length || 0,
      anti_patterns: patternResult?.output_json?.anti_patterns?.length || 0,
    });
    console.log(`[ORCHESTRATOR] Pattern Discovery: ${patternResult?.output_json?.new_templates?.length || 0} templates, ${patternResult?.output_json?.anti_patterns?.length || 0} anti-patterns`);
  } catch (err) {
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
 * After a trade closes, find learnings that were referenced in the opening cycle
 * and record trade outcome against them.
 */
async function recordTradeCloseLearningOutcome(tradeId, pnl) {
  try {
    // Find the cycle when this trade was opened
    const trade = await dbQueryOne(`SELECT opened_at, symbol FROM trades WHERE id = $1`, [tradeId]);
    if (!trade) return;

    // Find cycle number closest to trade open time
    const cycleRow = await dbQueryOne(`
      SELECT cycle_number FROM cycle_reports
      WHERE created_at <= $1
      ORDER BY created_at DESC LIMIT 1
    `, [trade.opened_at]);
    if (!cycleRow) return;
    const openCycle = cycleRow.cycle_number;

    // Find learnings that were referenced in that cycle
    const referencedLearnings = await dbQueryAll(`
      SELECT DISTINCT learning_id FROM learning_influence_events
      WHERE cycle_number = $1 AND event_type IN ('referenced', 'cited')
    `, [openCycle]);

    if (referencedLearnings.length === 0) return;

    const isWin = parseFloat(pnl) > 0;
    const eventType = isWin ? 'trade_won' : 'trade_lost';

    // Get current regime for regime_breakdown
    const regimeRow = await dbQueryOne(`SELECT regime FROM market_regime ORDER BY created_at DESC LIMIT 1`);
    const regime = regimeRow?.regime || 'unknown';

    for (const { learning_id } of referencedLearnings) {
      // Insert outcome event
      await dbQuery(`
        INSERT INTO learning_influence_events (learning_id, cycle_number, trade_id, event_type, regime)
        VALUES ($1, $2, $3, $4, $5)
      `, [learning_id, openCycle, tradeId, eventType, regime]);

      // Update influenced_trades / influenced_wins counters
      await dbQuery(`
        UPDATE learnings SET
          influenced_trades = influenced_trades + 1
          ${isWin ? ', influenced_wins = influenced_wins + 1' : ''}
        WHERE id = $1
      `, [learning_id]);

      // Update regime_breakdown JSONB
      await dbQuery(`
        UPDATE learnings SET
          regime_breakdown = jsonb_set(
            jsonb_set(
              COALESCE(regime_breakdown, '{}'),
              ARRAY[$2, 'trades'],
              (COALESCE((regime_breakdown->$2->>'trades')::int, 0) + 1)::text::jsonb
            ),
            ARRAY[$2, 'wins'],
            (COALESCE((regime_breakdown->$2->>'wins')::int, 0) + ${isWin ? 1 : 0})::text::jsonb
          )
        WHERE id = $1
      `, [learning_id, regime]);
    }

    console.log(`[ORCHESTRATOR] Recorded trade #${tradeId} outcome (${eventType}) for ${referencedLearnings.length} learnings`);
  } catch (err) {
    console.error(`[ORCHESTRATOR] recordTradeCloseLearningOutcome failed for trade #${tradeId}:`, err.message);
  }
}

/**
 * Close a trade via Python engine's /close-trade endpoint.
 */
function closeTradePython(tradeId) {
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify({ trade_id: tradeId });
    const url = new URL(`${process.env.PYTHON_ENGINE_URL || 'http://127.0.0.1:5100'}/close-trade`);
    const req = http.request({
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) },
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.error) reject(new Error(parsed.error));
          else resolve(parsed);
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.setTimeout(PYTHON_ENGINE_TIMEOUT_MS, () => { req.destroy(new Error('Python engine timeout (30s)')); });
    req.write(postData);
    req.end();
  });
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
        } catch { /* regime check failure — enforce hold */ }

        // Reason 3: Bleeding out — unrealised P&L worse than -3%
        let bleedingOut = false;
        try {
          let currentPrice;
          const dashSymbol = trade.symbol.replace('/', '-');
          try {
            const res = await fetch(`${process.env.PYTHON_ENGINE_URL || 'http://127.0.0.1:5100'}/price/${dashSymbol}`,
              { signal: AbortSignal.timeout(3000) });
            if (res.ok) currentPrice = (await res.json()).price;
          } catch { /* fall through to DB */ }
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
        } catch { /* price fetch failure — enforce hold */ }

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
        const result = await closeTradePython(review.trade_id);
        review.close_executed = true;
        console.log(`[ORCHESTRATOR] Closed trade #${review.trade_id} via Python — P&L: ${result.pnl_pct}%`);
        await recordTradeCloseLearningOutcome(review.trade_id, result.pnl_realised || result.pnl || 0);
        try {
          await linkTradeToTheses({
            id: review.trade_id, symbol: review.symbol, side: result.side || 'buy',
            pnl_usd: result.pnl_realised || result.pnl || 0, pnl_pct: result.pnl_pct || 0,
            close_reason: 'position_review', hold_hours: result.hold_hours || 0,
          });
        } catch (e) { /* thesis linking non-critical */ }
      } catch (pyErr) {
        console.warn(`[ORCHESTRATOR] Python close failed for #${review.trade_id}, using DB fallback:`, pyErr.message);
        try {
          // Fallback: close directly in DB using atomic transaction (SELECT FOR UPDATE)
          const closed = await tradesDb.closeTradeAtomic(
            review.trade_id,
            async (trade) => {
              const priceRow = await marketDataDb.getLatestClose(trade.symbol);
              const exitPrice = priceRow ? parseFloat(priceRow.close) : parseFloat(trade.entry_price);
              const entryPrice = parseFloat(trade.entry_price);
              const pnl = trade.side === 'buy'
                ? (exitPrice - entryPrice) * parseFloat(trade.quantity)
                : (entryPrice - exitPrice) * parseFloat(trade.quantity);
              const pnlPct = trade.side === 'buy'
                ? ((exitPrice - entryPrice) / entryPrice) * 100
                : ((entryPrice - exitPrice) / entryPrice) * 100;
              return { exit_price: exitPrice, pnl, pnlPct };
            },
            { outcome_reasoning: review.reasoning, close_reason: 'position_review' }
          );
          if (closed) {
            review.close_executed = true;
            console.log(`[ORCHESTRATOR] Closed trade #${review.trade_id} via DB fallback (atomic) — P&L: ${closed.pnl_pct}%`);
            await recordTradeCloseLearningOutcome(review.trade_id, closed.pnl_realised || 0);
            try {
              await linkTradeToTheses({
                id: review.trade_id, symbol: review.symbol, side: closed.side || 'buy',
                pnl_usd: closed.pnl_realised || 0, pnl_pct: closed.pnl_pct || 0,
                close_reason: 'position_review', hold_hours: closed.hold_hours || 0,
              });
            } catch (e) { /* thesis linking non-critical */ }
          } else {
            console.log(`[ORCHESTRATOR] Trade #${review.trade_id} already closed — skipping`);
          }
        } catch (dbErr) {
          console.error(`[ORCHESTRATOR] DB fallback close also failed for #${review.trade_id}:`, dbErr.message);
        }
      }
      break;

    case 'tighten':
      console.log(`[ORCHESTRATOR] Position #${review.trade_id} (${review.symbol}): TIGHTEN TP=${review.new_tp} SL=${review.new_sl}`);
      try {
        // Get old stops for audit trail
        const trade = await tradesDb.getById(review.trade_id);
        if (trade) {
          review.old_tp = trade.tp_price;
          review.old_sl = trade.sl_price;
        }
        await tradesDb.updateStops(review.trade_id, {
          tp_price: review.new_tp,
          sl_price: review.new_sl,
        });
        console.log(`[ORCHESTRATOR] Updated stops for trade #${review.trade_id}`);
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
async function reviewOpenPositions(cycleNum, broadcast) {
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
    // Check for stuck cycle — force release after timeout
    if (cycleStartedAt && (Date.now() - cycleStartedAt) > MAX_CYCLE_DURATION_MS) {
      console.error(`[ORCHESTRATOR] Previous cycle stuck for ${Math.round((Date.now() - cycleStartedAt) / 60000)}min — force releasing mutex`);
      cycleRunning = false;
    } else {
      console.log('[ORCHESTRATOR] Cycle already running — skipping');
      return null;
    }
  }
  cycleRunning = true;
  cycleStartedAt = Date.now();
  try {
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

  // Broadcast cycle start
  if (broadcast) {
    broadcast('cycle_start', {
      cycleNumber,
      agents: knowledgeAgents.map(a => a.name),
    });
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

  // Step 1: Refresh market data
  const { dataQuality, report: dataQualityReport } = await refreshMarketData();

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
    return { cycleNumber, aborted: true, reason: 'data_quality_critical', dataQuality };
  }

  // Step 2: Get indicators (shared between knowledge and strategy layers)
  const indicators = await getIndicatorsForAll('4h');

  // Step 2b: Cache indicators in external_data_cache for context builders
  try {
    await cacheIndicators(indicators);
  } catch (err) {
    console.error('[ORCHESTRATOR] Indicator caching failed:', err.message);
  }

  // Step 3: Run knowledge agents (parallel — emit signals)
  // Inject data quality status so agents can adjust confidence when degraded
  const knowledge = await runKnowledgeLayer(cycleNumber, indicators, broadcast, dataQuality);

  // Step 3.5: Active Position Management
  let positionReview = { reviews: [], actions: [] };
  try {
    positionReview = await reviewOpenPositions(cycleNumber, broadcast);
  } catch (err) {
    console.error('[ORCHESTRATOR] Position review failed:', err.message);
  }

  // Step 4: Run strategy layer (sequential — consume signals, produce trades)
  // H-6: Never skip the Synthesizer — in quiet markets, run with a "quiet_market" flag
  const successfulAgents = knowledge.filter(k => k.status === 'fulfilled' && k.decision?.output_json?.signals?.length > 0);
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

  // Always run strategy layer — even in quiet markets, the Synthesizer should evaluate
  // existing standing orders and check for opportunistic entries
  try {
    strategy = await runStrategyLayer(cycleNumber, indicators, broadcast, isQuietMarket, systemMode);
  } catch (err) {
    console.error('[ORCHESTRATOR] Strategy layer failed:', err.message);
  }

  // Step 5: Run analysis layer (every Nth cycle — not every cycle)
  const analysisInterval = systemMode === 'BOOTSTRAP' ? ANALYSIS_INFANT_EVERY_N : ANALYSIS_EVERY_N_CYCLES;
  const shouldRunAnalysis = cycleNumber % analysisInterval === 0;
  let analysis = [];
  if (shouldRunAnalysis) {
    try {
      analysis = await runAnalysisLayer(cycleNumber, broadcast);
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

  const elapsed = ((Date.now() - cycleStart) / 1000).toFixed(1);
  console.log(`[ORCHESTRATOR] ═══ Cycle ${cycleNumber} complete in ${elapsed}s ═══`);
  console.log(`[ORCHESTRATOR] Knowledge: ${knowledge.filter(k => k.status === 'fulfilled').length}/${knowledge.length} agents succeeded`);
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
    status: k.status === 'fulfilled' ? 'ok' : 'error',
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
  } catch { /* non-critical */ }

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
  } catch { /* non-critical */ }

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
        status: k.status,
        signals: k.decision?.output_json?.signals?.length || 0,
      })),
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

  return { cycleNumber, knowledge, strategy, analysis };
  } finally {
    cycleRunning = false;
  }
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
};
