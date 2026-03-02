-- Audit fix: Add UNIQUE constraint on portfolio_state(symbol, exchange) for upsert support

-- Deduplicate any existing rows before adding constraint
DELETE FROM portfolio_state a USING portfolio_state b
WHERE a.id < b.id AND a.symbol = b.symbol AND a.exchange = b.exchange;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'uq_portfolio_state_symbol_exchange'
  ) THEN
    ALTER TABLE portfolio_state
      ADD CONSTRAINT uq_portfolio_state_symbol_exchange UNIQUE (symbol, exchange);
  END IF;
END $$;
