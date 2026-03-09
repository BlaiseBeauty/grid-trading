-- ============================================================================
-- Migration 028: Learning Loop Tables
-- ORACLE calibration, GRID patterns, cross-system thesis-trade linkage.
-- ============================================================================

-- ── Thesis-to-trade linkage ───────────────────────────────────────────────────
-- When a GRID trade is closed, we record which ORACLE theses were active
-- and aligned with that trade. The Graveyard Auditor reads this table.
CREATE TABLE IF NOT EXISTS thesis_trade_links (
  id              BIGSERIAL PRIMARY KEY,
  thesis_id       TEXT NOT NULL REFERENCES oracle_theses(thesis_id),
  trade_id        BIGINT NOT NULL,   -- references trades.id
  symbol          TEXT NOT NULL,

  -- Was the thesis directionally aligned with the trade?
  -- e.g. thesis says bull BTC, trade is long BTC → aligned = true
  aligned         BOOLEAN NOT NULL,

  -- Trade outcome (populated on trade close)
  pnl_usd         NUMERIC(12,2),
  pnl_pct         NUMERIC(8,4),
  trade_outcome   TEXT CHECK (trade_outcome IN ('win', 'loss', 'breakeven')),
  close_reason    TEXT,
  hold_hours      NUMERIC(8,2),

  -- Conviction at time of trade
  conviction_at_trade  NUMERIC(4,2),

  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_thesis_trade_thesis
  ON thesis_trade_links(thesis_id, created_at DESC);
CREATE INDEX idx_thesis_trade_trade
  ON thesis_trade_links(trade_id);
CREATE UNIQUE INDEX idx_thesis_trade_unique
  ON thesis_trade_links(thesis_id, trade_id);

-- ── ORACLE domain calibration ─────────────────────────────────────────────────
-- Tracks per-domain prediction accuracy over rolling windows.
-- Used by the Calibration Engine to adjust conviction multipliers.
CREATE TABLE IF NOT EXISTS oracle_calibration (
  id              BIGSERIAL PRIMARY KEY,
  domain          TEXT NOT NULL,
  period_label    TEXT NOT NULL,   -- e.g. 'month_2025_03'
  period_start    TIMESTAMPTZ NOT NULL,
  period_end      TIMESTAMPTZ NOT NULL,

  -- Prediction accuracy
  theses_active   INTEGER NOT NULL DEFAULT 0,
  theses_retired  INTEGER NOT NULL DEFAULT 0,
  directional_hits INTEGER NOT NULL DEFAULT 0,
  directional_total INTEGER NOT NULL DEFAULT 0,

  -- Linked trade performance
  aligned_trades  INTEGER NOT NULL DEFAULT 0,
  aligned_wins    INTEGER NOT NULL DEFAULT 0,
  aligned_pnl_usd NUMERIC(12,2),

  -- Derived metrics
  directional_accuracy  NUMERIC(5,2),
  trade_win_rate        NUMERIC(5,2),
  avg_conviction_at_call NUMERIC(4,2),

  -- Conviction multiplier for this domain (applied next cycle)
  conviction_multiplier NUMERIC(4,3) NOT NULL DEFAULT 1.000,

  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX idx_calibration_domain_period
  ON oracle_calibration(domain, period_label);
CREATE INDEX idx_calibration_domain
  ON oracle_calibration(domain, created_at DESC);

-- ── Calibration learnings (agent-written post-mortems) ────────────────────────
CREATE TABLE IF NOT EXISTS oracle_calibration_learnings (
  id              BIGSERIAL PRIMARY KEY,
  domain          TEXT NOT NULL,
  source          TEXT NOT NULL,   -- 'graveyard_auditor' | 'manual'

  -- What the auditor learned
  learning_type   TEXT NOT NULL,
  summary         TEXT NOT NULL,
  detail          TEXT,

  -- Applied to future cycles
  adjustment_rule TEXT,
  applies_to_domains TEXT[],

  -- Source thesis
  thesis_id       TEXT REFERENCES oracle_theses(thesis_id),
  postmortem_id   BIGINT REFERENCES oracle_graveyard(id),

  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_cal_learnings_domain
  ON oracle_calibration_learnings(domain, created_at DESC);

-- ── GRID signal patterns ──────────────────────────────────────────────────────
-- Stores recurring signal combinations discovered by Pattern Discovery agent.
CREATE TABLE IF NOT EXISTS grid_signal_patterns (
  id              BIGSERIAL PRIMARY KEY,
  pattern_id      TEXT NOT NULL UNIQUE,
  symbol          TEXT NOT NULL,
  regime          TEXT,

  -- Signal combination
  signal_types    TEXT[] NOT NULL,
  signal_direction TEXT NOT NULL,
  required_count  INTEGER NOT NULL DEFAULT 2,

  -- Performance stats
  sample_size     INTEGER NOT NULL DEFAULT 0,
  win_rate        NUMERIC(5,2),
  avg_pnl_pct     NUMERIC(8,4),
  avg_hold_hours  NUMERIC(8,2),
  sharpe          NUMERIC(8,4),

  -- Confidence level
  status          TEXT NOT NULL DEFAULT 'emerging'
                    CHECK (status IN ('emerging', 'confirmed', 'retired')),

  -- Description written by Pattern Discovery agent
  description     TEXT,
  conditions      TEXT,

  -- Template linkage (promoted patterns become templates)
  template_id     BIGINT,

  first_seen_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  promoted_at     TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_patterns_symbol
  ON grid_signal_patterns(symbol, status, win_rate DESC);
CREATE INDEX idx_patterns_status
  ON grid_signal_patterns(status, win_rate DESC);

-- ── Pattern observations (each time we see a pattern in a cycle) ──────────────
CREATE TABLE IF NOT EXISTS grid_pattern_observations (
  id              BIGSERIAL PRIMARY KEY,
  pattern_id      TEXT NOT NULL REFERENCES grid_signal_patterns(pattern_id),
  cycle_id        TEXT,
  trade_id        BIGINT,
  observed_signals JSONB,
  resulted_in_trade BOOLEAN NOT NULL DEFAULT FALSE,
  trade_outcome   TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_pattern_obs_pattern
  ON grid_pattern_observations(pattern_id, created_at DESC);
