-- ============================================================================
-- Migration 032: Risk hardening (orchestrator / risk-manager / system API)
-- Additive and idempotent.
--
--  1. trades.client_order_id  — idempotency key for execute-trade (engine dedupes on it)
--  2. trades.status           — allow 'close_failed' (live close rejected by exchange/engine;
--                               trade stays tracked and is retried, never closed in DB only)
--                               and 'pending' (live order row written BEFORE the exchange call)
--  3. scram_events.close_mode — optional 'losing' | 'all' request to also close positions
--  4. hwm_resets              — high-water-mark reset markers (replaces DELETE FROM equity_snapshots)
-- ============================================================================

ALTER TABLE trades ADD COLUMN IF NOT EXISTS client_order_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_trades_client_order_id
  ON trades (client_order_id) WHERE client_order_id IS NOT NULL;

ALTER TABLE trades DROP CONSTRAINT IF EXISTS trades_status_check;
ALTER TABLE trades ADD CONSTRAINT trades_status_check
  CHECK (status IN ('open', 'closed', 'cancelled', 'close_failed', 'pending'));

ALTER TABLE scram_events ADD COLUMN IF NOT EXISTS close_mode VARCHAR(20);

CREATE TABLE IF NOT EXISTS hwm_resets (
  id          SERIAL PRIMARY KEY,
  reset_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  old_hwm     NUMERIC(14,2),
  new_hwm     NUMERIC(14,2),
  reset_by    VARCHAR(100)
);
CREATE INDEX IF NOT EXISTS idx_hwm_resets_reset_at ON hwm_resets (reset_at DESC);
