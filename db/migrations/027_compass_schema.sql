-- ============================================================================
-- Migration 027: COMPASS Schema
-- Portfolio navigation and risk management tables.
-- ============================================================================

-- ── Portfolio snapshots ───────────────────────────────────────────────────────
-- COMPASS maintains a portfolio view synthesised from ORACLE theses +
-- GRID performance. Each cycle produces a new snapshot.
CREATE TABLE IF NOT EXISTS compass_portfolios (
  id                BIGSERIAL PRIMARY KEY,
  snapshot_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Portfolio composition recommendations
  -- e.g. {"BTC": {"weight": 0.35, "direction": "long", "conviction": 7.5},
  --        "ETH": {"weight": 0.20, "direction": "long", "conviction": 6.0}}
  recommended_weights  JSONB NOT NULL DEFAULT '{}',

  -- Cash/defensive allocation (0.0 – 1.0)
  cash_weight          NUMERIC(5,4) NOT NULL DEFAULT 0.20,

  -- Risk posture: 'aggressive' | 'neutral' | 'defensive' | 'cash'
  risk_posture         TEXT NOT NULL DEFAULT 'neutral'
                         CHECK (risk_posture IN ('aggressive', 'neutral', 'defensive', 'cash')),

  -- What drove this posture
  posture_reasoning    TEXT,

  -- Active thesis count at time of snapshot
  oracle_thesis_count  INTEGER NOT NULL DEFAULT 0,

  -- GRID performance context used
  grid_sharpe          NUMERIC(8,4),
  grid_win_rate        NUMERIC(5,2),
  grid_drawdown_pct    NUMERIC(8,4),

  bus_event_id         BIGINT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_compass_portfolios_created
  ON compass_portfolios(created_at DESC);

-- ── Allocation guidance (per-symbol position sizing) ─────────────────────────
-- More granular than portfolio snapshot — tells GRID exact dollar limits
CREATE TABLE IF NOT EXISTS compass_allocations (
  id              BIGSERIAL PRIMARY KEY,
  portfolio_id    BIGINT REFERENCES compass_portfolios(id),
  symbol          TEXT NOT NULL,

  -- Position limits
  max_position_usd    NUMERIC(12,2) NOT NULL,
  recommended_usd     NUMERIC(12,2),
  direction_bias      TEXT CHECK (direction_bias IN ('long', 'short', 'neutral')),
  bias_conviction     NUMERIC(4,2),   -- 0–10, strength of directional bias

  -- Source: which oracle thesis drives this?
  primary_thesis_id   TEXT,
  thesis_alignment    TEXT,           -- 'aligned' | 'opposed' | 'neutral'

  -- Validity
  valid_until         TIMESTAMPTZ NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_compass_alloc_symbol
  ON compass_allocations(symbol, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_compass_alloc_valid
  ON compass_allocations(valid_until DESC);

-- ── Risk assessments ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS compass_risk_assessments (
  id              BIGSERIAL PRIMARY KEY,
  assessed_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Overall risk score: 0 (very safe) – 10 (extreme risk)
  risk_score      NUMERIC(4,2) NOT NULL DEFAULT 5.0,

  -- Risk components (each 0–10)
  market_risk     NUMERIC(4,2),    -- macro/volatility environment
  concentration_risk NUMERIC(4,2), -- how concentrated GRID positions are
  correlation_risk   NUMERIC(4,2), -- cross-asset correlation
  drawdown_risk      NUMERIC(4,2), -- proximity to drawdown limits
  thesis_conflict_risk NUMERIC(4,2), -- how many ORACLE conflicts exist

  -- Recommended limits to send to GRID
  max_total_exposure_usd  NUMERIC(12,2),
  max_single_position_usd NUMERIC(12,2),
  max_open_positions      INTEGER,
  scram_threshold_pct     NUMERIC(5,2),  -- override for SCRAM trigger

  -- Flags
  flags           JSONB NOT NULL DEFAULT '[]',
  -- e.g. [{"severity": "warn", "message": "High correlation in crypto positions"},
  --        {"severity": "critical", "message": "Drawdown at 80% of SCRAM threshold"}]

  -- GRID position data used in this assessment
  open_positions  JSONB,

  bus_event_id    BIGINT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_compass_risk_created
  ON compass_risk_assessments(created_at DESC);

-- ── Rebalance recommendations ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS compass_rebalance_log (
  id              BIGSERIAL PRIMARY KEY,
  recommended_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- What COMPASS recommends GRID do
  action          TEXT NOT NULL,
  -- 'reduce_btc' | 'close_all_shorts' | 'increase_cash' | 'exit_position'
  symbol          TEXT,
  reason          TEXT NOT NULL,
  urgency         TEXT NOT NULL DEFAULT 'normal'
                    CHECK (urgency IN ('critical', 'high', 'normal', 'low')),

  -- Was this acted on?
  acknowledged_at TIMESTAMPTZ,
  acted_on        BOOLEAN DEFAULT FALSE,

  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_compass_rebalance_created
  ON compass_rebalance_log(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_compass_rebalance_unack
  ON compass_rebalance_log(created_at DESC) WHERE acknowledged_at IS NULL;

-- ── Correlation snapshots ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS compass_correlation_snapshots (
  id              BIGSERIAL PRIMARY KEY,
  snapshot_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- e.g. {"BTC_ETH": 0.89, "BTC_SOL": 0.76}
  correlations    JSONB NOT NULL DEFAULT '{}',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_compass_corr_created
  ON compass_correlation_snapshots(created_at DESC);
