-- 003_fixes_and_seeds.sql
-- Seed starter strategy templates so the Synthesizer can begin proposing paper trades.
-- These are conservative, well-known setups across different regimes.

BEGIN;

-- ============================================================
-- 1. Seed strategy templates
-- ============================================================

INSERT INTO strategy_templates (name, description, entry_conditions, exit_conditions, valid_regimes, valid_asset_classes, valid_symbols, status, source) VALUES

-- Template 1: Bullish Momentum Convergence
(
  'Bullish Momentum Convergence',
  'Multiple momentum indicators align bullish in an uptrend. RSI rising from oversold, MACD crossover, price above key SMAs. High-probability trend continuation.',
  '{
    "required_signals": ["bullish_momentum", "trend_alignment", "rsi_oversold_bounce"],
    "min_domains": 2,
    "conditions": [
      {"indicator": "rsi_14", "operator": ">", "value": 35, "description": "RSI recovering from oversold"},
      {"indicator": "macd_histogram", "operator": ">", "value": 0, "description": "MACD histogram positive"},
      {"indicator": "close", "operator": ">", "expression": "sma_50", "description": "Price above 50 SMA"},
      {"indicator": "adx", "operator": ">", "value": 20, "description": "Trend has strength"}
    ]
  }'::jsonb,
  '{
    "take_profit_pct": 4.0,
    "stop_loss_pct": 2.0,
    "trailing_stop_pct": 1.5,
    "time_stop_hours": 72,
    "conditions": [
      {"indicator": "rsi_14", "operator": ">", "value": 78, "action": "partial_exit_50pct"},
      {"indicator": "macd_histogram", "operator": "<", "value": 0, "action": "tighten_stop"}
    ]
  }'::jsonb,
  '["trending_up"]'::jsonb,
  '["crypto"]'::jsonb,
  '["BTC/USDT", "ETH/USDT", "SOL/USDT"]'::jsonb,
  'active',
  'manual'
),

-- Template 2: Bearish Breakdown
(
  'Bearish Breakdown',
  'Price breaks below key support with volume confirmation and bearish momentum. Short/exit setup in downtrending markets.',
  '{
    "required_signals": ["bearish_momentum", "support_break", "volume_confirmation"],
    "min_domains": 2,
    "conditions": [
      {"indicator": "close", "operator": "<", "expression": "sma_50", "description": "Price below 50 SMA"},
      {"indicator": "close", "operator": "<", "expression": "bb_lower", "description": "Price broke lower Bollinger Band"},
      {"indicator": "rsi_14", "operator": "<", "value": 40, "description": "RSI confirms bearish momentum"},
      {"indicator": "volume_ratio", "operator": ">", "value": 1.5, "description": "Above-average volume on breakdown"}
    ]
  }'::jsonb,
  '{
    "take_profit_pct": 5.0,
    "stop_loss_pct": 2.5,
    "trailing_stop_pct": 2.0,
    "time_stop_hours": 96,
    "conditions": [
      {"indicator": "rsi_14", "operator": "<", "value": 20, "action": "partial_exit_50pct"},
      {"indicator": "close", "operator": ">", "expression": "sma_20", "action": "exit"}
    ]
  }'::jsonb,
  '["trending_down", "volatile"]'::jsonb,
  '["crypto"]'::jsonb,
  '["BTC/USDT", "ETH/USDT", "SOL/USDT"]'::jsonb,
  'active',
  'manual'
),

