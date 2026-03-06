// ============================================================================
// GRID — Agent Context Builders
// agents/context-builders.js
//
// Each function queries PostgreSQL and returns the USER MESSAGE content
// sent to Claude alongside the system prompt from config/agent-prompts.js.
//
// These are called by base-agent.js: CONTEXT_BUILDERS[promptKey](trigger)
// ============================================================================

const { queryAll, queryOne } = require('../db/connection');
const { getRelevantMemory } = require('./memory-injection');
const {
  getCurrentRegime, getPortfolioState, getActiveSignals,
  getRecentTrades, getUpcomingEvents, getScramState,
  getBootstrapPhase, getExternalData,
} = require('../db/queries/context');


// ============================================================================
// TOKEN BUDGET CONSTANTS & UTILITIES
// ============================================================================

const CONTEXT_LIMITS = {
  MAX_TRADES_RAW: 30,          // Max raw trade rows any agent receives
  MAX_SIGNALS_RAW: 50,         // Max raw signal rows (ORDER BY decayed_strength DESC)
  MAX_CANDLES_RAW: 50,         // Max candle rows
  MAX_CANDLES_TREND: 100,      // For agents needing longer MA lookback
  MAX_LEARNINGS_CHARS: 8000,   // Truncate injected learnings string at this
  MAX_DECISIONS_RAW: 30,       // Max recent agent_decisions rows (ORDER BY created_at DESC)
  MAX_CONTEXT_CHARS: 100000,   // Hard cap — no context builder may exceed ~100k chars
};

function estimateTokens(str) {
  // ~4 chars per token is a reasonable approximation
  return Math.ceil(str.length / 4);
}

function warnIfLarge(name, str) {
  if (str.length > CONTEXT_LIMITS.MAX_CONTEXT_CHARS) {
    console.warn(`[ContextBuilder:${name}] Truncating ${str.length} → ${CONTEXT_LIMITS.MAX_CONTEXT_CHARS} chars`);
    return str.slice(0, CONTEXT_LIMITS.MAX_CONTEXT_CHARS);
  }
  return str;
}

function truncateLearnings(str) {
  if (!str || str.length <= CONTEXT_LIMITS.MAX_LEARNINGS_CHARS) return str;
  return str.slice(0, CONTEXT_LIMITS.MAX_LEARNINGS_CHARS) + ' [truncated]';
}


// ============================================================================
// KNOWLEDGE AGENT CONTEXT BUILDERS
// ============================================================================

async function buildTrendContext(trigger) {
  const { symbols, assetClass } = trigger;
  const regime = await getCurrentRegime();

  const contextParts = [];

  for (const symbol of symbols) {
    const indicators = await queryOne(`
      SELECT data FROM external_data_cache
      WHERE source = 'indicators' AND metric = 'trend' AND symbol = $1
      ORDER BY fetched_at DESC LIMIT 1
    `, [symbol]);

    const priceData = {};
    for (const tf of ['1h', '4h', '1d']) {
      priceData[tf] = await queryAll(`
        SELECT open, high, low, close, volume, timestamp
        FROM market_data WHERE symbol = $1 AND timeframe = $2
          AND timestamp > NOW() - INTERVAL '7 days'
        ORDER BY timestamp DESC LIMIT ${CONTEXT_LIMITS.MAX_CANDLES_TREND}
      `, [symbol, tf]);
    }

    const newestCandle = priceData['4h']?.[0]?.timestamp;
    const isStale = newestCandle && (Date.now() - new Date(newestCandle).getTime()) > 12 * 3600 * 1000;

    contextParts.push({
      symbol,
      asset_class: assetClass,
      indicators: indicators?.data || {},
      price_data: priceData,
      data_freshness: isStale ? 'stale' : 'fresh',
    });
  }

  const memory = truncateLearnings(await getRelevantMemory('trendAgent', {
    symbols, assetClasses: [assetClass], regime: regime.regime,
    signalCategories: ['trend']
  }));

  const context = formatUserMessage({
    section1_market_data: contextParts,
    section2_context: {
      regime: regime.regime,
      regime_confidence: regime.confidence,
    },
    section3_memory: memory,
    section4_task: `Analyse trend indicators for ${symbols.join(', ')} across 1h/4h/1d timeframes. Output signals in JSON.`
  });
  return warnIfLarge('trend_agent', context);
}


async function buildMomentumContext(trigger) {
  const { symbols, assetClass } = trigger;
  const regime = await getCurrentRegime();

  const contextParts = [];

  for (const symbol of symbols) {
    const indicators = await queryOne(`
      SELECT data FROM external_data_cache
      WHERE source = 'indicators' AND metric = 'momentum' AND symbol = $1
      ORDER BY fetched_at DESC LIMIT 1
    `, [symbol]);

    const priceData = {};
    for (const tf of ['1h', '4h', '1d']) {
      priceData[tf] = await queryAll(`
        SELECT open, high, low, close, volume, timestamp
        FROM market_data WHERE symbol = $1 AND timeframe = $2
          AND timestamp > NOW() - INTERVAL '7 days'
        ORDER BY timestamp DESC LIMIT ${CONTEXT_LIMITS.MAX_CANDLES_TREND}
      `, [symbol, tf]);
    }

    const newestCandle = priceData['4h']?.[0]?.timestamp;
    const isStale = newestCandle && (Date.now() - new Date(newestCandle).getTime()) > 12 * 3600 * 1000;

    contextParts.push({
      symbol, asset_class: assetClass,
      indicators: indicators?.data || {},
      price_data: priceData,
      data_freshness: isStale ? 'stale' : 'fresh',
      ...(trigger.data_quality ? { data_quality: trigger.data_quality } : {}),
    });
  }

  const memory = truncateLearnings(await getRelevantMemory('momentumAgent', {
    symbols, assetClasses: [assetClass], regime: regime.regime,
    signalCategories: ['momentum']
  }));

  const context = formatUserMessage({
    section1_market_data: contextParts,
    section2_context: { regime: regime.regime, regime_confidence: regime.confidence },
    section3_memory: memory,
    section4_task: `Analyse momentum/oscillator indicators for ${symbols.join(', ')}. Identify divergences, oversold/overbought extremes, and multi-indicator alignment. Output signals in JSON.`
  });
  return warnIfLarge('momentum_agent', context);
}


