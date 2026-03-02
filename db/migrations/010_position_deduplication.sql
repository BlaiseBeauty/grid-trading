-- Migration 010: Prevent duplicate open positions on the same symbol
-- Only one open trade per symbol at any time

CREATE UNIQUE INDEX IF NOT EXISTS idx_one_open_per_symbol
  ON trades (symbol)
  WHERE status = 'open';
