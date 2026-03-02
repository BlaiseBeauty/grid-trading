/**
 * Agent Orchestrator — runs the 3-layer agent execution pipeline.
 * Layer 1: Knowledge agents (parallel) — emit signals
 * Layer 2: Strategy agents (sequential) — Regime → Synthesizer → Risk Manager → Execute
 * Layer 3: Analysis agents (periodic) — Phase 4
 */

const http = require('http');
const decisionsDb = require('../db/queries/decisions');
const costsDb = require('../db/queries/costs');
const signalsDb = require('../db/queries/signals');
const portfolioDb = require('../db/queries/portfolio');
const standingOrdersDb = require('../db/queries/standing-orders');
const indicatorCacheDb = require('../db/queries/indicator-cache');
const equityDb = require('../db/queries/equity');
const positionReviewsDb = require('../db/queries/position-reviews');
const marketDataDb = require('../db/queries/market-data');
const { queryOne: dbQueryOne } = require('../db/connection');
const { notifications } = require('../services/notifications');
const logger = require('../services/logger');
const { symbols: trackedSymbols, timeframes } = require('../config/symbols');

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

const tradesDb = require('../db/queries/trades');

const PYTHON_ENGINE_TIMEOUT_MS = 30000; // 30s timeout for Python engine calls

let cycleNumber = 0;
let cycleRunning = false;
const ANALYSIS_EVERY_N_CYCLES = 6; // Run analysis every 6 cycles (every 24h at 4h intervals)

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

    if (cond.price_below != null && currentPrice <= cond.price_below) {
      shouldTrigger = true;
    } else if (cond.price_above != null && currentPrice >= cond.price_above) {
      shouldTrigger = true;
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
        exchange: 'binance',
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
      // Revert to active so it can retry next check
      await standingOrdersDb.revertToActive(order.id)
        .catch(revertErr => logger.error('Failed to revert standing order status', { err: revertErr, error_type: 'standing_order', symbol: order.symbol }));
    }
  }

  if (triggered.length > 0) {
    console.log(`[MONITOR] ${triggered.length} standing order(s) triggered`);
  }

  return triggered;
}

/**
 * Fetch fresh market data for all tracked symbols.
 */
