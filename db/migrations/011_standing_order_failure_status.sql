-- Migration 011: Add failure tracking to standing orders
-- Prevents unsafe revert-to-active pattern after execution failure

ALTER TABLE standing_orders
  ADD COLUMN IF NOT EXISTS failure_reason VARCHAR(100),
  ADD COLUMN IF NOT EXISTS failed_at TIMESTAMPTZ;
