-- ============================================================================
-- Migration 041: AI cost status, health components, agent_decisions source_system
-- Additive and idempotent (safe to re-run).
--
--  1. platform_ai_costs.status / error  -> failed + truncated calls are recorded too
--  2. platform_system_health: next_cycle_at column; allow 'oracle_ingestion' component so
--     ingestion no longer overwrites the ORACLE cycle heartbeat
--  3. agent_decisions.source_system -> ORACLE/COMPASS rows no longer pollute GRID analytics
--     (GRID analytics should filter source_system = 'grid')
-- ============================================================================

-- 1. AI cost rows
ALTER TABLE platform_ai_costs ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'ok';
ALTER TABLE platform_ai_costs ADD COLUMN IF NOT EXISTS error  TEXT;
CREATE INDEX IF NOT EXISTS idx_pac_created ON platform_ai_costs (created_at DESC);

-- 2. System health
ALTER TABLE platform_system_health ADD COLUMN IF NOT EXISTS next_cycle_at TIMESTAMPTZ;

DO $$
DECLARE c record;
BEGIN
  FOR c IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'platform_system_health'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) ILIKE '%system_name%'
  LOOP
    EXECUTE format('ALTER TABLE platform_system_health DROP CONSTRAINT %I', c.conname);
  END LOOP;

  ALTER TABLE platform_system_health
    ADD CONSTRAINT platform_system_health_system_name_check_v2
    CHECK (system_name IN ('grid', 'compass', 'oracle', 'oracle_ingestion'));
END $$;

-- 3. agent_decisions provenance
ALTER TABLE agent_decisions ADD COLUMN IF NOT EXISTS source_system VARCHAR(20) NOT NULL DEFAULT 'grid';
CREATE INDEX IF NOT EXISTS idx_agent_decisions_source ON agent_decisions (source_system, created_at DESC);

-- Backfill rows written by ORACLE / COMPASS base agents before this migration
UPDATE agent_decisions SET source_system = 'oracle'
 WHERE source_system = 'grid' AND agent_name LIKE 'oracle-%';
UPDATE agent_decisions SET source_system = 'compass'
 WHERE source_system = 'grid' AND agent_name LIKE 'compass-%';
