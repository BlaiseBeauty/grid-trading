-- ─────────────────────────────────────────
-- ENHANCE LEARNINGS TABLE
-- ─────────────────────────────────────────

ALTER TABLE learnings
  ADD COLUMN IF NOT EXISTS stage VARCHAR(20) DEFAULT 'candidate',
  -- candidate | provisional | active | decaying | invalidated

  ADD COLUMN IF NOT EXISTS times_referenced INT DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_referenced_at TIMESTAMPTZ,

  -- Statistical validity
  ADD COLUMN IF NOT EXISTS sample_size INT DEFAULT 0,
  ADD COLUMN IF NOT EXISTS influenced_trades INT DEFAULT 0,
  ADD COLUMN IF NOT EXISTS influenced_wins INT DEFAULT 0,
  ADD COLUMN IF NOT EXISTS regime_breakdown JSONB DEFAULT '{}',
  -- e.g. {"trending": {"trades": 4, "wins": 3}, "ranging": {"trades": 2, "wins": 0}}

  -- Decay model
  ADD COLUMN IF NOT EXISTS confidence_halflife_days FLOAT DEFAULT 14,
  ADD COLUMN IF NOT EXISTS last_validated_at TIMESTAMPTZ DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS decayed_confidence FLOAT,
  -- recomputed each cycle: confidence * 0.5^(days_since_validated/halflife)

  -- Conflict tracking
  ADD COLUMN IF NOT EXISTS conflict_ids INT[] DEFAULT '{}',
  -- array of learning IDs this learning conflicts with

  ADD COLUMN IF NOT EXISTS superseded_by INT REFERENCES learnings(id),
  ADD COLUMN IF NOT EXISTS invalidation_reason TEXT;

-- Stage transition rules (enforced in app logic, documented here):
-- candidate   → provisional : sample_size >= 5 AND win_rate > 0.55
-- provisional → active      : tested in >= 2 distinct regimes
-- active      → decaying    : decayed_confidence < 0.4 OR win_rate drops below 0.45
-- decaying    → invalidated : operator action OR win_rate < 0.35 over 10+ trades
-- any stage   → invalidated : operator action

COMMENT ON COLUMN learnings.stage IS
  'candidate|provisional|active|decaying|invalidated';

-- ─────────────────────────────────────────
-- LEARNING INFLUENCE EVENTS
-- Track each time a learning influenced a cycle/trade
-- ─────────────────────────────────────────

CREATE TABLE IF NOT EXISTS learning_influence_events (
  id SERIAL PRIMARY KEY,
  learning_id INT REFERENCES learnings(id) ON DELETE CASCADE,
  cycle_number INT,
  trade_id INT REFERENCES trades(id) ON DELETE SET NULL,
  event_type VARCHAR(20) NOT NULL,
  -- 'referenced'   : was in Synthesizer context this cycle
  -- 'cited'        : Synthesizer reasoning text matched this learning
  -- 'trade_opened' : a trade was opened this cycle while learning was active
  -- 'trade_won'    : that trade closed with pnl > 0
  -- 'trade_lost'   : that trade closed with pnl < 0
  regime VARCHAR(30),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_lie_learning_id
  ON learning_influence_events(learning_id);
CREATE INDEX IF NOT EXISTS idx_lie_trade_id
  ON learning_influence_events(trade_id);
CREATE INDEX IF NOT EXISTS idx_lie_cycle
  ON learning_influence_events(cycle_number);

-- ─────────────────────────────────────────
-- LEARNING CONFLICTS
-- Pairs of learnings that contradict each other
-- ─────────────────────────────────────────

CREATE TABLE IF NOT EXISTS learning_conflicts (
  id SERIAL PRIMARY KEY,
  learning_a_id INT REFERENCES learnings(id) ON DELETE CASCADE,
  learning_b_id INT REFERENCES learnings(id) ON DELETE CASCADE,
  conflict_type VARCHAR(30) DEFAULT 'directional',
  -- 'directional' : same signal, opposite conclusion
  -- 'regime'      : true in one regime, false in another
  -- 'scope'       : true for one asset, false for another
  similarity_score FLOAT,
  detected_at TIMESTAMPTZ DEFAULT NOW(),
  resolved_at TIMESTAMPTZ,
  resolution VARCHAR(20),
  -- 'kept_a' | 'kept_b' | 'merged' | 'regime_dependent'
  resolved_by VARCHAR(10) DEFAULT 'system',
  UNIQUE(learning_a_id, learning_b_id)
);

-- ─────────────────────────────────────────
-- COMPOSITE LEARNINGS
-- Higher-order rules derived from combining learnings
-- ─────────────────────────────────────────

CREATE TABLE IF NOT EXISTS composite_learnings (
  id SERIAL PRIMARY KEY,
  component_learning_ids INT[] NOT NULL,
  insight_text TEXT NOT NULL,
  combined_win_rate FLOAT,
  sample_size INT DEFAULT 0,
  status VARCHAR(20) DEFAULT 'active',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  last_validated_at TIMESTAMPTZ DEFAULT NOW()
);