async function buildVolatilityContext(trigger) {
  const { symbols, assetClass } = trigger;
  const regime = await getCurrentRegime();

  const contextParts = [];

  for (const symbol of symbols) {
    const indicators = await queryOne(`
      SELECT data FROM external_data_cache
      WHERE source = 'indicators' AND metric = 'volatility' AND symbol = $1
      ORDER BY fetched_at DESC LIMIT 1
    `, [symbol]);

    const priceData = {};
    for (const tf of ['1h', '4h', '1d']) {
      priceData[tf] = await queryAll(`
        SELECT open, high, low, close, volume, timestamp
        FROM market_data WHERE symbol = $1 AND timeframe = $2
          AND timestamp > NOW() - INTERVAL '7 days'
        ORDER BY timestamp DESC LIMIT ${CONTEXT_LIMITS.MAX_CANDLES_TREND}
      `, [symbol, tf]);
    }

    const newestCandle = priceData['4h']?.[0]?.timestamp;
    const isStale = newestCandle && (Date.now() - new Date(newestCandle).getTime()) > 12 * 3600 * 1000;

    contextParts.push({
      symbol, asset_class: assetClass,
      indicators: indicators?.data || {},
      price_data: priceData,
      data_freshness: isStale ? 'stale' : 'fresh',
      ...(trigger.data_quality ? { data_quality: trigger.data_quality } : {}),
    });
  }

  const memory = truncateLearnings(await getRelevantMemory('volatilityAgent', {
    symbols, assetClasses: [assetClass], regime: regime.regime,
    signalCategories: ['volatility']
  }));

  const context = formatUserMessage({
    section1_market_data: contextParts,
    section2_context: { regime: regime.regime, regime_confidence: regime.confidence },
    section3_memory: memory,
    section4_task: `Analyse volatility indicators for ${symbols.join(', ')}. Focus on squeezes, expansion/contraction, breakouts, and volatility regime changes. Output signals in JSON.`
  });
  return warnIfLarge('volatility_agent', context);
}


async function buildVolumeContext(trigger) {
  const { symbols, assetClass } = trigger;
  const regime = await getCurrentRegime();

  const contextParts = [];

  for (const symbol of symbols) {
    const indicators = await queryOne(`
      SELECT data FROM external_data_cache
      WHERE source = 'indicators' AND metric = 'volume' AND symbol = $1
      ORDER BY fetched_at DESC LIMIT 1
    `, [symbol]);

    const priceData = {};
    for (const tf of ['1h', '4h', '1d']) {
      priceData[tf] = await queryAll(`
        SELECT open, high, low, close, volume, timestamp
        FROM market_data WHERE symbol = $1 AND timeframe = $2
          AND timestamp > NOW() - INTERVAL '7 days'
        ORDER BY timestamp DESC LIMIT ${CONTEXT_LIMITS.MAX_CANDLES_TREND}
      `, [symbol, tf]);
    }

    const newestCandle = priceData['4h']?.[0]?.timestamp;
    const isStale = newestCandle && (Date.now() - new Date(newestCandle).getTime()) > 12 * 3600 * 1000;

    contextParts.push({
      symbol, asset_class: assetClass,
      indicators: indicators?.data || {},
      price_data: priceData,
      data_freshness: isStale ? 'stale' : 'fresh',
      ...(trigger.data_quality ? { data_quality: trigger.data_quality } : {}),
    });
  }

  const memory = truncateLearnings(await getRelevantMemory('volumeAgent', {
    symbols, assetClasses: [assetClass], regime: regime.regime,
    signalCategories: ['volume']
  }));

  const context = formatUserMessage({
    section1_market_data: contextParts,
    section2_context: { regime: regime.regime, regime_confidence: regime.confidence },
    section3_memory: memory,
    section4_task: `Analyse volume indicators for ${symbols.join(', ')}. Identify OBV divergences, VWAP levels, volume profile S/R, accumulation/distribution, and volume surges. Output signals in JSON.`
  });
  return warnIfLarge('volume_agent', context);
}


async function buildPatternContext(trigger) {
  const { symbols, assetClass } = trigger;
  const regime = await getCurrentRegime();

  // Get noise-flagged pattern types
  let noiseFlagged = [];
  try {
    const noisePatterns = await queryAll(`
      SELECT signal_type FROM signal_halflife
      WHERE peak_accuracy < 0.54 AND signal_type LIKE '%pattern%'
    `);
    noiseFlagged = noisePatterns.map(r => r.signal_type);
  } catch { /* table may be empty */ }

  const contextParts = [];

  for (const symbol of symbols) {
    const indicators = await queryOne(`
      SELECT data FROM external_data_cache
      WHERE source = 'indicators' AND metric = 'pattern' AND symbol = $1
      ORDER BY fetched_at DESC LIMIT 1
    `, [symbol]);

    const priceData = {};
    for (const tf of ['1h', '4h', '1d']) {
      priceData[tf] = await queryAll(`
        SELECT open, high, low, close, volume, timestamp
        FROM market_data WHERE symbol = $1 AND timeframe = $2
          AND timestamp > NOW() - INTERVAL '7 days'
        ORDER BY timestamp DESC LIMIT ${CONTEXT_LIMITS.MAX_CANDLES_TREND}
      `, [symbol, tf]);
    }

    // Asset profile for false breakout rates
    let profile = null;
    try {
      profile = await queryOne(`
        SELECT profile_data FROM asset_profiles WHERE symbol = $1
      `, [symbol]);
    } catch { /* table may be empty */ }

    const newestCandle = priceData['4h']?.[0]?.timestamp;
    const isStale = newestCandle && (Date.now() - new Date(newestCandle).getTime()) > 12 * 3600 * 1000;

    contextParts.push({
      symbol, asset_class: assetClass,
      indicators: indicators?.data || {},
      price_data: priceData,
      data_freshness: isStale ? 'stale' : 'fresh',
      asset_profile: profile?.profile_data || null,
      noise_flagged_patterns: noiseFlagged
    });
  }

  const memory = truncateLearnings(await getRelevantMemory('patternAgent', {
    symbols, assetClasses: [assetClass], regime: regime.regime,
    signalCategories: ['pattern']
  }));

  const context = formatUserMessage({
    section1_market_data: contextParts,
    section2_context: { regime: regime.regime, regime_confidence: regime.confidence },
    section3_memory: memory,
    section4_task: `Identify candlestick, chart, harmonic patterns and key S/R structure for ${symbols.join(', ')}. Deprioritise noise-flagged pattern types. Output signals in JSON.`
  });
  return warnIfLarge('pattern_agent', context);
}


