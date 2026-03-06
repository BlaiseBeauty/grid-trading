-- Cycle report storage — one JSONB row per completed agent cycle
CREATE TABLE IF NOT EXISTS cycle_reports (
  id SERIAL PRIMARY KEY,
  cycle_id INTEGER,
  report JSONB NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_cycle_reports_cycle_id ON cycle_reports (cycle_id);
CREATE INDEX IF NOT EXISTS idx_cycle_reports_created_at ON cycle_reports (created_at DESC);
