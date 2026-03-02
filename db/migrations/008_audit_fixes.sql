-- Audit fix: Add UNIQUE constraint on portfolio_state(symbol, exchange) for upsert support

-- Deduplicate any existing rows before adding constraint
DELETE FROM portfolio_state a USING portfolio_state b
WHERE a.id < b.id AND a.symbol = b.symbol AND a.exchange = b.exchange;

ALTER TABLE portfolio_state
  ADD CONSTRAINT uq_portfolio_state_symbol_exchange UNIQUE (symbol, exchange);