async function buildOrderFlowContext(trigger) {
  const { symbols, assetClass } = trigger;
  const regime = await getCurrentRegime();

  // CoinGlass data
  const coinglass = await getExternalData('coinglass', [
    'liquidation_heatmap', 'aggregated_oi', 'funding_rates',
    'long_short_ratio', 'oi_change'
  ]);

  const contextParts = [];

  for (const symbol of symbols) {
    const symbolCG = await getExternalData('coinglass', [
      'liquidation_heatmap', 'funding_rates', 'long_short_ratio', 'oi_change'
    ], symbol);

    const priceData = await queryAll(`
      SELECT open, high, low, close, volume, timestamp
      FROM market_data WHERE symbol = $1 AND timeframe = '1h'
        AND timestamp > NOW() - INTERVAL '3 days'
      ORDER BY timestamp DESC LIMIT ${CONTEXT_LIMITS.MAX_CANDLES_RAW}
    `, [symbol]);

    contextParts.push({
      symbol, asset_class: assetClass,
      coinglass_data: symbolCG,
      price_data_1h: priceData
    });
  }

  const memory = truncateLearnings(await getRelevantMemory('orderFlowAgent', {
    symbols, assetClasses: [assetClass], regime: regime.regime,
    signalCategories: ['order_flow']
  }));

  const context = formatUserMessage({
    section1_market_data: {
      per_symbol: contextParts,
      aggregated: coinglass
    },
    section2_context: { regime: regime.regime, regime_confidence: regime.confidence },
    section3_memory: memory,
    section4_task: `Analyse order flow and derivatives data for ${symbols.join(', ')}. Focus on liquidation clusters, funding extremes, OI divergences, and positioning. Output signals in JSON.`
  });
  return warnIfLarge('order_flow_agent', context);
}


async function buildMacroContext(trigger) {
  const { symbols, assetClass } = trigger;
  const regime = await getCurrentRegime();

  // Glassnode on-chain data
  const glassnode = await getExternalData('glassnode', [
    'mvrv_zscore', 'nupl', 'realised_price', 'reserve_risk', 'puell_multiple',
    'mvrv_ratio', 'sopr', 'exchange_inflow', 'exchange_outflow',
    'active_addresses', 'supply_in_profit_pct'
  ]);

  // CryptoQuant data
  const cryptoquant = await getExternalData('cryptoquant', [
    'exchange_inflow', 'exchange_outflow', 'exchange_reserve',
    'sopr', 'stablecoin_exchange_supply', 'whale_alerts'
  ]);

  // FRED data
  const fred = await getExternalData('fred', [
    'dxy', 'us10y', 'us02y', 'vix', 'fed_funds_rate'
  ]);

  // Cross-asset price data
  // M-2: SPY/GLD/DXY may not be populated — inject clear message if empty
  const crossAsset = {};
  const MACRO_ASSETS = ['BTC/USDT', 'SPY', 'GLD', 'DXY'];
  const missingMacro = [];
  for (const sym of MACRO_ASSETS) {
    crossAsset[sym] = await queryAll(`
      SELECT close, timestamp FROM market_data
      WHERE symbol = $1 AND timeframe = '1d'
        AND timestamp > NOW() - INTERVAL '45 days'
      ORDER BY timestamp DESC LIMIT ${CONTEXT_LIMITS.MAX_CANDLES_RAW}
    `, [sym]);
    if (crossAsset[sym].length === 0 && sym !== 'BTC/USDT') {
      missingMacro.push(sym);
    }
  }
  if (missingMacro.length > 0) {
    crossAsset._note = `Macro cross-asset data (${missingMacro.join(', ')}): NOT FETCHED. Base macro analysis on crypto-internal signals only.`;
  }

  // Upcoming events
  const events = await getUpcomingEvents(72);

  // Event outcome memory
  let eventMemory = [];
  try {
    eventMemory = await queryAll(`
      SELECT event_type, surprise_direction, market_reactions
      FROM event_outcomes ORDER BY event_date DESC LIMIT 10
    `);
  } catch { /* table may be empty */ }

  const memory = truncateLearnings(await getRelevantMemory('macroAgent', {
    symbols, assetClasses: [assetClass], regime: regime.regime,
    signalCategories: ['macro', 'on_chain']
  }));

  const context = formatUserMessage({
    section1_market_data: {
      glassnode, cryptoquant, fred,
      cross_asset_prices: crossAsset,
      upcoming_events: events,
      recent_event_outcomes: eventMemory
    },
    section2_context: {
      regime: regime.regime,
      regime_confidence: regime.confidence,
      transition_probabilities: regime.transition_probabilities
    },
    section3_memory: memory,
    section4_task: `Analyse macro environment and on-chain data. Assess DXY, yields, VIX, MVRV cycle position, exchange flows, and upcoming events. Output signals in JSON.`
  });
  return warnIfLarge('macro_agent', context);
}


