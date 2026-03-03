-- Migration 012: Fix standing_orders CHECK constraint
-- Add 'failed' and 'pending_retry' to allowed status values.
-- The code already uses these statuses (standing-orders.js markFailed/markPendingRetry)
-- but the CHECK constraint from 001_initial_schema.sql didn't include them.

BEGIN;

ALTER TABLE standing_orders DROP CONSTRAINT IF EXISTS standing_orders_status_check;

ALTER TABLE standing_orders
  ADD CONSTRAINT standing_orders_status_check
  CHECK (status IN (
    'active', 'triggered', 'executed', 'cancelled', 'expired',
    'failed_preflight', 'failed', 'pending_retry'
  ));

COMMIT;
