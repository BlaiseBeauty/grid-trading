-- ============================================================================
-- Migration 030: Trailing Stop — peak price tracking on open trades
-- ============================================================================

ALTER TABLE trades
  ADD COLUMN IF NOT EXISTS peak_price NUMERIC(20, 8),
  ADD COLUMN IF NOT EXISTS trail_activated BOOLEAN NOT NULL DEFAULT FALSE;
