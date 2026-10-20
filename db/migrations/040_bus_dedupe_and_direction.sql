-- ============================================================================
-- Migration 040: Intelligence bus — idempotent publishing + ORACLE directions
-- Additive and idempotent (safe to re-run).
--
--  1. dedupe_key column + partial unique index  -> bus.publish({ dedupeKey }) is idempotent
--  2. direction CHECK widened to allow ORACLE's 'bull' / 'bear'.
--     Migration 023 only allowed long/short/neutral, so every ORACLE thesis publish
--     (direction 'bull'|'bear') failed the constraint and was swallowed by try/catch.
-- ============================================================================

ALTER TABLE intelligence_bus ADD COLUMN IF NOT EXISTS dedupe_key TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS uq_bus_dedupe_key
  ON intelligence_bus (dedupe_key)
  WHERE dedupe_key IS NOT NULL;

-- Lag / retention queries
CREATE INDEX IF NOT EXISTS idx_bus_type_created
  ON intelligence_bus (event_type, created_at DESC);

DO $$
DECLARE c record;
BEGIN
  FOR c IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'intelligence_bus'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) ILIKE '%direction%'
  LOOP
    EXECUTE format('ALTER TABLE intelligence_bus DROP CONSTRAINT %I', c.conname);
  END LOOP;

  ALTER TABLE intelligence_bus
    ADD CONSTRAINT intelligence_bus_direction_check_v2
    CHECK (direction IS NULL OR direction IN ('long', 'short', 'neutral', 'bull', 'bear'));
END $$;
