-- Performance indexes on hot query paths

-- trades (no indexes existed)
CREATE INDEX IF NOT EXISTS idx_trades_status ON trades(status);
CREATE INDEX IF NOT EXISTS idx_trades_symbol_status ON trades(symbol, status);
CREATE INDEX IF NOT EXISTS idx_trades_opened_at ON trades(opened_at DESC);
CREATE INDEX IF NOT EXISTS idx_trades_closed_at ON trades(closed_at DESC);

-- signals (only idx_signals_active on symbol,expires_at existed)
CREATE INDEX IF NOT EXISTS idx_signals_created_at ON signals(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_signals_cycle ON signals(cycle_number);

-- standing_orders (only partial indexes on active orders existed)
CREATE INDEX IF NOT EXISTS idx_standing_orders_status ON standing_orders(status);

-- position_reviews (trade_id + cycle_number existed, need created_at)
CREATE INDEX IF NOT EXISTS idx_position_reviews_created ON position_reviews(created_at DESC);