async function buildSentimentContext(trigger) {
  const { symbols, assetClass } = trigger;
  const regime = await getCurrentRegime();

  // Santiment per-asset data
  const santiment = {};
  for (const symbol of symbols) {
    santiment[symbol] = await getExternalData('santiment', [
      'social_volume', 'weighted_sentiment', 'dev_activity'
    ], symbol);
  }

  // CryptoQuant whale alerts
  const whaleAlerts = await getExternalData('cryptoquant', ['whale_alerts']);

  // Glassnode on-chain sentiment signals
  const onChain = await getExternalData('glassnode', [
    'sopr', 'exchange_inflow', 'exchange_outflow',
    'active_addresses', 'supply_in_profit_pct'
  ]);

  // Fear & Greed — inject clear message if unavailable
  let fearGreed = await getExternalData('alternative_me', ['fear_greed_index']);
  if (fearGreed?.fear_greed_index?.data?.error === 'unavailable') {
    fearGreed = { fear_greed_index: { data: null, note: 'Fear & Greed Index: DATA UNAVAILABLE — do not assume any value. Treat sentiment as unknown.' } };
  }

  const memory = truncateLearnings(await getRelevantMemory('sentimentAgent', {
    symbols, assetClasses: [assetClass], regime: regime.regime,
    signalCategories: ['sentiment']
  }));

  const context = formatUserMessage({
    section1_market_data: {
      fear_greed: fearGreed,
      per_asset_sentiment: santiment,
      whale_alerts: whaleAlerts?.whale_alerts?.data || [],
      on_chain: onChain
    },
    section2_context: { regime: regime.regime, regime_confidence: regime.confidence },
    section3_memory: memory,
    section4_task: `Analyse sentiment data for ${symbols.join(', ')}. Identify emotional extremes, social volume spikes, sentiment divergences, whale activity, and on-chain signals (SOPR, exchange flows, active addresses, supply in profit). Output signals in JSON.`
  });
  return warnIfLarge('sentiment_agent', context);
}


// ============================================================================
// STRATEGY AGENT CONTEXT BUILDERS
// ============================================================================

// Token budget: ~80k target (down from 180k+)
// Savings: signals top-50 + slim fields (~60k), templates drop validation cols (~5k),
//          recent_trades 10 not 20 (~3k), cooccurrence capped (~2k) = ~70k saved
async function buildSynthesizerContext(trigger) {
  const regime = await getCurrentRegime();
  const portfolio = await getPortfolioState();
  const scram = await getScramState();
  const bootstrap = await getBootstrapPhase();

  // Fetch active signals — already slim (no parameters/decay_model/expires_at) and
  // capped at 50 ORDER BY decayed_strength DESC from getActiveSignals()
  const signals = await getActiveSignals(null, '6 hours', CONTEXT_LIMITS.MAX_SIGNALS_RAW);

  // Active templates — only fields the Synthesizer needs for matching
  const templates = await queryAll(`
    SELECT st.id, st.name, st.description, st.entry_conditions, st.exit_conditions,
           st.valid_regimes, st.valid_asset_classes, st.valid_symbols, st.status,
           st.trade_count, st.timeframe_requirements, st.crowding_score,
           tp.win_rate, tp.avg_return_pct, tp.profit_factor,
           tp.sharpe, tp.total_trades, tp.max_drawdown,
           tp.outlier_dependent
    FROM strategy_templates st
    LEFT JOIN template_performance tp ON tp.template_id = st.id
    WHERE st.status IN ('active', 'testing')
    ORDER BY tp.win_rate DESC NULLS LAST
  `).then(rows => {
    // Hard filter: only keep templates whose valid_regimes includes the current regime
    const currentRegime = regime.regime;
    if (currentRegime) {
      return rows.filter(t => {
        if (!t.valid_regimes || !Array.isArray(t.valid_regimes)) return true; // no restriction = allow
        return t.valid_regimes.includes(currentRegime);
      });
    }
    return rows;
  });

  // Anti-patterns
  const antiPatterns = await queryAll(`
    SELECT description, signal_combination, lose_rate, valid_regimes
    FROM anti_patterns WHERE active = true
  `);

  // Active learnings only (stage='active' after lifecycle advancement)
  const recentLearnings = await queryAll(`
    SELECT insight_text, learning_type, scope_level,
           decayed_confidence, regime_breakdown,
           influenced_trades, influenced_wins, stage
    FROM learnings
    WHERE stage = 'active' AND invalidated_at IS NULL
    ORDER BY decayed_confidence DESC NULLS LAST
    LIMIT 20
  `);

  // Events
  const events = await getUpcomingEvents(48);

  // Calibration data
  const calibration = await queryAll(`
    SELECT confidence_bracket, predicted_avg, actual_win_rate, sample_size,
           calibration_error, adjustment_factor
    FROM confidence_calibration WHERE sample_size >= 5
    ORDER BY confidence_bracket
  `);

  // Correlation matrix for held assets
  const heldSymbols = (portfolio.positions || []).map(p => p.symbol);
  let correlations = [];
  if (heldSymbols.length > 1) {
    correlations = await queryAll(`
      SELECT symbol_a, symbol_b, correlation
      FROM correlation_matrix
      WHERE symbol_a = ANY($1) AND symbol_b = ANY($1)
      AND calculated_at > NOW() - INTERVAL '7 days'
    `, [heldSymbols]);
  }

  // Signal independence data (cap to avoid bloat)
  const signalTypes = [...new Set(signals.map(s => s.signal_type))].slice(0, 20);
  let cooccurrence = [];
  if (signalTypes.length > 1) {
    cooccurrence = await queryAll(`
      SELECT signal_type_a, signal_type_b, cooccurrence_rate
      FROM signal_cooccurrence
      WHERE signal_type_a = ANY($1) AND signal_type_b = ANY($1)
    `, [signalTypes]);
  }

  // Memory injection (2000 token budget)
  const memory = truncateLearnings(await getRelevantMemory('strategySynthesizer', {
    symbols: [...new Set(signals.map(s => s.symbol))],
    assetClasses: ['crypto'],
    regime: regime.regime,
    signalCategories: [...new Set(signals.map(s => s.signal_category))]
  }));

  // Exploration context (passed from orchestrator via base-agent spread)
  const hoursSinceLastTrade = trigger.hoursSinceLastTrade ?? null;
  const forcedExploration = trigger.forcedExploration || false;
  const paperMode = process.env.LIVE_TRADING_ENABLED !== 'true';

  const context = formatUserMessage({
    section1_market_data: {
      active_signals: signals,
      signal_cooccurrence: cooccurrence
    },
    section2_context: {
      regime: regime.regime,
      regime_confidence: regime.confidence,
      transition_probabilities: regime.transition_probabilities,
      portfolio,
      correlations,
      active_templates: templates,
      anti_patterns: antiPatterns,
      learnings: recentLearnings,
      upcoming_events: events,
      calibration_data: calibration,
      scram_state: scram,
      bootstrap_phase: bootstrap,
      paper_mode: paperMode,
      hours_since_last_trade: hoursSinceLastTrade,
      forced_exploration: forcedExploration
    },
    section3_memory: memory,
    section4_task: `Match active signals against templates. Generate trade proposals, standing orders, or explain why no action. Full reasoning required.`
  });
  console.log('[SYNTH] context length:', JSON.stringify(context).length);
  return warnIfLarge('strategy_synthesizer', context);
}


