-- 025: Make risk_validated_at nullable on standing_orders
-- Standing orders should NOT be marked as risk-validated at creation time.
-- Validation happens at trigger time after full pre-flight checks pass.

ALTER TABLE standing_orders ALTER COLUMN risk_validated_at DROP NOT NULL;

-- Clear fake validation timestamps on any active orders that haven't actually been risk-checked
UPDATE standing_orders
SET risk_validated_at = NULL
WHERE status = 'active' AND risk_validated_at IS NOT NULL;
