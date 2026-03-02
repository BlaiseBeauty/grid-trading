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
        ORDER BY timestamp DESC LIMIT 50
      `, [symbol, tf]);
    }

    contextParts.push({
      symbol,
      asset_class: assetClass,
      indicators: indicators?.data || {},
      price_data: priceData
    });
  }

  const memory = await getRelevantMemory('trendAgent', {
    symbols, assetClasses: [assetClass], regime: regime.regime,
    signalCategories: ['trend']
  });

  return formatUserMessage({
    section1_market_data: contextParts,
    section2_context: {
      regime: regime.regime,
      regime_confidence: regime.confidence,
    },
    section3_memory: memory,
    section4_task: `Analyse trend indicators for ${symbols.join(', ')} across 1h/4h/1d timeframes. Output signals in JSON.`
  });
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
        ORDER BY timestamp DESC LIMIT 50
      `, [symbol, tf]);
    }

    contextParts.push({ symbol, asset_class: assetClass, indicators: indicators?.data || {}, price_data: priceData });
  }

  const memory = await getRelevantMemory('momentumAgent', {
    symbols, assetClasses: [assetClass], regime: regime.regime,
    signalCategories: ['momentum']
  });

  return formatUserMessage({
    section1_market_data: contextParts,
    section2_context: { regime: regime.regime, regime_confidence: regime.confidence },
    section3_memory: memory,
    section4_task: `Analyse momentum/oscillator indicators for ${symbols.join(', ')}. Identify divergences, oversold/overbought extremes, and multi-indicator alignment. Output signals in JSON.`
  });
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
        ORDER BY timestamp DESC LIMIT 50
      `, [symbol, tf]);
    }

    contextParts.push({ symbol, asset_class: assetClass, indicators: indicators?.data || {}, price_data: priceData });
  }

  const memory = await getRelevantMemory('volatilityAgent', {
    symbols, assetClasses: [assetClass], regime: regime.regime,
    signalCategories: ['volatility']
  });

  return formatUserMessage({
    section1_market_data: contextParts,
    section2_context: { regime: regime.regime, regime_confidence: regime.confidence },
    section3_memory: memory,
    section4_task: `Analyse volatility indicators for ${symbols.join(', ')}. Focus on squeezes, expansion/contraction, breakouts, and volatility regime changes. Output signals in JSON.`
  });
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
        ORDER BY timestamp DESC LIMIT 50
      `, [symbol, tf]);
    }

    contextParts.push({ symbol, asset_class: assetClass, indicators: indicators?.data || {}, price_data: priceData });
  }

  const memory = await getRelevantMemory('volumeAgent', {
    symbols, assetClasses: [assetClass], regime: regime.regime,
    signalCategories: ['volume']
  });

  return formatUserMessage({
    section1_market_data: contextParts,
    section2_context: { regime: regime.regime, regime_confidence: regime.confidence },
    section3_memory: memory,
    section4_task: `Analyse volume indicators for ${symbols.join(', ')}. Identify OBV divergences, VWAP levels, volume profile S/R, accumulation/distribution, and volume surges. Output signals in JSON.`
  });
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
        ORDER BY timestamp DESC LIMIT 100
      `, [symbol, tf]);
    }

    // Asset profile for false breakout rates
    let profile = null;
    try {
      profile = await queryOne(`
        SELECT profile_data FROM asset_profiles WHERE symbol = $1
      `, [symbol]);
    } catch { /* table may be empty */ }

    contextParts.push({
      symbol, asset_class: assetClass,
      indicators: indicators?.data || {},
      price_data: priceData,
      asset_profile: profile?.profile_data || null,
      noise_flagged_patterns: noiseFlagged
    });
  }

  const memory = await getRelevantMemory('patternAgent', {
    symbols, assetClasses: [assetClass], regime: regime.regime,
    signalCategories: ['pattern']
  });

  return formatUserMessage({
    section1_market_data: contextParts,
    section2_context: { regime: regime.regime, regime_confidence: regime.confidence },
    section3_memory: memory,
    section4_task: `Identify candlestick, chart, harmonic patterns and key S/R structure for ${symbols.join(', ')}. Deprioritise noise-flagged pattern types. Output signals in JSON.`
  });
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
      ORDER BY timestamp DESC LIMIT 48
    `, [symbol]);

    contextParts.push({
      symbol, asset_class: assetClass,
      coinglass_data: symbolCG,
      price_data_1h: priceData
    });
  }

  const memory = await getRelevantMemory('orderFlowAgent', {
    symbols, assetClasses: [assetClass], regime: regime.regime,
    signalCategories: ['order_flow']
  });

  return formatUserMessage({
    section1_market_data: {
      per_symbol: contextParts,
      aggregated: coinglass
    },
    section2_context: { regime: regime.regime, regime_confidence: regime.confidence },
    section3_memory: memory,
    section4_task: `Analyse order flow and derivatives data for ${symbols.join(', ')}. Focus on liquidation clusters, funding extremes, OI divergences, and positioning. Output signals in JSON.`
  });
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
  const crossAsset = {};
  for (const sym of ['BTC/USDT', 'SPY', 'GLD', 'DXY']) {
    crossAsset[sym] = await queryAll(`
      SELECT close, timestamp FROM market_data
      WHERE symbol = $1 AND timeframe = '1d'
      ORDER BY timestamp DESC LIMIT 30
    `, [sym]);
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

  const memory = await getRelevantMemory('macroAgent', {
    symbols, assetClasses: [assetClass], regime: regime.regime,
    signalCategories: ['macro', 'on_chain']
  });

  return formatUserMessage({
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

  // Fear & Greed
  const fearGreed = await getExternalData('alternative_me', ['fear_greed_index']);

  const memory = await getRelevantMemory('sentimentAgent', {
    symbols, assetClasses: [assetClass], regime: regime.regime,
    signalCategories: ['sentiment']
  });

  return formatUserMessage({
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

  // Top 50 active signals by decayed strength (was: all, often 200+)
  const rawSignals = await getActiveSignals(null, '6 hours', 50);

  // Slim signal payload — drop parameters, agent_name, agent_decision_id, etc.
  const signals = rawSignals.map(s => ({
    id: s.id,
    symbol: s.symbol,
    signal_type: s.signal_type,
    signal_category: s.signal_category,
    direction: s.direction,
    strength: s.strength,
    decayed_strength: s.decayed_strength,
    timeframe: s.timeframe,
    reasoning: s.reasoning,
  }));

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
  `);

  // Anti-patterns
  const antiPatterns = await queryAll(`
    SELECT description, signal_combination, lose_rate, valid_regimes
    FROM anti_patterns WHERE active = true
  `);

  // Recent trades (was: 20, now: 10)
  const recentTrades = await getRecentTrades(10);

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
  const memory = await getRelevantMemory('strategySynthesizer', {
    symbols: [...new Set(signals.map(s => s.symbol))],
    assetClasses: ['crypto'],
    regime: regime.regime,
    signalCategories: [...new Set(signals.map(s => s.signal_category))]
  });

  return formatUserMessage({
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
      recent_trades: recentTrades,
      upcoming_events: events,
      calibration_data: calibration,
      scram_state: scram,
      bootstrap_phase: bootstrap
    },
    section3_memory: memory,
    section4_task: `Match active signals against templates. Generate trade proposals, standing orders, or explain why no action. Full reasoning required.`
  });
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

  // Risk limits config
  let riskLimits = {};
  try { riskLimits = require('../config/risk-limits'); } catch { /* may not exist */ }

  // Ruin simulation latest
  let ruin = null;
  try {
    ruin = await queryOne(`
      SELECT kelly_fraction, ruin_probability, assessment
      FROM ruin_simulations ORDER BY simulation_date DESC LIMIT 1
    `);
  } catch { /* table may be empty */ }

  // Memory (800 token budget)
  const memory = await getRelevantMemory('riskManager', {
    symbols: heldSymbols,
    assetClasses: [...new Set((portfolio.positions || []).map(p => p.asset_class))],
    regime: (await getCurrentRegime()).regime,
    signalCategories: ['risk']
  });

  return formatUserMessage({
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
}


async function buildRegimeContext(trigger) {
  // 30-day price data for key assets
  const assets = ['BTC/USDT', 'ETH/USDT', 'SPY', 'DXY', 'GLD'];
  const priceData = {};
  for (const sym of assets) {
    priceData[sym] = await queryAll(`
      SELECT open, high, low, close, volume, timestamp
      FROM market_data WHERE symbol = $1 AND timeframe = '1d'
      ORDER BY timestamp DESC LIMIT 30
    `, [sym]);
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

  return formatUserMessage({
    section1_market_data: {
      price_data_30d: priceData,
      volatility_metrics: volatility?.data || {},
      mvrv_data: mvrv,
      vix_data: vix,
      correlations
    },
    section2_context: {
      regime_history: regimeHistory
    },
    section3_memory: null,
    section4_task: `Classify current market regime. Estimate transition probabilities for next 7 days. Include MVRV cycle overlay.`
  });
}


// ============================================================================
// POSITION REVIEWER CONTEXT BUILDER
// ============================================================================

async function buildPositionReviewerContext(trigger) {
  // Open trades with linked entry signals
  const openTrades = await queryAll(`
    SELECT t.*,
           EXTRACT(EPOCH FROM (NOW() - t.opened_at)) / 3600 AS hours_held,
           json_agg(json_build_object(
             'signal_id', s.id,
             'signal_type', s.signal_type,
             'signal_category', s.signal_category,
             'direction', s.direction,
             'strength', s.strength,
             'expires_at', s.expires_at,
             'expired', s.expires_at < NOW()
           )) FILTER (WHERE s.id IS NOT NULL) AS entry_signals
    FROM trades t
    LEFT JOIN trade_signals ts ON ts.trade_id = t.id
    LEFT JOIN signals s ON s.id = ts.signal_id
    WHERE t.status = 'open'
    GROUP BY t.id
    ORDER BY t.opened_at DESC
  `);

  // Skip if no open positions
  if (!openTrades || openTrades.length === 0) return null;

  const heldSymbols = [...new Set(openTrades.map(t => t.symbol))];

  // Current active signals per held symbol (fresh from this cycle)
  const activeSignals = {};
  for (const symbol of heldSymbols) {
    activeSignals[symbol] = await getActiveSignals(symbol, '6 hours', 20);
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

  // Risk limits config
  let riskLimits = {};
  try { riskLimits = require('../config/risk-limits'); } catch { /* may not exist */ }

  // Memory injection (800 token budget)
  const memory = await getRelevantMemory('positionReviewer', {
    symbols: heldSymbols,
    assetClasses: ['crypto'],
    regime: regime.regime,
    signalCategories: ['risk']
  });

  return formatUserMessage({
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
}


// ============================================================================
// ANALYSIS AGENT CONTEXT BUILDERS
// ============================================================================

async function buildPerformanceAnalystContext(trigger) {
  // All trades closed today
  const todayTrades = await queryAll(`
    SELECT t.*, ts.signal_id,
           s.signal_type, s.signal_category, s.direction as signal_direction, s.strength as signal_strength
    FROM trades t
    LEFT JOIN trade_signals ts ON ts.trade_id = t.id
    LEFT JOIN signals s ON s.id = ts.signal_id
    WHERE t.closed_at > NOW() - INTERVAL '24 hours'
    ORDER BY t.closed_at DESC
  `);

  // Open positions
  const openPositions = await queryAll(`
    SELECT * FROM trades WHERE status = 'open' ORDER BY opened_at
  `);

  // Template performance
  const templates = await queryAll(`
    SELECT st.id, st.name, st.status,
           tp.win_rate, tp.avg_return_pct, tp.total_trades, tp.sharpe,
           tp.max_drawdown, tp.concentration_ratio, tp.outlier_dependent
    FROM strategy_templates st
    LEFT JOIN template_performance tp ON tp.template_id = st.id
    WHERE st.status IN ('active', 'testing', 'paused')
  `);

  // Active learnings
  const learnings = await queryAll(`
    SELECT id, insight_text, category, confidence, learning_type,
           created_at, updated_at
    FROM learnings WHERE invalidated_at IS NULL
    ORDER BY confidence DESC, updated_at DESC LIMIT 50
  `);

  // Calibration
  const calibration = await queryAll(`
    SELECT * FROM confidence_calibration ORDER BY confidence_bracket
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
    `);
  } catch { /* table may be empty */ }

  // SCRAM events today
  let scramEvents = [];
  try {
    scramEvents = await queryAll(`
      SELECT * FROM scram_events WHERE activated_at > NOW() - INTERVAL '24 hours'
    `);
  } catch { /* table may be empty */ }

  return formatUserMessage({
    section1_market_data: {
      trades_closed_today: todayTrades,
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
}


async function buildPatternDiscoveryContext(trigger) {
  // All trades from last 30 days with signal attribution
  const trades = await queryAll(`
    SELECT t.id, t.symbol, t.side, t.pnl_pct, t.template_id,
           t.outcome_class, t.asset_class,
           t.entry_confidence, t.effective_independent_signals, t.complexity_score,
           t.opened_at, t.closed_at,
           json_agg(json_build_object(
             'signal_type', s.signal_type,
             'signal_category', s.signal_category,
             'direction', s.direction,
             'strength', s.strength,
             'was_entry', ts.was_entry_signal
           )) as signals_at_entry
    FROM trades t
    JOIN trade_signals ts ON ts.trade_id = t.id
    JOIN signals s ON s.id = ts.signal_id
    WHERE t.closed_at > NOW() - INTERVAL '30 days'
    AND t.status = 'closed'
    GROUP BY t.id
    ORDER BY t.closed_at DESC
  `);

  // Current templates
  const templates = await queryAll(`
    SELECT st.*, tp.win_rate, tp.avg_return_pct, tp.total_trades,
           tp.sharpe, tp.concentration_ratio, tp.outlier_dependent
    FROM strategy_templates st
    LEFT JOIN template_performance tp ON tp.template_id = st.id
    WHERE st.status != 'retired'
  `);

  // Anti-patterns
  const antiPatterns = await queryAll(`SELECT * FROM anti_patterns WHERE active = true`);

  // Signal cooccurrence
  let cooccurrence = [];
  try {
    cooccurrence = await queryAll(`SELECT * FROM signal_cooccurrence`);
  } catch { /* table may be empty */ }

  // Signal half-life (noise detection)
  let halflife = [];
  try {
    halflife = await queryAll(`SELECT * FROM signal_halflife`);
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

  return formatUserMessage({
    section1_market_data: {
      trades_30d: trades,
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

module.exports = { CONTEXT_BUILDERS, formatUserMessage };