async function buildRiskManagerContext(trigger) {
  const { parentDecision } = trigger;
  const portfolio = await getPortfolioState();
  const scram = await getScramState();
  const bootstrap = await getBootstrapPhase();
  const events = await getUpcomingEvents(24);

  // Correlation matrix
  const heldSymbols = (portfolio.positions || []).map(p => p.symbol);
  if (parentDecision?.actions) {
    parentDecision.actions.forEach(a => {
      if (a.symbol && !heldSymbols.includes(a.symbol)) heldSymbols.push(a.symbol);
    });
  }

  let correlations = [];
  if (heldSymbols.length > 1) {
    correlations = await queryAll(`
      SELECT symbol_a, symbol_b, correlation
      FROM correlation_matrix
      WHERE symbol_a = ANY($1) AND symbol_b = ANY($1)
      AND calculated_at > NOW() - INTERVAL '7 days'
    `, [heldSymbols]);
  }

  // Exchange health
  const exchangeHealth = await queryAll(`
    SELECT DISTINCT ON (exchange) exchange, health_status, capital_allocated, capital_pct
    FROM exchange_health ORDER BY exchange, checked_at DESC
  `);

  // Risk limits config (paper/live aware)
  let riskLimits = {};
  try {
    const { getRiskLimits } = require('../config/risk-limits');
    riskLimits = getRiskLimits();
  } catch { /* may not exist */ }

  // Ruin simulation latest
  let ruin = null;
  try {
    ruin = await queryOne(`
      SELECT kelly_fraction, ruin_probability, assessment
      FROM ruin_simulations ORDER BY simulation_date DESC LIMIT 1
    `);
  } catch { /* table may be empty */ }

  // Memory (800 token budget)
  const memory = truncateLearnings(await getRelevantMemory('riskManager', {
    symbols: heldSymbols,
    assetClasses: [...new Set((portfolio.positions || []).map(p => p.asset_class))],
    regime: (await getCurrentRegime()).regime,
    signalCategories: ['risk']
  }));

  const context = formatUserMessage({
    section1_market_data: {
      proposal: parentDecision,
      trigger_type: trigger.trigger
    },
    section2_context: {
      portfolio,
      correlations,
      exchange_health: exchangeHealth,
      risk_limits: riskLimits,
      scram_state: scram,
      bootstrap_phase: bootstrap,
      upcoming_events: events,
      latest_ruin_simulation: ruin
    },
    section3_memory: memory,
    section4_task: trigger.trigger === 'position_monitor'
      ? `Review all open positions. Check if stops need tightening, if new risks emerged, if correlation changed.`
      : `Validate the trade proposal against all risk limits. Approve, modify, or reject with specific reasoning.`
  });
  return warnIfLarge('risk_manager', context);
}


async function buildRegimeContext(trigger) {
  // 30-day price data for key assets (daily candles)
  const assets = ['BTC/USDT', 'ETH/USDT', 'SPY', 'DXY', 'GLD'];
  const priceData = {};
  for (const sym of assets) {
    priceData[sym] = await queryAll(`
      SELECT open, high, low, close, volume, timestamp
      FROM market_data WHERE symbol = $1 AND timeframe = '1d'
        AND timestamp > NOW() - INTERVAL '45 days'
      ORDER BY timestamp DESC LIMIT ${CONTEXT_LIMITS.MAX_CANDLES_RAW}
    `, [sym]);
  }

  // Recent intraday data (1h candles, last 24h) for crypto assets
  // This ensures the classifier sees current-day moves, not just yesterday's close
  const cryptoAssets = ['BTC/USDT', 'ETH/USDT', 'SOL/USDT'];
  const intradayData = {};
  for (const sym of cryptoAssets) {
    const candles = await queryAll(`
      SELECT open, high, low, close, volume, timestamp
      FROM market_data WHERE symbol = $1 AND timeframe = '1h'
        AND timestamp > NOW() - INTERVAL '24 hours'
      ORDER BY timestamp DESC
      LIMIT ${CONTEXT_LIMITS.MAX_CANDLES_RAW}
    `, [sym]);
    if (candles.length > 0) {
      const latest = candles[0];
      const oldest = candles[candles.length - 1];
      const latestClose = parseFloat(latest.close);
      const oldestOpen = parseFloat(oldest.open);
      intradayData[sym] = {
        candles_1h: candles,
        current_price: latestClose,
        change_24h_pct: oldestOpen > 0 ? ((latestClose - oldestOpen) / oldestOpen) * 100 : 0,
      };
    }
  }

  // Volatility metrics
  const volatility = await queryOne(`
    SELECT data FROM external_data_cache
    WHERE source = 'indicators' AND metric = 'volatility' AND symbol = 'BTC/USDT'
    ORDER BY fetched_at DESC LIMIT 1
  `);

  // MVRV from Glassnode
  const mvrv = await getExternalData('glassnode', ['mvrv_zscore', 'nupl']);

  // VIX
  const vix = await getExternalData('fred', ['vix']);

  // Correlation matrix
  const correlations = await queryAll(`
    SELECT symbol_a, symbol_b, correlation
    FROM correlation_matrix
    WHERE calculated_at > NOW() - INTERVAL '7 days'
  `);

  // Regime history
  const regimeHistory = await queryAll(`
    SELECT regime, confidence, created_at
    FROM market_regime ORDER BY created_at DESC LIMIT 10
  `);

  const context = formatUserMessage({
    section1_market_data: {
      price_data_30d: priceData,
      intraday_24h: intradayData,
      volatility_metrics: volatility?.data || {},
      mvrv_data: mvrv,
      vix_data: vix,
      correlations
    },
    section2_context: {
      regime_history: regimeHistory
    },
    section3_memory: null,
    section4_task: `Classify current market regime. The intraday_24h section contains the most recent price action (1h candles + 24h change %) — weigh this heavily alongside the 30-day daily data. Estimate transition probabilities for next 7 days. Include MVRV cycle overlay.`
  });
  return warnIfLarge('regime_classifier', context);
}