-- Template 3: Mean Reversion Bounce
(
  'Mean Reversion Bounce',
  'Oversold conditions in a ranging market with bollinger band squeeze or touch. Price reverts to mean after extreme deviation.',
  '{
    "required_signals": ["oversold_extreme", "support_zone", "volatility_contraction"],
    "min_domains": 2,
    "conditions": [
      {"indicator": "rsi_14", "operator": "<", "value": 30, "description": "RSI deeply oversold"},
      {"indicator": "bb_pct", "operator": "<", "value": 0.05, "description": "Price near lower BB"},
      {"indicator": "adx", "operator": "<", "value": 25, "description": "No strong trend (ranging)"},
      {"indicator": "stoch_k", "operator": "<", "value": 20, "description": "Stochastic oversold"}
    ]
  }'::jsonb,
  '{
    "take_profit_pct": 3.0,
    "stop_loss_pct": 1.5,
    "trailing_stop_pct": 1.0,
    "time_stop_hours": 48,
    "conditions": [
      {"indicator": "bb_pct", "operator": ">", "value": 0.5, "action": "exit"},
      {"indicator": "rsi_14", "operator": ">", "value": 65, "action": "exit"}
    ]
  }'::jsonb,
  '["ranging", "quiet"]'::jsonb,
  '["crypto"]'::jsonb,
  '["BTC/USDT", "ETH/USDT", "SOL/USDT"]'::jsonb,
  'active',
  'manual'
),

-- Template 4: Volatility Expansion Breakout
(
  'Volatility Expansion Breakout',
  'Bollinger Band squeeze followed by expansion. Catches the start of a new move after a period of low volatility compression.',
  '{
    "required_signals": ["volatility_expansion", "breakout", "trend_emerging"],
    "min_domains": 2,
    "conditions": [
      {"indicator": "bb_bandwidth", "operator": "<", "value": 0.04, "lookback": "recent", "description": "Recent BB squeeze (low bandwidth)"},
      {"indicator": "bb_bandwidth", "operator": ">", "value": 0.03, "description": "Bandwidth now expanding"},
      {"indicator": "close", "operator": ">", "expression": "bb_upper", "description": "Price breaking above upper BB"},
      {"indicator": "volume_ratio", "operator": ">", "value": 1.3, "description": "Volume confirming breakout"}
    ]
  }'::jsonb,
  '{
    "take_profit_pct": 5.0,
    "stop_loss_pct": 2.0,
    "trailing_stop_pct": 1.5,
    "time_stop_hours": 96,
    "conditions": [
      {"indicator": "close", "operator": "<", "expression": "bb_mid", "action": "exit"},
      {"indicator": "adx", "operator": "<", "value": 15, "action": "exit"}
    ]
  }'::jsonb,
  '["quiet", "ranging"]'::jsonb,
  '["crypto"]'::jsonb,
  '["BTC/USDT", "ETH/USDT", "SOL/USDT"]'::jsonb,
  'active',
  'manual'
),

-- Template 5: Trend Pullback Entry
(
  'Trend Pullback Entry',
  'Enter on a pullback within an established uptrend. Price dips to dynamic support (20/50 SMA) then resumes. Lower risk entry than chasing breakouts.',
  '{
    "required_signals": ["trend_continuation", "pullback_support", "momentum_recovery"],
    "min_domains": 2,
    "conditions": [
      {"indicator": "close", "operator": ">", "expression": "sma_200", "description": "Long-term uptrend intact"},
      {"indicator": "close", "operator": "near", "expression": "sma_50", "tolerance_pct": 2, "description": "Price pulled back to 50 SMA"},
      {"indicator": "rsi_14", "operator": "between", "value": [40, 55], "description": "RSI reset but not oversold"},
      {"indicator": "adx", "operator": ">", "value": 25, "description": "Trend still strong"}
    ]
  }'::jsonb,
  '{
    "take_profit_pct": 4.5,
    "stop_loss_pct": 2.0,
    "trailing_stop_pct": 1.5,
    "time_stop_hours": 72,
    "conditions": [
      {"indicator": "close", "operator": "<", "expression": "sma_200", "action": "exit"},
      {"indicator": "rsi_14", "operator": ">", "value": 75, "action": "partial_exit_50pct"}
    ]
  }'::jsonb,
  '["trending_up"]'::jsonb,
  '["crypto"]'::jsonb,
  '["BTC/USDT", "ETH/USDT", "SOL/USDT"]'::jsonb,
  'active',
  'manual'
);

COMMIT;
