-- Confidence Calibration Pipeline: add missing columns to existing table
-- The confidence_calibration table exists (001_initial_schema.sql) but needs
-- bucket-label and avg_pnl columns for the calibration pipeline.

ALTER TABLE confidence_calibration ADD COLUMN IF NOT EXISTS confidence_bucket VARCHAR(10);
ALTER TABLE confidence_calibration ADD COLUMN IF NOT EXISTS avg_pnl NUMERIC(14,4);

-- Add unique constraint on confidence_bracket so we can upsert per bucket
-- (confidence_bracket stores the bucket lower bound: 50, 55, 60, 65, 70, 75, 80)
CREATE UNIQUE INDEX IF NOT EXISTS idx_calibration_bracket_unique
  ON confidence_calibration (confidence_bracket);
