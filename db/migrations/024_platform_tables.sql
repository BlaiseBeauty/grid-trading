-- Platform Notifications: unified alerts across all systems
CREATE TABLE IF NOT EXISTS platform_notifications (
  id              SERIAL PRIMARY KEY,
  source_system   VARCHAR(20) NOT NULL CHECK (source_system IN ('grid', 'compass', 'oracle', 'platform')),
  type            VARCHAR(40) NOT NULL,
  title           VARCHAR(200) NOT NULL,
  body            TEXT,
  urgency         VARCHAR(10) NOT NULL DEFAULT 'info' CHECK (urgency IN ('info', 'warning', 'critical')),
  metadata        JSONB DEFAULT '{}',
  read_at         TIMESTAMPTZ,
  pushed_at       TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pn_unread ON platform_notifications (created_at DESC)
  WHERE read_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_pn_source ON platform_notifications (source_system, type);

-- Platform AI Costs: cross-system token tracking
CREATE TABLE IF NOT EXISTS platform_ai_costs (
  id              SERIAL PRIMARY KEY,
  source_system   VARCHAR(20) NOT NULL CHECK (source_system IN ('grid', 'compass', 'oracle')),
  agent_name      VARCHAR(60) NOT NULL,
  model           VARCHAR(60) NOT NULL,
  cycle_id        INTEGER,
  input_tokens    INTEGER NOT NULL DEFAULT 0,
  output_tokens   INTEGER NOT NULL DEFAULT 0,
  cost_usd        NUMERIC(10,6) NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pac_system ON platform_ai_costs (source_system, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_pac_agent ON platform_ai_costs (agent_name, created_at DESC);

-- Platform System Health: heartbeats from each system
CREATE TABLE IF NOT EXISTS platform_system_health (
  id              SERIAL PRIMARY KEY,
  system_name     VARCHAR(20) NOT NULL CHECK (system_name IN ('grid', 'compass', 'oracle')),
  status          VARCHAR(20) NOT NULL DEFAULT 'healthy' CHECK (status IN ('healthy', 'degraded', 'down', 'starting')),
  last_cycle_at   TIMESTAMPTZ,
  last_cycle_num  INTEGER,
  error_count     INTEGER DEFAULT 0,
  metadata        JSONB DEFAULT '{}',
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (system_name)
);

-- Seed GRID health row
INSERT INTO platform_system_health (system_name, status, updated_at)
VALUES ('grid', 'healthy', NOW())
ON CONFLICT (system_name) DO NOTHING;
