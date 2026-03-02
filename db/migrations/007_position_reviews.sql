-- Active Position Manager: position reviews audit trail + close_reason column

CREATE TABLE IF NOT EXISTS position_reviews (
  id SERIAL PRIMARY KEY,
  trade_id INTEGER NOT NULL REFERENCES trades(id),
  cycle_number INTEGER NOT NULL,
  agent_decision_id INTEGER REFERENCES agent_decisions(id),
  decision VARCHAR(20) NOT NULL CHECK (decision IN ('hold','close','tighten','partial_close')),
  reasoning TEXT,
  current_price NUMERIC(16,8),
  unrealised_pnl NUMERIC(14,4),
  unrealised_pnl_pct NUMERIC(8,4),
  hours_held NUMERIC(8,2),
  old_tp NUMERIC(16,8),
  old_sl NUMERIC(16,8),
  new_tp NUMERIC(16,8),
  new_sl NUMERIC(16,8),
  close_executed BOOLEAN DEFAULT false,
  partial_close_pct NUMERIC(5,2),
  regime_at_review VARCHAR(30),
  signals_summary JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_position_reviews_trade ON position_reviews(trade_id);
CREATE INDEX IF NOT EXISTS idx_position_reviews_cycle ON position_reviews(cycle_number);

ALTER TABLE trades ADD COLUMN IF NOT EXISTS close_reason VARCHAR(50);