// ============================================================================
// POSITION REVIEWER CONTEXT BUILDER
// ============================================================================

async function buildPositionReviewerContext(trigger) {
  // Open trades with linked entry signals (slim signal fields)
  const openTrades = await queryAll(`
    SELECT t.id, t.symbol, t.side, t.entry_price, t.exit_price,
           t.pnl_pct, t.template_id, t.entry_confidence, t.sl_price,
           t.tp_price, t.opened_at, t.status,
           EXTRACT(EPOCH FROM (NOW() - t.opened_at)) / 3600 AS hours_held,
           json_agg(json_build_object(
             'signal_id', s.id,
             'signal_type', s.signal_type,
             'signal_category', s.signal_category,
             'direction', s.direction,
             'strength', s.strength
           )) FILTER (WHERE s.id IS NOT NULL) AS entry_signals
    FROM trades t
    LEFT JOIN trade_signals ts ON ts.trade_id = t.id
    LEFT JOIN signals s ON s.id = ts.signal_id
    WHERE t.status = 'open'
    GROUP BY t.id
    ORDER BY t.created_at DESC
    LIMIT ${CONTEXT_LIMITS.MAX_TRADES_RAW}
  `);

  // Skip if no open positions
  if (!openTrades || openTrades.length === 0) return null;

  const heldSymbols = [...new Set(openTrades.map(t => t.symbol))];

  // Current active signals per held symbol (fresh from this cycle)
  // getActiveSignals already returns slim fields, capped & ordered by decayed_strength
  const activeSignals = {};
  for (const symbol of heldSymbols) {
    activeSignals[symbol] = await getActiveSignals(symbol, '6 hours', CONTEXT_LIMITS.MAX_SIGNALS_RAW);
  }

  const regime = await getCurrentRegime();
  const portfolio = await getPortfolioState();
  const scram = await getScramState();
  const bootstrap = await getBootstrapPhase();
  const events = await getUpcomingEvents(24);

  // Correlation matrix between held symbols
  let correlations = [];
  if (heldSymbols.length > 1) {
    correlations = await queryAll(`
      SELECT symbol_a, symbol_b, correlation
      FROM correlation_matrix
      WHERE symbol_a = ANY($1) AND symbol_b = ANY($1)
      AND calculated_at > NOW() - INTERVAL '7 days'
    `, [heldSymbols]);
  }

  // Previous position reviews (last 24h for continuity)
  let previousReviews = [];
  try {
    previousReviews = await queryAll(`
      SELECT trade_id, decision, reasoning, created_at
      FROM position_reviews
      WHERE created_at > NOW() - INTERVAL '24 hours'
      ORDER BY created_at DESC
      LIMIT 20
    `);
  } catch { /* table may not exist yet */ }

  // Risk limits config (paper/live aware)
  let riskLimits = {};
  try {
    const { getRiskLimits } = require('../config/risk-limits');
    riskLimits = getRiskLimits();
  } catch { /* may not exist */ }

  // Memory injection (800 token budget)
  const memory = truncateLearnings(await getRelevantMemory('positionReviewer', {
    symbols: heldSymbols,
    assetClasses: ['crypto'],
    regime: regime.regime,
    signalCategories: ['risk']
  }));

  const context = formatUserMessage({
    section1_market_data: {
      open_positions: openTrades,
      active_signals_per_symbol: activeSignals,
    },
    section2_context: {
      regime: regime.regime,
      regime_confidence: regime.confidence,
      transition_probabilities: regime.transition_probabilities,
      portfolio,
      correlations,
      scram_state: scram,
      bootstrap_phase: bootstrap,
      upcoming_events: events,
      previous_reviews: previousReviews,
      risk_limits: riskLimits,
    },
    section3_memory: memory,
    section4_task: `Review all ${openTrades.length} open position(s). For each, decide: HOLD, CLOSE, TIGHTEN, or PARTIAL_CLOSE. Output JSON with reviews array.`
  });
  return warnIfLarge('position_reviewer', context);
}


// ============================================================================
// ANALYSIS AGENT CONTEXT BUILDERS
// ============================================================================

