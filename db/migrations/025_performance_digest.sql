-- ============================================================================
-- Migration 025: Performance Digest Snapshots
-- Weekly GRID performance snapshots — consumed by ORACLE learning loop.
-- Stored permanently (never purged) as the audit trail of GRID's evolution.
-- ============================================================================

CREATE TABLE IF NOT EXISTS grid_performance_digests (
  id              BIGSERIAL PRIMARY KEY,

  -- Period this digest covers
  period_start    TIMESTAMPTZ NOT NULL,
  period_end      TIMESTAMPTZ NOT NULL,
  period_label    TEXT NOT NULL,   -- e.g. 'week_2025_W12', 'month_2025_03'

  -- Core performance metrics
  total_trades    INTEGER NOT NULL DEFAULT 0,
  winning_trades  INTEGER NOT NULL DEFAULT 0,
  losing_trades   INTEGER NOT NULL DEFAULT 0,
  win_rate        NUMERIC(5,2),    -- percentage, e.g. 61.50

  -- P&L
  total_pnl_usd   NUMERIC(12,2) NOT NULL DEFAULT 0,
  avg_win_usd     NUMERIC(12,2),
  avg_loss_usd    NUMERIC(12,2),
  largest_win_usd NUMERIC(12,2),
  largest_loss_usd NUMERIC(12,2),
  profit_factor   NUMERIC(8,4),   -- gross profit / gross loss

  -- Risk metrics
  sharpe_ratio    NUMERIC(8,4),
  max_drawdown_pct NUMERIC(8,4),
  max_drawdown_usd NUMERIC(12,2),
  avg_hold_hours  NUMERIC(8,2),

  -- Signal quality
  top_signals     JSONB,          -- [{signal_type, win_rate, count}]
  worst_signals   JSONB,          -- [{signal_type, win_rate, count}]
  best_regime     TEXT,           -- regime label with best performance
  worst_regime    TEXT,

  -- Per-symbol breakdown
  by_symbol       JSONB,          -- {BTC: {trades, pnl, win_rate}, ...}

  -- AI efficiency
  total_ai_cost_usd NUMERIC(10,4),
  cost_per_trade  NUMERIC(10,6),  -- USD cost per executed trade

  -- Raw data for ORACLE queries
  trade_ids       BIGINT[],       -- all trade IDs in this period

  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX idx_digest_period
  ON grid_performance_digests(period_label);

CREATE INDEX idx_digest_created
  ON grid_performance_digests(created_at DESC);
