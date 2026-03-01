-- Equity curve snapshots — one row per cycle or daily
CREATE TABLE IF NOT EXISTS equity_snapshots (
  id SERIAL PRIMARY KEY,
  cycle_number INTEGER,
  total_value NUMERIC(14,2) NOT NULL,
  realised_pnl NUMERIC(14,2) NOT NULL DEFAULT 0,
  unrealised_pnl NUMERIC(14,2) NOT NULL DEFAULT 0,
  open_positions INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_equity_snapshots_created ON equity_snapshots(created_at);
