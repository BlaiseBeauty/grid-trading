BEGIN;

INSERT INTO strategy_templates (name, description, entry_conditions, exit_conditions, valid_regimes, valid_asset_classes, valid_symbols, status, source) VALUES
(
  'Ranging Market Short',
  'Bearish reversal from resistance in a ranging market. Multiple bearish signals align at the top of the range — liquidation cascade risk, OI divergence, and momentum failure. High-probability rejection play.',
  '{
    "required_signals": ["liquidation_cascade_risk", "oi_divergence_bearish"],
    "min_domains": 2,
    "conditions": [
      {"indicator": "rsi_14", "operator": ">", "value": 60, "description": "RSI elevated, approaching overbought"},
      {"indicator": "adx", "operator": "<", "value": 25, "description": "No strong trend — ranging confirmed"},
      {"signal_category": "order_flow", "min_strength": 60, "description": "Strong bearish order flow signal"}
    ]
  }'::jsonb,
  '{
    "take_profit_pct": 4.0,
    "stop_loss_pct": 2.0,
    "trailing_stop_pct": 1.5,
    "time_stop_hours": 48,
    "conditions": [
      {"indicator": "rsi_14", "operator": "<", "value": 25, "action": "partial_exit_50pct"},
      {"indicator": "close", "operator": ">", "expression": "sma_20", "action": "exit"}
    ]
  }'::jsonb,
  '["ranging", "volatile"]'::jsonb,
  '["crypto"]'::jsonb,
  '["BTC/USDT", "ETH/USDT", "SOL/USDT"]'::jsonb,
  'active',
  'manual'
),
(
  'Bearish Momentum Failure',
  'Price fails to make new highs in ranging market with bearish momentum divergence and sentiment extremes. Mean reversion short.',
  '{
    "required_signals": ["bearish_momentum", "cross_asset_divergence"],
    "min_domains": 2,
    "conditions": [
      {"indicator": "rsi_14", "operator": "<", "value": 50, "description": "RSI turning bearish"},
      {"signal_type": "sector_rotation", "description": "Sector rotation out of crypto"},
      {"signal_category": "macro", "direction": "bearish", "min_strength": 50, "description": "Macro confirming bearish"}
    ]
  }'::jsonb,
  '{
    "take_profit_pct": 3.5,
    "stop_loss_pct": 1.8,
    "trailing_stop_pct": 1.2,
    "time_stop_hours": 36,
    "conditions": [
      {"indicator": "rsi_14", "operator": "<", "value": 28, "action": "exit"},
      {"indicator": "macd_histogram", "operator": ">", "value": 0, "action": "exit"}
    ]
  }'::jsonb,
  '["ranging", "trending_down"]'::jsonb,
  '["crypto"]'::jsonb,
  '["BTC/USDT", "ETH/USDT", "SOL/USDT"]'::jsonb,
  'active',
  'manual'
)
ON CONFLICT (name) DO NOTHING;

COMMIT;
