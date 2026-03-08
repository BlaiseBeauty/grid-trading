-- Intelligence Bus: cross-system event stream for GRID, COMPASS, ORACLE
CREATE TABLE IF NOT EXISTS intelligence_bus (
  id              SERIAL PRIMARY KEY,
  source_system   VARCHAR(20) NOT NULL CHECK (source_system IN ('grid', 'compass', 'oracle')),
  event_type      VARCHAR(60) NOT NULL,
  payload         JSONB NOT NULL DEFAULT '{}',
  conviction      NUMERIC(4,2),
  affected_assets TEXT[],
  direction       VARCHAR(10) CHECK (direction IN ('long', 'short', 'neutral', NULL)),
  time_horizon    VARCHAR(20),
  expires_at      TIMESTAMPTZ,
  superseded_by   INTEGER REFERENCES intelligence_bus(id),
  processed_by    TEXT[] DEFAULT '{}',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index: filter by source system + event type
CREATE INDEX IF NOT EXISTS idx_bus_source_type ON intelligence_bus (source_system, event_type);

-- Index: GIN on affected assets array for overlap queries
CREATE INDEX IF NOT EXISTS idx_bus_assets ON intelligence_bus USING GIN (affected_assets);

-- Index: active (non-superseded) events — expiry filtered at query time
CREATE INDEX IF NOT EXISTS idx_bus_active ON intelligence_bus (created_at DESC)
  WHERE superseded_by IS NULL;

-- Index: expiry cleanup
CREATE INDEX IF NOT EXISTS idx_bus_expiry ON intelligence_bus (expires_at)
  WHERE expires_at IS NOT NULL;

-- View: active events only
CREATE OR REPLACE VIEW intelligence_bus_active AS
  SELECT * FROM intelligence_bus
  WHERE superseded_by IS NULL
    AND (expires_at IS NULL OR expires_at > NOW())
  ORDER BY created_at DESC;
