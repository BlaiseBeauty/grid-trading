-- Fix: remove equity_snapshots outlier rows that cause phantom drawdown in COMPASS
-- Root cause: a single anomalous row with total_value ~60x actual balance is causing
-- COMPASS to compute 83% drawdown → lock into CASH posture → cap GRID at $1000/position
--
-- Safe rule: delete any row where total_value > 3× the median of the last 7 days.
-- The last 7 days reflect actual balance (~$9,981); 3× = ~$29,943 threshold.
-- The phantom ~$60k row is caught regardless of its age.

DO $$
DECLARE
  median_val  NUMERIC;
  deleted_cnt INT;
BEGIN
  SELECT PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY total_value)
    INTO median_val
    FROM equity_snapshots
   WHERE created_at > NOW() - INTERVAL '7 days';

  IF median_val IS NULL OR median_val <= 0 THEN
    RAISE NOTICE '[029] No recent equity snapshots found — skipping cleanup';
    RETURN;
  END IF;

  DELETE FROM equity_snapshots
   WHERE total_value > median_val * 3;
  GET DIAGNOSTICS deleted_cnt = ROW_COUNT;

  RAISE NOTICE '[029] Equity snapshot cleanup: median=%, threshold=%, deleted=% outlier row(s)',
    ROUND(median_val, 2), ROUND(median_val * 3, 2), deleted_cnt;
END $$;
