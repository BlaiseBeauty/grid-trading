-- 022_new_strategy_templates.sql
-- Add new strategy templates to improve diversity and risk-reward
-- Focus: wider TP:SL ratios, better regime targeting, long-side balance

-- 1. Strong Trend Momentum Long — High-conviction trend continuation
--    Only triggers in strong uptrends with aligned indicators
--    3:1 reward-to-risk ratio
INSERT INTO strategy_templates (name, entry_conditions, exit_conditions, valid_regimes, status)
VALUES (
  'Strong Trend Momentum Long',
  '{
    "conditions": [
      {"value": 55, "operator": ">", "indicator": "rsi_14", "description": "RSI above midline showing bullish momentum"},
      {"value": 30, "operator": ">", "indicator": "adx", "description": "Strong trend in place"},
      {"value": 0, "operator": ">", "indicator": "macd_histogram", "description": "MACD histogram positive"},
      {"value": 1.2, "operator": ">", "indicator": "volume_ratio", "description": "Above-average volume confirming move"}
    ],
    "min_domains": 3,
    "required_signals": ["trend_strength", "bullish_momentum"]
  }'::jsonb,
  '{
    "stop_loss_pct": 2.0,
    "take_profit_pct": 6.0,
    "trailing_stop_pct": 1.8,
    "time_stop_hours": 72
  }'::jsonb,
  '["trending_up"]'::jsonb,
  'active'
);

-- 2. Oversold Bounce Play — Mean reversion with relaxed entry
--    Template #3 (Mean Reversion Bounce) only triggered once because RSI<30 + BB<0.05 too restrictive
--    This uses looser thresholds
INSERT INTO strategy_templates (name, entry_conditions, exit_conditions, valid_regimes, status)
VALUES (
  'Oversold Bounce Play',
  '{
    "conditions": [
      {"value": 35, "operator": "<", "indicator": "rsi_14", "description": "RSI in oversold territory"},
      {"value": 0, "operator": "<", "indicator": "macd_histogram", "description": "MACD still negative (catching reversal)"},
      {"value": 20, "operator": "<", "indicator": "adx", "description": "Weak trend (range-bound market)"}
    ],
    "min_domains": 2,
    "required_signals": ["oversold_extreme"]
  }'::jsonb,
  '{
    "stop_loss_pct": 1.5,
    "take_profit_pct": 3.0,
    "trailing_stop_pct": 1.0,
    "time_stop_hours": 36
  }'::jsonb,
  '["ranging", "volatile"]'::jsonb,
  'active'
);

-- 3. Volatility Regime Shift Long — Catches transition from quiet to trending up
--    Uses volume expansion + emerging trend signals
INSERT INTO strategy_templates (name, entry_conditions, exit_conditions, valid_regimes, status)
VALUES (
  'Volatility Regime Shift Long',
  '{
    "conditions": [
      {"value": 50, "operator": ">", "indicator": "rsi_14", "description": "RSI above neutral"},
      {"value": 20, "operator": ">", "indicator": "adx", "description": "Directional movement emerging"},
      {"value": 1.5, "operator": ">", "indicator": "volume_ratio", "description": "Volume surge confirming breakout"}
    ],
    "min_domains": 2,
    "required_signals": ["volatility_expansion", "trend_emerging"]
  }'::jsonb,
  '{
    "stop_loss_pct": 2.5,
    "take_profit_pct": 7.5,
    "trailing_stop_pct": 2.0,
    "time_stop_hours": 96
  }'::jsonb,
  '["volatile", "ranging"]'::jsonb,
  'active'
);

-- 4. Bearish Exhaustion Short — Catches overbought reversals in downtrends
--    High RSI + weak volume = exhaustion rally in bear market
INSERT INTO strategy_templates (name, entry_conditions, exit_conditions, valid_regimes, status)
VALUES (
  'Bearish Exhaustion Short',
  '{
    "conditions": [
      {"value": 65, "operator": ">", "indicator": "rsi_14", "description": "RSI overbought in downtrend (relief rally)"},
      {"value": 25, "operator": ">", "indicator": "adx", "description": "Underlying trend still strong"},
      {"value": 0, "operator": ">", "indicator": "macd_histogram", "description": "MACD temporarily positive (fakeout)"}
    ],
    "min_domains": 2,
    "required_signals": ["bearish_momentum"]
  }'::jsonb,
  '{
    "stop_loss_pct": 2.0,
    "take_profit_pct": 5.0,
    "trailing_stop_pct": 1.5,
    "time_stop_hours": 48
  }'::jsonb,
  '["trending_down"]'::jsonb,
  'active'
);

-- 5. Ranging Scalp Long — Quick mean reversion in range-bound markets
--    Tight SL, moderate TP, short time stop
INSERT INTO strategy_templates (name, entry_conditions, exit_conditions, valid_regimes, status)
VALUES (
  'Ranging Scalp Long',
  '{
    "conditions": [
      {"value": 40, "operator": "<", "indicator": "rsi_14", "description": "RSI near lower range"},
      {"value": 20, "operator": "<", "indicator": "adx", "description": "Weak trend = ranging market"},
      {"value": 0, "operator": ">", "indicator": "macd_histogram", "description": "MACD turning positive (bounce starting)"}
    ],
    "min_domains": 2,
    "required_signals": ["momentum_recovery"]
  }'::jsonb,
  '{
    "stop_loss_pct": 1.2,
    "take_profit_pct": 2.5,
    "trailing_stop_pct": 0.8,
    "time_stop_hours": 24
  }'::jsonb,
  '["ranging"]'::jsonb,
  'active'
);
