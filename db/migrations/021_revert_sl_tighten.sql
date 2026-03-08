-- 021_revert_sl_tighten.sql
-- Revert Bullish Momentum Convergence SL back to 2% (tighter 1.5% hurt win rate)
-- Keep Ranging Market Short retired

UPDATE strategy_templates
SET exit_conditions = '{
  "conditions": [
    {"value": 78, "action": "partial_exit_50pct", "operator": ">", "indicator": "rsi_14"},
    {"value": 0, "action": "tighten_stop", "operator": "<", "indicator": "macd_histogram"}
  ],
  "stop_loss_pct": 2,
  "take_profit_pct": 4,
  "time_stop_hours": 48,
  "trailing_stop_pct": 1.5
}'::jsonb,
updated_at = NOW()
WHERE id = 1;
