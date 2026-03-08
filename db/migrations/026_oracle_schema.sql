-- ============================================================================
-- Migration 026: ORACLE Schema
-- Tables for thesis lifecycle, evidence, and macro intelligence.
-- ============================================================================

-- ── Core thesis table ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS oracle_theses (
  id              BIGSERIAL PRIMARY KEY,
  thesis_id       TEXT NOT NULL UNIQUE,  -- e.g. 'oracle-thesis-001'
  name            TEXT NOT NULL,
  domain          TEXT NOT NULL,
  -- Domains: macro | geopolitical | technology | commodity | equity | crypto

  -- Direction and conviction
  direction       TEXT NOT NULL CHECK (direction IN ('bull', 'bear', 'neutral')),
  conviction      NUMERIC(4,2) NOT NULL CHECK (conviction BETWEEN 0 AND 10),
  time_horizon    TEXT NOT NULL CHECK (time_horizon IN ('tactical', 'strategic', 'structural')),
  -- tactical:    days to weeks
  -- strategic:   weeks to months
  -- structural:  months to years

  -- Asset impact
  long_assets     TEXT[] NOT NULL DEFAULT '{}',
  short_assets    TEXT[] NOT NULL DEFAULT '{}',
  watch_assets    TEXT[] NOT NULL DEFAULT '{}',

  -- Thesis content
  summary         TEXT NOT NULL,
  catalyst        TEXT,          -- what would confirm this thesis
  invalidation    TEXT,          -- what would kill this thesis
  competing_view  TEXT,          -- the strongest counter-argument

  -- Evidence chain (populated by ingestion)
  evidence_count  INTEGER NOT NULL DEFAULT 0,

  -- Lifecycle
  status          TEXT NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active', 'monitoring', 'retired')),
  bus_event_id    BIGINT,        -- ID of the thesis_created bus event

  -- Timestamps
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  retired_at      TIMESTAMPTZ
);

CREATE INDEX idx_oracle_theses_status
  ON oracle_theses(status, conviction DESC);
CREATE INDEX idx_oracle_theses_domain
  ON oracle_theses(domain, status);
CREATE INDEX idx_oracle_theses_assets
  ON oracle_theses USING GIN(long_assets);
CREATE INDEX idx_oracle_theses_short_assets
  ON oracle_theses USING GIN(short_assets);

