-- Migration 014: Add idempotency key to trades table
-- M-15: Prevents duplicate trades from retry scenarios

ALTER TABLE trades ADD COLUMN IF NOT EXISTS idempotency_key UUID;
CREATE UNIQUE INDEX IF NOT EXISTS idx_trades_idempotency_key ON trades(idempotency_key) WHERE idempotency_key IS NOT NULL;
