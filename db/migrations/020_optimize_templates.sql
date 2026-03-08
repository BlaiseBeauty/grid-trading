-- 020_optimize_templates.sql
-- Optimize strategy templates based on backtest results:
-- 1. Retire Ranging Market Short (anti-pattern, OOS Sharpe -9.28)
-- 2. Tighten Bullish Momentum Convergence SL (642 stops vs 330 TPs)
-- 3. Fix Bearish Breakdown conditions (never triggered - used unsupported expression comparisons)
-- 4. Fix Trend Pullback Entry (never triggered - used "near"/"between" operators)
-- 5. Fix Bearish Momentum Failure (never triggered - required unavailable signal types)

-- 1. Retire Ranging Market Short
UPDATE strategy_templates
SET status = 'retired', retired_at = NOW()
WHERE id = 6;

-- 2. Tighten Bullish Momentum Convergence: SL 2% → 1.5%, TP stays 4%, time_stop 72 → 48h
UPDATE strategy_templates
SET exit_conditions = '{
  "conditions": [
    {"value": 78, "action": "partial_exit_50pct", "operator": ">", "indicator": "rsi_14"},
    {"value": 0, "action": "tighten_stop", "operator": "<", "indicator": "macd_histogram"}
  ],
  "stop_loss_pct": 1.5,
  "take_profit_pct": 4,
  "time_stop_hours": 48,
  "trailing_stop_pct": 1.2
}'::jsonb,
updated_at = NOW()
WHERE id = 1;

-- 3. Fix Bearish Breakdown: replace expression comparisons with indicator-value conditions
UPDATE strategy_templates
SET entry_conditions = '{
  "conditions": [
    {"value": 45, "operator": "<", "indicator": "rsi_14", "description": "RSI bearish momentum"},
    {"value": 0, "operator": "<", "indicator": "macd_histogram", "description": "MACD histogram negative"},
    {"value": 25, "operator": ">", "indicator": "adx", "description": "Strong directional move"},
    {"value": 1.5, "operator": ">", "indicator": "volume_ratio", "description": "Above-average volume on breakdown"}
  ],
  "min_domains": 2,
  "required_signals": ["bearish_momentum", "trend_strength"]
}'::jsonb,
updated_at = NOW()
WHERE id = 2;

-- 4. Fix Trend Pullback Entry: replace near/between with standard operators
UPDATE strategy_templates
SET entry_conditions = '{
  "conditions": [
    {"value": 40, "operator": ">", "indicator": "rsi_14", "description": "RSI reset but not oversold (above 40)"},
    {"value": 60, "operator": "<", "indicator": "rsi_14", "description": "RSI not yet overbought (below 60)"},
    {"value": 25, "operator": ">", "indicator": "adx", "description": "Trend still strong"},
    {"value": 0, "operator": ">", "indicator": "macd_histogram", "description": "MACD histogram turning positive"}
  ],
  "min_domains": 2,
  "required_signals": ["trend_continuation", "momentum_recovery"]
}'::jsonb,
updated_at = NOW()
WHERE id = 5;

-- 5. Fix Bearish Momentum Failure: replace macro/sector signals with indicator conditions
UPDATE strategy_templates
SET entry_conditions = '{
  "conditions": [
    {"value": 50, "operator": "<", "indicator": "rsi_14", "description": "RSI turning bearish"},
    {"value": 0, "operator": "<", "indicator": "macd_histogram", "description": "MACD confirms bearish"},
    {"value": 20, "operator": ">", "indicator": "adx", "description": "Directional momentum present"}
  ],
  "min_domains": 2,
  "required_signals": ["bearish_momentum"]
}'::jsonb,
valid_regimes = '["trending_down", "volatile"]'::jsonb,
updated_at = NOW()
WHERE id = 7;
