-- GRID — Full PostgreSQL Schema
-- Generated from GRID-V2-SPEC + GRID-ARCHITECT (70 ADRs)
-- 47 tables across 6 groups

BEGIN;

-- ============================================================
-- GROUP 1: CORE TABLES
-- ============================================================

-- ADR-031: Authentication & Security
CREATE TABLE users (
  id SERIAL PRIMARY KEY,
  username VARCHAR(50) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  email VARCHAR(255),
  refresh_token TEXT,
  refresh_token_expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Core: Portfolio holdings
CREATE TABLE portfolio_state (
  id SERIAL PRIMARY KEY,
  symbol VARCHAR(20) NOT NULL,
  asset_class VARCHAR(20) NOT NULL,
  exchange VARCHAR(30) NOT NULL,
  quantity NUMERIC(16,8) NOT NULL DEFAULT 0,
  avg_entry_price NUMERIC(16,8),
  current_price NUMERIC(16,8),
  unrealised_pnl NUMERIC(14,4) DEFAULT 0,
  unrealised_pnl_pct NUMERIC(8,4) DEFAULT 0,
  allocation_pct NUMERIC(5,2),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Core: Agent decision audit trail
CREATE TABLE agent_decisions (
  id SERIAL PRIMARY KEY,
  agent_name VARCHAR(50) NOT NULL,
  agent_layer VARCHAR(20) NOT NULL
    CHECK (agent_layer IN ('knowledge', 'strategy', 'analysis')),
  cycle_number INTEGER,
  model_used VARCHAR(30),
  input_tokens INTEGER,
  output_tokens INTEGER,
  cost_usd NUMERIC(8,4),
  reasoning TEXT,
  confidence_score NUMERIC(5,2),
  output_json JSONB,
  duration_ms INTEGER,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Core: Strategy templates (needed for trades FK)
CREATE TABLE strategy_templates (
  id SERIAL PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  description TEXT,
  entry_conditions JSONB NOT NULL,
  exit_conditions JSONB NOT NULL,
  valid_regimes JSONB,
  valid_asset_classes JSONB,
  valid_symbols JSONB,
  status VARCHAR(20) NOT NULL DEFAULT 'testing'
    CHECK (status IN ('testing', 'active', 'paused', 'retired')),
  source VARCHAR(30) DEFAULT 'pattern_discovery'
    CHECK (source IN ('pattern_discovery', 'manual', 'evolved')),
  trade_count INTEGER DEFAULT 0,
  promoted_at TIMESTAMPTZ,
  retired_at TIMESTAMPTZ,
  -- ADR-060: Validation fields
  walk_forward_pass BOOLEAN,
  monte_carlo_p NUMERIC(5,4),
  bootstrap_ci_lower NUMERIC(5,2),
  bootstrap_ci_upper NUMERIC(5,2),
  parameter_sensitivity JSONB,
  cost_sensitivity_breakeven NUMERIC(4,1),
  frozen_param_degradation NUMERIC(5,2),
  cross_asset_transfer_ratio NUMERIC(4,2),
  crowding_score NUMERIC(5,1),
  -- ADR-019: Multi-Timeframe Signal Confluence
  timeframe_requirements JSONB DEFAULT '{}',
  -- ADR-023: Edge Decay Tracking
  decay_analysis JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Core: Trade records
-- Columns from ADR-020, ADR-051, ADR-052, ADR-054, ADR-055, ADR-062
CREATE TABLE trades (
  id SERIAL PRIMARY KEY,
  symbol VARCHAR(20) NOT NULL,
  asset_class VARCHAR(20) NOT NULL,
  exchange VARCHAR(30) NOT NULL,
  side VARCHAR(10) NOT NULL CHECK (side IN ('buy', 'sell')),
  quantity NUMERIC(16,8) NOT NULL,
  entry_price NUMERIC(16,8) NOT NULL,
  exit_price NUMERIC(16,8),
  tp_price NUMERIC(16,8),
  sl_price NUMERIC(16,8),
  pnl_realised NUMERIC(14,4),
  pnl_pct NUMERIC(8,4),
  status VARCHAR(20) NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'closed', 'cancelled')),
  template_id INTEGER REFERENCES strategy_templates(id),
  execution_tier VARCHAR(20) NOT NULL DEFAULT 'ai_driven'
    CHECK (execution_tier IN ('ai_driven', 'standing_order', 'micro')),
  confidence NUMERIC(5,2),
  mode VARCHAR(20) NOT NULL DEFAULT 'paper'
    CHECK (mode IN ('paper', 'live', 'micro')),
  cycle_number INTEGER,
  agent_decision_id INTEGER REFERENCES agent_decisions(id),
  reasoning TEXT,
  bootstrap_phase VARCHAR(20),
  -- ADR-020: Confidence Calibration
  entry_confidence NUMERIC(5,2),
  -- ADR-051: Kelly Criterion
  kelly_optimal_pct NUMERIC(6,3),
  kelly_inputs JSONB,
  -- ADR-052: Trade Outcome Classification
  outcome_class VARCHAR(20)
    CHECK (outcome_class IN ('good_win', 'lucky_win', 'good_loss', 'bad_loss', 'premature_stop')),
  outcome_reasoning TEXT,
  post_close_price_reached_tp BOOLEAN,
  -- ADR-054: Signal Complexity Scoring
  complexity_score INTEGER,
  signal_domains JSONB,
  signal_timeframes JSONB,
  -- ADR-055: Market Impact Tracking
  expected_fill_price NUMERIC(16,8),
  actual_fill_price NUMERIC(16,8),
  slippage_bps NUMERIC(8,4),
  market_impact_bps NUMERIC(8,4),
  -- ADR-062: Signal Independence
  effective_independent_signals NUMERIC(4,1),
  adjusted_complexity_score NUMERIC(5,1),
  opened_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  closed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Core: OHLCV market data
CREATE TABLE market_data (
  id SERIAL PRIMARY KEY,
  symbol VARCHAR(20) NOT NULL,
  asset_class VARCHAR(20) NOT NULL,
  timeframe VARCHAR(10) NOT NULL,
  open NUMERIC(16,8) NOT NULL,
  high NUMERIC(16,8) NOT NULL,
  low NUMERIC(16,8) NOT NULL,
  close NUMERIC(16,8) NOT NULL,
  volume NUMERIC(20,4),
  indicators JSONB,
  timestamp TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(symbol, timeframe, timestamp)
);

-- Core: AI & service cost tracking
CREATE TABLE system_costs (
  id SERIAL PRIMARY KEY,
  service VARCHAR(30) NOT NULL,
  agent_name VARCHAR(50),
  model VARCHAR(30),
  input_tokens INTEGER,
  output_tokens INTEGER,
  cost_usd NUMERIC(8,4) NOT NULL,
  cycle_number INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Core: Market regime classification
-- Columns from ADR-027, ADR-053
CREATE TABLE market_regime (
  id SERIAL PRIMARY KEY,
  asset_class VARCHAR(20) NOT NULL,
  regime VARCHAR(30) NOT NULL
    CHECK (regime IN ('trending_up', 'trending_down', 'ranging', 'volatile', 'quiet')),
  confidence NUMERIC(5,2),
  evidence JSONB,
  agent_decision_id INTEGER REFERENCES agent_decisions(id),
  -- ADR-027: Adaptive Cycle Frequency
  recommended_cycle_interval VARCHAR(10) DEFAULT '4h',
  -- ADR-053: Regime Transition Probability
  transition_probabilities JSONB,
  transition_signals JSONB,
  highest_transition VARCHAR(30),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Core: Learning / insight store
-- Columns from ADR-056
CREATE TABLE learnings (
  id SERIAL PRIMARY KEY,
  insight_text TEXT NOT NULL,
  category VARCHAR(50) NOT NULL,
  confidence VARCHAR(10) DEFAULT 'med'
    CHECK (confidence IN ('high', 'med', 'low')),
  symbols JSONB,
  asset_classes JSONB,
  supporting_trade_ids INTEGER[],
  invalidated_by INTEGER REFERENCES learnings(id),
  invalidated_at TIMESTAMPTZ,
  source_agent VARCHAR(50),
  evidence JSONB,
  -- ADR-056: Knowledge Graph
  parent_learning_id INTEGER REFERENCES learnings(id),
  learning_type VARCHAR(30) DEFAULT 'observation'
    CHECK (learning_type IN ('principle', 'rule', 'observation', 'exception', 'hypothesis')),
  scope_level VARCHAR(20) DEFAULT 'specific'
    CHECK (scope_level IN ('universal', 'asset_class', 'symbol', 'template', 'specific')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Core: Economic / crypto events calendar
CREATE TABLE events_calendar (
  id SERIAL PRIMARY KEY,
  event_type VARCHAR(50) NOT NULL,
  event_name VARCHAR(200) NOT NULL,
  event_date TIMESTAMPTZ NOT NULL,
  impact_estimate VARCHAR(20) DEFAULT 'medium'
    CHECK (impact_estimate IN ('low', 'medium', 'high', 'critical')),
  affected_assets JSONB,
  notes TEXT,
  blackout_start TIMESTAMPTZ,
  blackout_end TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Core: Micro-trading strategy definitions
CREATE TABLE micro_strategies (
  id SERIAL PRIMARY KEY,
  strategy_name VARCHAR(50) NOT NULL UNIQUE,
  strategy_type VARCHAR(30) NOT NULL
    CHECK (strategy_type IN ('spread_capture', 'momentum_burst', 'orderbook_imbalance', 'vwap_reversion', 'liquidation_sweep')),
  parameters JSONB NOT NULL,
  max_position_pct NUMERIC(5,2) NOT NULL DEFAULT 1.0,
  valid_symbols JSONB,
  valid_regimes JSONB,
  enabled BOOLEAN DEFAULT true,
  performance_data JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);


-- ============================================================
-- GROUP 2: STRATEGY / SIGNAL TABLES
-- ============================================================

-- Signals emitted by knowledge agents
-- Columns from ADR-018
CREATE TABLE signals (
  id SERIAL PRIMARY KEY,
  agent_name VARCHAR(50) NOT NULL,
  agent_decision_id INTEGER REFERENCES agent_decisions(id),
  symbol VARCHAR(20) NOT NULL,
  asset_class VARCHAR(20) NOT NULL,
  signal_type VARCHAR(100) NOT NULL,
  signal_category VARCHAR(30) NOT NULL,
  direction VARCHAR(10) NOT NULL CHECK (direction IN ('bullish', 'bearish', 'neutral')),
  strength NUMERIC(5,2) NOT NULL,
  parameters JSONB,
  reasoning TEXT,
  cycle_number INTEGER,
  -- ADR-018: Signal Decay, TTL & Strength Degradation
  timeframe VARCHAR(10) NOT NULL DEFAULT '4h',
  ttl_candles INTEGER NOT NULL DEFAULT 6,
  expires_at TIMESTAMPTZ NOT NULL,
  decay_model VARCHAR(20) NOT NULL DEFAULT 'linear'
    CHECK (decay_model IN ('linear', 'cliff', 'exponential')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ADR-018: Index for Synthesizer's query on active signals
CREATE INDEX idx_signals_active ON signals(symbol, expires_at);

-- Template rolling performance snapshots
-- Column from ADR-023
CREATE TABLE template_performance (
  id SERIAL PRIMARY KEY,
  template_id INTEGER NOT NULL REFERENCES strategy_templates(id),
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,
  win_rate NUMERIC(5,2),
  sharpe NUMERIC(6,3),
  profit_factor NUMERIC(6,3),
  max_drawdown NUMERIC(5,2),
  avg_return_pct NUMERIC(6,3),
  total_trades INTEGER,
  total_pnl NUMERIC(14,4),
  calmar_ratio NUMERIC(6,3),
  sortino_ratio NUMERIC(6,3),
  expectancy NUMERIC(8,4),
  recovery_factor NUMERIC(6,3),
  tail_risk NUMERIC(8,4),
  concentration_ratio NUMERIC(5,2),
  outlier_dependent BOOLEAN DEFAULT false,
  -- ADR-023: Regime-Conditional
  regime VARCHAR(30),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Junction: which signals contributed to which trades
-- Column from ADR-018
CREATE TABLE trade_signals (
  id SERIAL PRIMARY KEY,
  trade_id INTEGER NOT NULL REFERENCES trades(id),
  signal_id INTEGER NOT NULL REFERENCES signals(id),
  was_entry_signal BOOLEAN NOT NULL DEFAULT true,
  -- ADR-018: Signal Decay
  strength_at_entry NUMERIC(5,2),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Discovered losing signal combinations
CREATE TABLE anti_patterns (
  id SERIAL PRIMARY KEY,
  name VARCHAR(100),
  signal_combination JSONB NOT NULL,
  lose_rate NUMERIC(5,2) NOT NULL,
  sample_size INTEGER NOT NULL,
  valid_regimes JSONB,
  valid_symbols JSONB,
  description TEXT,
  discovered_by VARCHAR(50) DEFAULT 'pattern_discovery',
  active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);


-- ============================================================
-- GROUP 3: MEMORY ENGINE TABLES
-- ============================================================

-- ADR-056: Knowledge Graph edges
CREATE TABLE learning_relationships (
  id SERIAL PRIMARY KEY,
  learning_a_id INTEGER NOT NULL REFERENCES learnings(id),
  learning_b_id INTEGER NOT NULL REFERENCES learnings(id),
  relationship VARCHAR(30) NOT NULL CHECK (relationship IN (
    'supports', 'contradicts', 'generalizes', 'specializes',
    'depends_on', 'replaces', 'complements'
  )),
  strength NUMERIC(3,2) DEFAULT 1.0,
  discovered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(learning_a_id, learning_b_id, relationship)
);

-- ADR-024: Meta-Learning — Memory Effectiveness
CREATE TABLE memory_effectiveness (
  id SERIAL PRIMARY KEY,
  learning_id INTEGER REFERENCES learnings(id),
  trade_id INTEGER REFERENCES trades(id),
  was_injected BOOLEAN NOT NULL,
  trade_outcome VARCHAR(20) NOT NULL,
  pnl_pct NUMERIC(8,4),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ADR-057: Temporal Memory — WHEN things work
CREATE TABLE temporal_patterns (
  id SERIAL PRIMARY KEY,
  pattern_type VARCHAR(30) NOT NULL CHECK (pattern_type IN (
    'hour_of_day', 'day_of_week', 'day_of_month', 'session',
    'pre_event', 'post_event', 'monthly_cycle'
  )),
  symbol VARCHAR(20),
  asset_class VARCHAR(20),
  template_id INTEGER REFERENCES strategy_templates(id),
  time_key VARCHAR(50) NOT NULL,
  sample_size INTEGER NOT NULL,
  win_rate NUMERIC(5,2),
  avg_return_pct NUMERIC(6,3),
  significance NUMERIC(5,4),
  active BOOLEAN DEFAULT true,
  discovered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_validated TIMESTAMPTZ
);

-- ADR-057: Sequence Memory — WHAT follows WHAT
CREATE TABLE sequence_patterns (
  id SERIAL PRIMARY KEY,
  trigger_event VARCHAR(100) NOT NULL,
  trigger_conditions JSONB,
  symbol VARCHAR(20),
  asset_class VARCHAR(20),
  typical_sequence JSONB NOT NULL,
  avg_time_to_resolution VARCHAR(20),
  directional_bias VARCHAR(10),
  bias_strength NUMERIC(5,2),
  sample_size INTEGER NOT NULL,
  discovered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_validated TIMESTAMPTZ,
  active BOOLEAN DEFAULT true
);

-- ADR-058: Analogical Memory — Market State Matching
CREATE TABLE market_snapshots (
  id SERIAL PRIMARY KEY,
  snapshot_type VARCHAR(20) NOT NULL CHECK (snapshot_type IN (
    'cycle', 'trade_entry', 'trade_exit', 'event'
  )),
  reference_id INTEGER,
  symbol VARCHAR(20) NOT NULL,
  feature_vector JSONB NOT NULL,
  outcome JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_snapshots_symbol ON market_snapshots(symbol, snapshot_type);

-- ADR-059: Asset Behaviour Profiles
CREATE TABLE asset_profiles (
  id SERIAL PRIMARY KEY,
  symbol VARCHAR(20) NOT NULL UNIQUE,
  asset_class VARCHAR(20) NOT NULL,
  profile_data JSONB NOT NULL,
  sample_size INTEGER NOT NULL,
  last_updated TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ADR-022: Cross-Asset Deep Pattern Memory
CREATE TABLE cross_asset_patterns (
  id SERIAL PRIMARY KEY,
  leader_symbol VARCHAR(20) NOT NULL,
  follower_symbol VARCHAR(20) NOT NULL,
  pattern_type VARCHAR(30) NOT NULL CHECK (pattern_type IN (
    'lead_lag', 'contagion', 'divergence_convergence', 'rotation', 'hedge'
  )),
  typical_lag VARCHAR(20),
  direction VARCHAR(20),
  conditions JSONB,
  strength NUMERIC(5,2),
  sample_size INTEGER NOT NULL,
  active_in_regimes JSONB,
  discovered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_validated TIMESTAMPTZ,
  active BOOLEAN DEFAULT true
);

-- ADR-021: Event Outcome Memory
CREATE TABLE event_outcomes (
  id SERIAL PRIMARY KEY,
  event_type VARCHAR(50) NOT NULL,
  event_date DATE NOT NULL,
  event_detail JSONB,
  surprise_direction VARCHAR(20),
  market_reactions JSONB NOT NULL,
  initial_reaction_correct BOOLEAN,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ADR-029: Exchange Behaviour Profiles
CREATE TABLE exchange_profiles (
  id SERIAL PRIMARY KEY,
  exchange VARCHAR(30) NOT NULL UNIQUE,
  profile_data JSONB NOT NULL,
  last_updated TIMESTAMPTZ NOT NULL DEFAULT NOW()
);


-- ============================================================
-- GROUP 4: RISK / VALIDATION TABLES
-- ============================================================

-- ADR-020: Confidence Calibration — per bracket snapshots
CREATE TABLE confidence_calibration (
  id SERIAL PRIMARY KEY,
  confidence_bracket INTEGER NOT NULL,
  sample_size INTEGER NOT NULL,
  predicted_avg NUMERIC(5,2) NOT NULL,
  actual_win_rate NUMERIC(5,2) NOT NULL,
  calibration_error NUMERIC(5,2) NOT NULL,
  adjustment_factor NUMERIC(5,4) NOT NULL,
  calculated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ADR-020: Confidence Calibration — overall tracking over time
CREATE TABLE calibration_history (
  id SERIAL PRIMARY KEY,
  overall_calibration_error NUMERIC(5,2) NOT NULL,
  brier_score NUMERIC(6,4) NOT NULL,
  sample_size INTEGER NOT NULL,
  bracket_data JSONB NOT NULL,
  calculated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ADR-020: Domain Confidence Profiles (per-agent accuracy)
CREATE TABLE agent_accuracy_profiles (
  id SERIAL PRIMARY KEY,
  agent_name VARCHAR(50) NOT NULL,
  domain VARCHAR(50) NOT NULL,
  total_signals INTEGER NOT NULL,
  signals_leading_to_trades INTEGER,
  trade_win_rate NUMERIC(5,2),
  avg_strength_when_right NUMERIC(5,2),
  avg_strength_when_wrong NUMERIC(5,2),
  false_positive_rate NUMERIC(5,2),
  last_computed TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(agent_name, domain)
);

-- ADR-022: Correlation-Aware Position Sizing
CREATE TABLE correlation_matrix (
  id SERIAL PRIMARY KEY,
  symbol_a VARCHAR(20) NOT NULL,
  symbol_b VARCHAR(20) NOT NULL,
  correlation NUMERIC(5,4) NOT NULL,
  lookback_days INTEGER NOT NULL DEFAULT 30,
  calculated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_correlation_latest ON correlation_matrix(calculated_at DESC);

-- ADR-061: Crisis-Mode Risk Reduction (SCRAM)
CREATE TABLE scram_events (
  id SERIAL PRIMARY KEY,
  level VARCHAR(20) NOT NULL CHECK (level IN ('elevated', 'crisis', 'emergency')),
  trigger_name VARCHAR(50) NOT NULL,
  trigger_value NUMERIC,
  threshold_value NUMERIC,
  activated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  cleared_at TIMESTAMPTZ,
  duration_seconds INTEGER
);

-- ADR-062: Signal Independence Measurement
CREATE TABLE signal_cooccurrence (
  id SERIAL PRIMARY KEY,
  signal_type_a VARCHAR(100) NOT NULL,
  signal_type_b VARCHAR(100) NOT NULL,
  cooccurrence_rate NUMERIC(5,4) NOT NULL,
  lookback_days INTEGER NOT NULL DEFAULT 90,
  computed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ADR-063: Information Half-Life Measurement
CREATE TABLE signal_halflife (
  id SERIAL PRIMARY KEY,
  signal_type VARCHAR(100) NOT NULL,
  symbol VARCHAR(20),
  timeframe VARCHAR(10) NOT NULL,
  peak_accuracy NUMERIC(5,4) NOT NULL,
  peak_horizon_candles INTEGER NOT NULL,
  halflife_candles INTEGER,
  accuracy_curve JSONB NOT NULL,
  sample_size INTEGER NOT NULL,
  computed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ADR-064: Bootstrap Capital Preservation Mode
CREATE TABLE bootstrap_status (
  id SERIAL PRIMARY KEY,
  phase VARCHAR(20) NOT NULL CHECK (phase IN ('infant', 'learning', 'maturing', 'graduated')),
  entered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  graduation_criteria_met JSONB,
  total_closed_trades INTEGER DEFAULT 0,
  system_age_days INTEGER DEFAULT 0
);

-- ADR-065: Counterparty Risk Management
CREATE TABLE exchange_health (
  id SERIAL PRIMARY KEY,
  exchange VARCHAR(30) NOT NULL,
  health_status VARCHAR(20) NOT NULL CHECK (health_status IN ('healthy', 'warning', 'critical', 'emergency')),
  signals JSONB NOT NULL,
  capital_allocated NUMERIC(14,2),
  capital_pct NUMERIC(5,2),
  checked_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ADR-066: Crowding Detection
CREATE TABLE crowding_scores (
  id SERIAL PRIMARY KEY,
  template_id INTEGER NOT NULL REFERENCES strategy_templates(id),
  crowding_score NUMERIC(5,1) NOT NULL,
  components JSONB NOT NULL,
  assessment VARCHAR(30) NOT NULL,
  computed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ADR-067: Path-Dependent Ruin Simulation
CREATE TABLE ruin_simulations (
  id SERIAL PRIMARY KEY,
  simulation_date DATE NOT NULL,
  kelly_fraction NUMERIC(5,3) NOT NULL,
  ruin_probability NUMERIC(5,4) NOT NULL,
  geometric_growth NUMERIC(6,4),
  variance_drag NUMERIC(6,4),
  p5_terminal NUMERIC(14,2),
  p95_terminal NUMERIC(14,2),
  median_max_drawdown NUMERIC(5,4),
  assessment VARCHAR(20) NOT NULL,
  full_results JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ADR-069: Strategy Interaction & Tail Correlation
CREATE TABLE strategy_interactions (
  id SERIAL PRIMARY KEY,
  template_a_id INTEGER NOT NULL REFERENCES strategy_templates(id),
  template_b_id INTEGER NOT NULL REFERENCES strategy_templates(id),
  normal_correlation NUMERIC(5,4),
  tail_correlation NUMERIC(5,4),
  correlation_asymmetry NUMERIC(5,4),
  drawdown_overlap_pct NUMERIC(5,2),
  hidden_risk BOOLEAN DEFAULT false,
  computed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);


-- ============================================================
-- GROUP 5: EXECUTION TABLES
-- ============================================================

-- ADR-028: Two-Tier Execution — Standing Orders
CREATE TABLE standing_orders (
  id SERIAL PRIMARY KEY,
  created_by_agent VARCHAR(50) NOT NULL,
  agent_decision_id INTEGER REFERENCES agent_decisions(id),
  symbol VARCHAR(20) NOT NULL,
  asset_class VARCHAR(20) NOT NULL,
  side VARCHAR(10) NOT NULL CHECK (side IN ('buy', 'sell')),
  conditions JSONB NOT NULL,
  execution_params JSONB NOT NULL,
  template_id INTEGER REFERENCES strategy_templates(id),
  confidence NUMERIC(5,2),
  calibrated_confidence NUMERIC(5,2),
  priority INTEGER DEFAULT 5,
  status VARCHAR(20) DEFAULT 'active' CHECK (status IN (
    'active', 'triggered', 'executed', 'cancelled', 'expired', 'failed_preflight'
  )),
  risk_validated_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  triggered_at TIMESTAMPTZ,
  executed_at TIMESTAMPTZ,
  trade_id INTEGER REFERENCES trades(id),
  cancellation_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_standing_orders_active
  ON standing_orders(symbol, status) WHERE status = 'active';

CREATE INDEX idx_standing_orders_expiry
  ON standing_orders(expires_at) WHERE status = 'active';

-- ADR-030: Tier 3 Micro-Trading Engine
CREATE TABLE micro_trading_sessions (
  id SERIAL PRIMARY KEY,
  agent_decision_id INTEGER REFERENCES agent_decisions(id),
  symbol VARCHAR(20) NOT NULL,
  strategy_name VARCHAR(50) NOT NULL,
  parameters JSONB NOT NULL,
  risk_budget JSONB NOT NULL,
  status VARCHAR(20) DEFAULT 'active' CHECK (status IN (
    'active', 'completed', 'stopped_loss', 'stopped_max_trades', 'expired', 'cancelled'
  )),
  trades_executed INTEGER DEFAULT 0,
  session_pnl NUMERIC(12,4) DEFAULT 0,
  session_pnl_pct NUMERIC(6,4) DEFAULT 0,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ended_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_micro_sessions_active
  ON micro_trading_sessions(symbol, status) WHERE status = 'active';

-- ADR-021: Event-Driven Agent Triggers
CREATE TABLE emergency_triggers (
  id SERIAL PRIMARY KEY,
  trigger_type VARCHAR(50) NOT NULL,
  symbol VARCHAR(20) NOT NULL,
  threshold_value NUMERIC(10,4),
  actual_value NUMERIC(10,4),
  agents_fired TEXT[] NOT NULL,
  cycle_id INTEGER,
  cooldown_until TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_emergency_cooldown
  ON emergency_triggers(symbol, trigger_type, cooldown_until);


-- ============================================================
-- GROUP 6: SYSTEM / UX / MISC TABLES
-- ============================================================

-- ADR-024: Meta-Learning System Evolution Tracking
CREATE TABLE system_evolution (
  id SERIAL PRIMARY KEY,
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,
  templates_created INTEGER,
  templates_promoted INTEGER,
  templates_retired INTEGER,
  avg_template_lifespan_days NUMERIC(6,1),
  new_template_win_rate NUMERIC(5,2),
  overall_win_rate NUMERIC(5,2),
  overall_sharpe NUMERIC(6,3),
  overall_profit_factor NUMERIC(6,3),
  calibration_error NUMERIC(5,2),
  brier_score NUMERIC(6,4),
  learning_count_active INTEGER,
  learning_count_invalidated INTEGER,
  avg_signal_hit_rate NUMERIC(5,2),
  total_ai_cost NUMERIC(8,2),
  cost_per_trade NUMERIC(6,2),
  evolution_score NUMERIC(5,2),
  analyst_notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ADR-026: Human-in-the-Loop Conviction System
CREATE TABLE human_convictions (
  id SERIAL PRIMARY KEY,
  symbol VARCHAR(20),
  asset_class VARCHAR(20),
  direction VARCHAR(10) CHECK (direction IN ('bullish', 'bearish', 'neutral')),
  conviction_strength INTEGER CHECK (conviction_strength BETWEEN 1 AND 5),
  reasoning TEXT,
  expires_at TIMESTAMPTZ NOT NULL,
  active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_convictions_active ON human_convictions(active, expires_at)
  WHERE active = true;

-- ADR-034: Notification System — Config
CREATE TABLE notification_config (
  id SERIAL PRIMARY KEY,
  channel VARCHAR(20) NOT NULL CHECK (channel IN ('telegram', 'email', 'webhook')),
  tier VARCHAR(20) NOT NULL,
  enabled BOOLEAN DEFAULT true,
  config JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ADR-034: Notification System — Log
CREATE TABLE notification_log (
  id SERIAL PRIMARY KEY,
  channel VARCHAR(20) NOT NULL,
  tier VARCHAR(20) NOT NULL,
  title VARCHAR(200) NOT NULL,
  body TEXT,
  delivered BOOLEAN DEFAULT false,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ADR-047: Manual Overrides
CREATE TABLE manual_overrides (
  id SERIAL PRIMARY KEY,
  action_type VARCHAR(50) NOT NULL,
  target_type VARCHAR(30) NOT NULL,
  target_id INTEGER,
  parameters JSONB,
  reasoning TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ADR-049: Benchmark Tracking
CREATE TABLE benchmark_tracking (
  id SERIAL PRIMARY KEY,
  benchmark_name VARCHAR(50) NOT NULL,
  date DATE NOT NULL,
  starting_value NUMERIC(14,2) NOT NULL,
  current_value NUMERIC(14,2) NOT NULL,
  return_pct NUMERIC(8,4) NOT NULL,
  UNIQUE(benchmark_name, date)
);

-- ADR-050: Rejected Opportunities
CREATE TABLE rejected_opportunities (
  id SERIAL PRIMARY KEY,
  cycle_number INTEGER NOT NULL,
  agent_decision_id INTEGER REFERENCES agent_decisions(id),
  rejected_by VARCHAR(50) NOT NULL,
  symbol VARCHAR(20) NOT NULL,
  asset_class VARCHAR(20),
  direction VARCHAR(10),
  template_id INTEGER REFERENCES strategy_templates(id),
  confidence NUMERIC(5,2),
  rejection_reason VARCHAR(100) NOT NULL,
  rejection_detail TEXT,
  signals_present JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_rejected_symbol ON rejected_opportunities(symbol, created_at DESC);
CREATE INDEX idx_rejected_reason ON rejected_opportunities(rejection_reason);

-- ADR-070: External Data Cache
CREATE TABLE external_data_cache (
  id SERIAL PRIMARY KEY,
  source VARCHAR(30) NOT NULL,
  metric VARCHAR(100) NOT NULL,
  symbol VARCHAR(20),
  data JSONB NOT NULL,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ttl_seconds INTEGER NOT NULL DEFAULT 300
);

CREATE INDEX idx_cache_source_metric ON external_data_cache(source, metric, symbol, fetched_at DESC);


-- ============================================================
-- SEED DATA
-- ============================================================

-- Initial bootstrap status (infant phase)
INSERT INTO bootstrap_status (phase, total_closed_trades, system_age_days)
VALUES ('infant', 0, 0);

COMMIT;