async function buildPerformanceAnalystContext(trigger) {
  // --- Pre-aggregated trade stats (replaces unbounded raw trade dump) ---

  // Overall stats
  const overallStats = await queryOne(`
    SELECT COUNT(*)::int as total_trades,
           SUM(CASE WHEN pnl_pct > 0 THEN 1 ELSE 0 END)::int as wins,
           ROUND(SUM(CASE WHEN pnl_pct > 0 THEN 1 ELSE 0 END)::numeric
                 / NULLIF(COUNT(*), 0), 4) as win_rate,
           ROUND(AVG(pnl_pct)::numeric, 4) as avg_return,
           ROUND(SUM(pnl_pct)::numeric, 4) as total_pnl
    FROM trades WHERE status = 'closed'
  `);

  // Breakdown by symbol
  const bySymbol = await queryAll(`
    SELECT symbol, COUNT(*)::int as trades,
           SUM(CASE WHEN pnl_pct > 0 THEN 1 ELSE 0 END)::int as wins,
           ROUND(AVG(pnl_pct)::numeric, 4) as avg_return,
           ROUND(SUM(pnl_pct)::numeric, 4) as total_pnl
    FROM trades WHERE status = 'closed'
    GROUP BY symbol ORDER BY total_pnl DESC
  `);

  // Breakdown by regime (regime at time of trade entry)
  const byRegime = await queryAll(`
    SELECT mr.regime, COUNT(*)::int as trades,
           SUM(CASE WHEN t.pnl_pct > 0 THEN 1 ELSE 0 END)::int as wins,
           ROUND(AVG(t.pnl_pct)::numeric, 4) as avg_return
    FROM (SELECT * FROM trades WHERE status = 'closed' ORDER BY closed_at DESC LIMIT 50) t
    LEFT JOIN LATERAL (
      SELECT regime FROM market_regime WHERE created_at <= t.opened_at
      ORDER BY created_at DESC LIMIT 1
    ) mr ON true
    GROUP BY mr.regime
  `);

  // Breakdown by direction
  const byDirection = await queryAll(`
    SELECT side as direction, COUNT(*)::int as trades,
           SUM(CASE WHEN pnl_pct > 0 THEN 1 ELSE 0 END)::int as wins,
           ROUND(AVG(pnl_pct)::numeric, 4) as avg_return
    FROM trades WHERE status = 'closed'
    GROUP BY side
  `);

  // Recent trades (slim fields, capped for recency context)
  const recentTrades = await queryAll(`
    SELECT id, symbol, side, entry_price, exit_price, pnl_pct,
           template_id, entry_confidence, outcome_class, opened_at, closed_at, status
    FROM trades
    ORDER BY created_at DESC
    LIMIT ${CONTEXT_LIMITS.MAX_TRADES_RAW}
  `);

  // Open positions
  const openPositions = await queryAll(`
    SELECT id, symbol, side, entry_price, pnl_pct, opened_at
    FROM trades WHERE status = 'open' ORDER BY opened_at LIMIT 20
  `);

  // Template performance
  const templates = await queryAll(`
    SELECT st.id, st.name, st.status,
           tp.win_rate, tp.avg_return_pct, tp.total_trades
    FROM strategy_templates st
    LEFT JOIN template_performance tp ON tp.template_id = st.id
    WHERE st.status IN ('active', 'testing', 'paused')
    LIMIT 20
  `);

  // Active learnings (fetch rows, then truncate serialised string)
  const learningsRows = await queryAll(`
    SELECT id, insight_text, category, confidence, learning_type,
           created_at, updated_at
    FROM learnings WHERE invalidated_at IS NULL
    ORDER BY confidence DESC, updated_at DESC LIMIT 50
  `);
  let learnings = JSON.stringify(learningsRows, null, 0);
  if (learnings.length > CONTEXT_LIMITS.MAX_LEARNINGS_CHARS) {
    learnings = learnings.slice(0, CONTEXT_LIMITS.MAX_LEARNINGS_CHARS) + ' [truncated]';
  }

  // Calibration
  const calibration = await queryAll(`
    SELECT confidence_bracket, predicted_avg, actual_win_rate, sample_size,
           calibration_error, adjustment_factor
    FROM confidence_calibration ORDER BY calculated_at DESC LIMIT 20
  `);

  // Memory effectiveness
  let memEffect = [];
  try {
    memEffect = await queryAll(`
      SELECT learning_id, COUNT(*) as times_injected,
             AVG(CASE WHEN pnl_pct > 0 THEN 1.0 ELSE 0.0 END) as win_rate_when_injected
      FROM memory_effectiveness
      WHERE was_injected = true
      GROUP BY learning_id HAVING COUNT(*) >= 3
      LIMIT ${CONTEXT_LIMITS.MAX_DECISIONS_RAW}
    `);
  } catch { /* table may be empty */ }

  // System costs today
  const costs = await queryOne(`
    SELECT SUM(cost_usd) as total_cost,
           SUM(CASE WHEN service = 'anthropic' THEN cost_usd ELSE 0 END) as ai_cost
    FROM system_costs WHERE created_at > NOW() - INTERVAL '24 hours'
  `);

  // Crowding scores
  let crowding = [];
  try {
    crowding = await queryAll(`
      SELECT DISTINCT ON (template_id) template_id, crowding_score, assessment
      FROM crowding_scores ORDER BY template_id, computed_at DESC
      LIMIT 20
    `);
  } catch { /* table may be empty */ }

  // SCRAM events today
  let scramEvents = [];
  try {
    scramEvents = await queryAll(`
      SELECT * FROM scram_events WHERE activated_at > NOW() - INTERVAL '24 hours'
      LIMIT ${CONTEXT_LIMITS.MAX_DECISIONS_RAW}
    `);
  } catch { /* table may be empty */ }

  const context = formatUserMessage({
    section1_market_data: {
      trade_summary: {
        overall: overallStats,
        by_symbol: bySymbol,
        by_regime: byRegime,
        by_direction: byDirection,
      },
      recent_trades: recentTrades,
      open_positions: openPositions
    },
    section2_context: {
      templates,
      active_learnings: learnings,
      calibration,
      memory_effectiveness: memEffect,
      crowding_scores: crowding,
      costs,
      scram_events: scramEvents
    },
    section3_memory: null,
    section4_task: `Nightly review. Generate new learnings, invalidate stale ones, update template assessments, check calibration, assess system evolution, analyse costs.`
  });

  console.log('[PA] context length:', JSON.stringify(context).length);
  return warnIfLarge('performance_analyst', context);
}