-- ── Conviction history (append-only audit trail) ──────────────────────────────
CREATE TABLE IF NOT EXISTS oracle_conviction_history (
  id              BIGSERIAL PRIMARY KEY,
  thesis_id       TEXT NOT NULL REFERENCES oracle_theses(thesis_id),
  old_conviction  NUMERIC(4,2),
  new_conviction  NUMERIC(4,2) NOT NULL,
  reason          TEXT NOT NULL,
  triggered_by    TEXT,          -- 'agent_cycle' | 'trade_outcome' | 'manual'
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_conviction_history_thesis
  ON oracle_conviction_history(thesis_id, created_at DESC);

-- ── Evidence items ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS oracle_evidence (
  id              BIGSERIAL PRIMARY KEY,
  thesis_id       TEXT REFERENCES oracle_theses(thesis_id),
  -- thesis_id can be NULL — evidence may be ingested before thesis assignment

  source_type     TEXT NOT NULL,
  -- Types: fred_macro | rss_news | gdelt_event | usda_report | eia_storage
  --        cot_report | manual | agent_inference

  source_name     TEXT NOT NULL,   -- e.g. 'FRED', 'Reuters', 'USDA'
  source_url      TEXT,
  headline        TEXT,
  content         TEXT,
  published_at    TIMESTAMPTZ,

  -- Relevance scoring (set by ingestion pipeline)
  relevance_score NUMERIC(4,2),   -- 0–10, how relevant to thesis
  sentiment       TEXT CHECK (sentiment IN ('bullish', 'bearish', 'neutral', 'mixed')),
  domain_tags     TEXT[],          -- ['macro', 'energy', 'geopolitical']

  -- Deduplication
  content_hash    TEXT UNIQUE,     -- SHA256 of headline+source

  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_evidence_thesis
  ON oracle_evidence(thesis_id, created_at DESC);
CREATE INDEX idx_evidence_source
  ON oracle_evidence(source_type, created_at DESC);
CREATE INDEX idx_evidence_tags
  ON oracle_evidence USING GIN(domain_tags);

-- ── Thesis graveyard ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS oracle_graveyard (
  id              BIGSERIAL PRIMARY KEY,
  thesis_id       TEXT NOT NULL REFERENCES oracle_theses(thesis_id),
  thesis_name     TEXT NOT NULL,
  domain          TEXT NOT NULL,
  direction       TEXT NOT NULL,

  -- Performance against reality
  conviction_at_open    NUMERIC(4,2),
  conviction_at_close   NUMERIC(4,2),
  opened_at             TIMESTAMPTZ,
  closed_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  hold_days             INTEGER,

  -- Outcome assessment
  outcome         TEXT CHECK (outcome IN ('correct', 'incorrect', 'partial', 'timed_out')),
  directional_hit BOOLEAN,       -- did price move in predicted direction?
  pnl_attributed  NUMERIC(12,2), -- P&L from GRID trades tagged to this thesis

  -- Post-mortem (written by graveyard auditor agent)
  postmortem_summary    TEXT,
  what_was_right        TEXT,
  what_was_wrong        TEXT,
  key_learning          TEXT,
  calibration_adjustment TEXT,   -- how this affects future conviction scoring

  -- Links
  trade_ids       BIGINT[],      -- GRID trades that referenced this thesis
  evidence_ids    BIGINT[],

  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_graveyard_domain
  ON oracle_graveyard(domain, closed_at DESC);
CREATE INDEX idx_graveyard_outcome
  ON oracle_graveyard(outcome, directional_hit);

-- ── Macro regime snapshots ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS oracle_macro_regime (
  id              BIGSERIAL PRIMARY KEY,

  -- Regime indicators (0–100 scale)
  risk_appetite       INTEGER,   -- 0=risk-off, 100=risk-on
  dollar_strength     INTEGER,   -- 0=weak, 100=strong
  rate_trajectory     INTEGER,   -- 0=cutting, 100=hiking
  geo_stress          INTEGER,   -- 0=calm, 100=crisis
  ai_disruption_vel   INTEGER,   -- 0=slow, 100=accelerating
  commodity_stress    INTEGER,   -- 0=benign, 100=stressed

  -- Qualitative labels
  overall_regime      TEXT,      -- e.g. 'risk-on selective'
  dollar_regime       TEXT,      -- e.g. 'DXY weakening'
  rate_regime         TEXT,      -- e.g. 'cuts priced mid-2025'
  dominant_narrative  TEXT,      -- one sentence summary

  -- Raw data snapshot
  fred_data           JSONB,     -- latest FRED indicators
  yield_curve_spread  NUMERIC(6,4),  -- 10Y-2Y spread

  bus_event_id        BIGINT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_macro_regime_created
  ON oracle_macro_regime(created_at DESC);

-- ── Opportunity map snapshots ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS oracle_opportunity_map (
  id              BIGSERIAL PRIMARY KEY,
  generated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Ranked opportunity list
  opportunities   JSONB NOT NULL,

  thesis_count    INTEGER,       -- number of active theses at generation time
  bus_event_id    BIGINT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_opp_map_created
  ON oracle_opportunity_map(created_at DESC);

-- ── Raw ingestion feed (staging area before evidence processing) ───────────────
CREATE TABLE IF NOT EXISTS oracle_raw_feed (
  id              BIGSERIAL PRIMARY KEY,
  source_type     TEXT NOT NULL,
  source_name     TEXT NOT NULL,
  raw_content     JSONB NOT NULL,
  headline        TEXT,
  published_at    TIMESTAMPTZ,
  content_hash    TEXT UNIQUE,
  processed       BOOLEAN NOT NULL DEFAULT FALSE,
  processed_at    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_raw_feed_unprocessed
  ON oracle_raw_feed(created_at DESC) WHERE processed = FALSE;
CREATE INDEX idx_raw_feed_source
  ON oracle_raw_feed(source_type, created_at DESC);
