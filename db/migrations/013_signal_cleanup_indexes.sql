-- Migration 013: Add indexes for efficient signal cleanup and common queries
-- M-7: Signal expiry queries scan full table without these indexes

CREATE INDEX IF NOT EXISTS idx_signals_expires_at ON signals(expires_at) WHERE expires_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_signals_symbol_expires ON signals(symbol, expires_at);
CREATE INDEX IF NOT EXISTS idx_trades_status ON trades(status);
CREATE INDEX IF NOT EXISTS idx_agent_decisions_cycle ON agent_decisions(cycle_number);