async function buildPatternDiscoveryContext(trigger) {
  // --- Pre-aggregated trade+signal stats (replaces unbounded raw dump) ---

  // Trade stats by template (30d)
  const tradesByTemplate = await queryAll(`
    SELECT template_id, COUNT(*)::int as trades,
           SUM(CASE WHEN pnl_pct > 0 THEN 1 ELSE 0 END)::int as wins,
           ROUND(AVG(pnl_pct)::numeric, 4) as avg_return,
           ROUND(SUM(pnl_pct)::numeric, 4) as total_pnl
    FROM trades WHERE status = 'closed' AND closed_at > NOW() - INTERVAL '30 days'
    GROUP BY template_id ORDER BY total_pnl DESC
  `);

  // Signal type effectiveness (30d)
  const signalStats = await queryAll(`
    SELECT s.signal_type, s.signal_category,
           COUNT(DISTINCT t.id)::int as trade_count,
           SUM(CASE WHEN t.pnl_pct > 0 THEN 1 ELSE 0 END)::int as wins,
           ROUND(AVG(t.pnl_pct)::numeric, 4) as avg_return,
           ROUND(AVG(s.strength)::numeric, 4) as avg_strength
    FROM trade_signals ts
    JOIN signals s ON s.id = ts.signal_id
    JOIN trades t ON t.id = ts.trade_id
    WHERE t.status = 'closed' AND t.closed_at > NOW() - INTERVAL '30 days'
    GROUP BY s.signal_type, s.signal_category
    ORDER BY trade_count DESC
  `);

  // Recent trades (raw, capped for recency context)
  const recentTrades = await queryAll(`
    SELECT t.id, t.symbol, t.side, t.pnl_pct, t.template_id,
           t.outcome_class, t.entry_confidence, t.opened_at, t.closed_at,
           json_agg(json_build_object(
             'signal_type', s.signal_type,
             'signal_category', s.signal_category,
             'direction', s.direction,
             'strength', s.strength
           )) FILTER (WHERE s.id IS NOT NULL) as signals_at_entry
    FROM trades t
    LEFT JOIN trade_signals ts ON ts.trade_id = t.id
    LEFT JOIN signals s ON s.id = ts.signal_id
    WHERE t.closed_at > NOW() - INTERVAL '30 days' AND t.status = 'closed'
    GROUP BY t.id
    ORDER BY t.created_at DESC
    LIMIT ${CONTEXT_LIMITS.MAX_TRADES_RAW}
  `);

  // Current templates (slim fields)
  const templates = await queryAll(`
    SELECT st.id, st.name, st.description, st.entry_conditions, st.exit_conditions,
           st.valid_regimes, st.status, st.trade_count,
           tp.win_rate, tp.avg_return_pct, tp.total_trades,
           tp.sharpe, tp.concentration_ratio, tp.outlier_dependent
    FROM strategy_templates st
    LEFT JOIN template_performance tp ON tp.template_id = st.id
    WHERE st.status != 'retired'
  `);

  // Anti-patterns (slim fields)
  const antiPatterns = await queryAll(`
    SELECT description, signal_combination, lose_rate, valid_regimes
    FROM anti_patterns WHERE active = true
  `);

  // Signal cooccurrence (capped)
  let cooccurrence = [];
  try {
    cooccurrence = await queryAll(`
      SELECT signal_type_a, signal_type_b, cooccurrence_rate
      FROM signal_cooccurrence
      ORDER BY cooccurrence_rate DESC
      LIMIT ${CONTEXT_LIMITS.MAX_SIGNALS_RAW}
    `);
  } catch { /* table may be empty */ }

  // Signal half-life (capped)
  let halflife = [];
  try {
    halflife = await queryAll(`
      SELECT signal_type, peak_accuracy, half_life_hours, sample_size
      FROM signal_halflife
      ORDER BY sample_size DESC
      LIMIT ${CONTEXT_LIMITS.MAX_SIGNALS_RAW}
    `);
  } catch { /* table may be empty */ }

  // Crowding scores
  let crowding = [];
  try {
    crowding = await queryAll(`
      SELECT DISTINCT ON (template_id) template_id, crowding_score, assessment
      FROM crowding_scores ORDER BY template_id, computed_at DESC
    `);
  } catch { /* table may be empty */ }

  // Regime history
  const regimes = await queryAll(`
    SELECT regime, created_at
    FROM market_regime ORDER BY created_at DESC LIMIT 30
  `);

  const context = formatUserMessage({
    section1_market_data: {
      trade_stats_by_template: tradesByTemplate,
      signal_effectiveness: signalStats,
      recent_trades: recentTrades,
      signal_cooccurrence: cooccurrence,
      signal_halflife: halflife
    },
    section2_context: {
      templates,
      anti_patterns: antiPatterns,
      crowding_scores: crowding,
      regime_history: regimes
    },
    section3_memory: null,
    section4_task: `Weekly analysis. Evaluate signal effectiveness, discover winning combinations, detect anti-patterns, manage template lifecycle. Use cooccurrence matrix for independence. Respect half-life noise flags.`
  });
  return warnIfLarge('pattern_discovery', context);
}


// ============================================================================
// USER MESSAGE FORMATTER
// ============================================================================

function formatUserMessage({ section1_market_data, section2_context, section3_memory, section4_task }) {
  const parts = [];

  parts.push('=== MARKET DATA ===');
  parts.push(JSON.stringify(section1_market_data, null, 0));

  parts.push('\n=== CONTEXT ===');
  parts.push(JSON.stringify(section2_context, null, 0));

  if (section3_memory) {
    parts.push('\n=== ACTIVE LEARNINGS (apply these to your analysis) ===');
    parts.push(section3_memory);
  }

  parts.push('\n=== TASK ===');
  parts.push(section4_task);

  return parts.join('\n');
}


// ============================================================================
// EXPORTS
// ============================================================================

const CONTEXT_BUILDERS = {
  trendAgent: buildTrendContext,
  momentumAgent: buildMomentumContext,
  volatilityAgent: buildVolatilityContext,
  volumeAgent: buildVolumeContext,
  patternAgent: buildPatternContext,
  orderFlowAgent: buildOrderFlowContext,
  macroAgent: buildMacroContext,
  sentimentAgent: buildSentimentContext,
  strategySynthesizer: buildSynthesizerContext,
  riskManager: buildRiskManagerContext,
  positionReviewer: buildPositionReviewerContext,
  regimeClassifier: buildRegimeContext,
  performanceAnalyst: buildPerformanceAnalystContext,
  patternDiscovery: buildPatternDiscoveryContext,
};

module.exports = { CONTEXT_BUILDERS, CONTEXT_LIMITS, formatUserMessage };
