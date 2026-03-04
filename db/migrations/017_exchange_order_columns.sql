-- Exchange-side order tracking for live trading
-- Stores exchange order IDs for entry, stop-loss, and take-profit orders
ALTER TABLE trades ADD COLUMN IF NOT EXISTS exchange_entry_order_id VARCHAR(100);
ALTER TABLE trades ADD COLUMN IF NOT EXISTS exchange_sl_order_id VARCHAR(100);
ALTER TABLE trades ADD COLUMN IF NOT EXISTS exchange_tp_order_id VARCHAR(100);

-- Index for finding trades with active exchange orders
CREATE INDEX IF NOT EXISTS idx_trades_exchange_orders
  ON trades (status)
  WHERE exchange_sl_order_id IS NOT NULL OR exchange_tp_order_id IS NOT NULL;