async function refreshMarketData() {
  console.log('[ORCHESTRATOR] Refreshing market data...');
  const results = [];

  for (const { symbol } of trackedSymbols) {
    for (const tf of timeframes) {
      try {
        const result = await fetchOHLCV(symbol, tf, 200);
        results.push({ symbol, timeframe: tf, ...result });
        console.log(`[DATA] ${symbol} ${tf}: ${result.stored || 0} candles stored`);
      } catch (err) {
        console.error(`[DATA] ${symbol} ${tf} failed:`, err.message);
      }
    }
  }

  return results;
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
async function runKnowledgeLayer(cycleNum, indicators, broadcast) {
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
async function runStrategyLayer(cycleNum, indicators, broadcast) {
  console.log(`[ORCHESTRATOR] Running strategy layer (cycle ${cycleNum})...`);

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
    });
    proposals = synthDecision?.output_json?.proposals || [];
    console.log(`[ORCHESTRATOR] Synthesizer produced ${proposals.length} proposals`);

    // Persist standing orders to DB
    standingOrders = synthDecision?.output_json?.standing_orders || [];
    if (standingOrders.length > 0) {
      let soStored = 0;
      for (const so of standingOrders) {
        try {
          const side = so.direction === 'long' ? 'buy' : 'sell';
          const expiresHours = so.expires_in_hours || 48;
          await standingOrdersDb.createFromSynthesizer({
            agentName: 'strategySynthesizer',
            agentDecisionId: synthDecision?.id || null,
            symbol: so.symbol,
            side,
            conditions: so.trigger_conditions,
            executionParams: so.exit_plan,
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

  if (proposals.length === 0) {
    console.log('[ORCHESTRATOR] No proposals to evaluate — strategy layer complete');
    return { regime, proposals: [], approved: [], rejected: [], trades: [], standing_orders: standingOrders };
  }

  // Step 3: Risk Manager — validate proposals against limits
  console.log('[ORCHESTRATOR] → Risk Manager');
  let riskResult = { approved: [], rejected: [] };
  try {
    const riskStart = Date.now();
    const riskDecision = await riskManager.run({
      cycleNumber: cycleNum,
      proposals,
      broadcast,
    });
    riskResult = {
      approved: riskDecision?.approved || riskDecision?.output_json?.approved || [],
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
  for (const trade of riskResult.approved) {
    try {
      console.log(`[ORCHESTRATOR] Executing ${trade.direction} ${trade.symbol} @ ${trade.entry_price}`);
      const result = await executeTrade({
        symbol: trade.symbol,
        side: trade.direction === 'long' ? 'buy' : 'sell',
        quantity: await calculateQuantity(trade),
        entry_price: trade.entry_price,
        tp_price: trade.tp_price,
        sl_price: trade.sl_price,
        confidence: trade.confidence,
        cycle_number: cycleNum,
        agent_decision_id: synthDecision?.id,
        reasoning: trade.risk_notes || trade.reasoning,
        asset_class: 'crypto',
        exchange: 'binance',
      });
      trades.push(result);
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

  return { regime, proposals, approved: riskResult.approved, rejected: riskResult.rejected, trades, standing_orders: standingOrders };
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
    console.error('[ORCHESTRATOR] Performance Analyst failed:', err.message);
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
    console.error('[ORCHESTRATOR] Pattern Discovery failed:', err.message);
  }

  if (broadcast) {
    broadcast('analysis_complete', { cycleNumber: cycleNum, results });
  }

  return results;
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
 */
async function executeReviewDecision(review, cycleNum) {
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
      } catch (pyErr) {
        console.warn(`[ORCHESTRATOR] Python close failed for #${review.trade_id}, using DB fallback:`, pyErr.message);
        try {
          // Fallback: close directly in DB (no slippage simulation)
          const trade = await tradesDb.getById(review.trade_id);
          if (trade && trade.status === 'open') {
            // Get current price from latest market data
            const priceRow = await marketDataDb.getLatestClose(trade.symbol);
            const exitPrice = priceRow ? parseFloat(priceRow.close) : parseFloat(trade.entry_price);
            const entryPrice = parseFloat(trade.entry_price);
            const pnl = trade.side === 'buy'
              ? (exitPrice - entryPrice) * parseFloat(trade.quantity)
              : (entryPrice - exitPrice) * parseFloat(trade.quantity);
            const pnlPct = trade.side === 'buy'
              ? ((exitPrice - entryPrice) / entryPrice) * 100
              : ((entryPrice - exitPrice) / entryPrice) * 100;

            await tradesDb.closeTrade(review.trade_id, {
              exit_price: exitPrice,
              pnl_realised: pnl,
              pnl_pct: pnlPct,
              outcome_class: null,
              outcome_reasoning: review.reasoning,
              close_reason: 'position_review',
            });
            review.close_executed = true;
            console.log(`[ORCHESTRATOR] Closed trade #${review.trade_id} via DB fallback — P&L: ${pnlPct.toFixed(2)}%`);
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
    broadcast('position_review', {
      cycleNumber: cycleNum,
      reviews,
      summary,
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
    console.log('[ORCHESTRATOR] Cycle already running — skipping');
    return null;
  }
  cycleRunning = true;
  try {
  // Resume cycle number from DB if this is the first cycle after restart
  if (cycleNumber === 0) {
    try {
      cycleNumber = await decisionsDb.getLastCycleNumber();
    } catch (err) {
      logger.debug('No previous cycle found, starting from 0', { err, error_type: 'cycle_resume' });
    }
  }
  cycleNumber++;
  const cycleStart = Date.now();
  console.log(`\n[ORCHESTRATOR] ═══ Starting cycle ${cycleNumber} ═══`);

  // Broadcast cycle start
  if (broadcast) {
    broadcast('cycle_start', {
      cycleNumber,
      agents: knowledgeAgents.map(a => a.name),
    });
  }

  // Step 0: Expire old standing orders
  try {
    const expired = await standingOrdersDb.expireOld();
    if (expired.rowCount > 0) console.log(`[ORCHESTRATOR] Expired ${expired.rowCount} standing orders`);
  } catch (err) {
    logger.debug('Standing order expiry skipped', { err, cycle_id: cycleNumber, error_type: 'standing_order' });
  }

  // Step 1: Refresh market data
  await refreshMarketData();

  // Step 2: Get indicators (shared between knowledge and strategy layers)
  const indicators = await getIndicatorsForAll('4h');

  // Step 2b: Cache indicators in external_data_cache for context builders
  try {
    await cacheIndicators(indicators);
  } catch (err) {
    console.error('[ORCHESTRATOR] Indicator caching failed:', err.message);
  }

  // Step 3: Run knowledge agents (parallel — emit signals)
  const knowledge = await runKnowledgeLayer(cycleNumber, indicators, broadcast);

  // Step 3.5: Active Position Management
  let positionReview = { reviews: [], actions: [] };
  try {
    positionReview = await reviewOpenPositions(cycleNumber, broadcast);
  } catch (err) {
    console.error('[ORCHESTRATOR] Position review failed:', err.message);
  }

  // Step 4: Run strategy layer (sequential — consume signals, produce trades)
  // Gate: require at least 3 knowledge agents to have produced signals
  const MIN_SUCCESSFUL_AGENTS = 3;
  const successfulAgents = knowledge.filter(k => k.status === 'fulfilled' && k.decision?.output_json?.signals?.length > 0);
  let strategy = { regime: null, proposals: [], approved: [], rejected: [], trades: [] };

  if (successfulAgents.length < MIN_SUCCESSFUL_AGENTS) {
    console.warn(`[ORCHESTRATOR] Skipping strategy layer: only ${successfulAgents.length}/${knowledgeAgents.length} agents produced signals (minimum ${MIN_SUCCESSFUL_AGENTS} required)`);
    if (broadcast) {
      broadcast('agent_complete', {
        cycleNumber, agent_name: 'strategy_gate', layer: 'strategy',
        skipped: true, reason: `Insufficient signals: ${successfulAgents.length}/${MIN_SUCCESSFUL_AGENTS} minimum`,
      });
    }
  } else {
    try {
      strategy = await runStrategyLayer(cycleNumber, indicators, broadcast);
    } catch (err) {
      console.error('[ORCHESTRATOR] Strategy layer failed:', err.message);
    }
  }

  // Step 5: Run analysis layer (periodic — every N cycles)
  let analysis = [];
  if (cycleNumber % ANALYSIS_EVERY_N_CYCLES === 0) {
    try {
      analysis = await runAnalysisLayer(cycleNumber, broadcast);
    } catch (err) {
      console.error('[ORCHESTRATOR] Analysis layer failed:', err.message);
    }
  }

  // Step 6: Record equity snapshot
  try {
    const pv = await portfolioDb.getPortfolioValue();
    const openCount = strategy.trades?.length || 0;
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

  // Broadcast to WebSocket clients
  if (broadcast) {
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
};
