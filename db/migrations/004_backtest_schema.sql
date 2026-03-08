-- 004_backtest_schema.sql
-- Backtest system: historical data, runs, trades, regime periods

-- 1. Historical OHLCV (separate from live market_data to avoid pollution)
CREATE TABLE IF NOT EXISTS historical_ohlcv (
  id SERIAL PRIMARY KEY,
  symbol VARCHAR(20) NOT NULL,
  timeframe VARCHAR(5) NOT NULL,
  timestamp TIMESTAMPTZ NOT NULL,
  open NUMERIC(20,8),
  high NUMERIC(20,8),
  low NUMERIC(20,8),
  close NUMERIC(20,8),
  volume NUMERIC(20,8),
  UNIQUE(symbol, timeframe, timestamp)
);

CREATE INDEX idx_historical_ohlcv_lookup
  ON historical_ohlcv (symbol, timeframe, timestamp);

-- 2. Backtest Runs
CREATE TABLE IF NOT EXISTS backtest_runs (
  id SERIAL PRIMARY KEY,
  name VARCHAR(200),
  description TEXT,
  symbols JSONB,
  timeframe VARCHAR(5),
  date_from TIMESTAMPTZ,
  date_to TIMESTAMPTZ,
  in_sample_cutoff TIMESTAMPTZ,
  status VARCHAR(20) DEFAULT 'pending'
    CHECK (status IN ('pending', 'running', 'complete', 'failed')),
  total_trades INTEGER DEFAULT 0,
  win_rate NUMERIC(5,2),
  total_return NUMERIC(10,4),
  sharpe_ratio NUMERIC(8,4),
  max_drawdown NUMERIC(8,4),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  error_text TEXT
);

-- 3. Backtest Trades
CREATE TABLE IF NOT EXISTS backtest_trades (
  id SERIAL PRIMARY KEY,
  run_id INTEGER REFERENCES backtest_runs(id) ON DELETE CASCADE,
  symbol VARCHAR(20) NOT NULL,
  side VARCHAR(5) CHECK (side IN ('long', 'short')),
  template_id INTEGER REFERENCES strategy_templates(id),
  template_name VARCHAR(200),
  regime VARCHAR(50),
  confidence NUMERIC(5,2),
  entry_price NUMERIC(20,8),
  exit_price NUMERIC(20,8),
  entry_time TIMESTAMPTZ,
  exit_time TIMESTAMPTZ,
  pnl_pct NUMERIC(10,4),
  pnl_usd NUMERIC(10,4),
  position_size_pct NUMERIC(5,2),
  close_reason VARCHAR(50)
    CHECK (close_reason IN ('take_profit', 'stop_loss', 'time_stop', 'end_of_data')),
  signals_matched JSONB,
  is_in_sample BOOLEAN,
  fees_paid NUMERIC(10,4)
);

CREATE INDEX idx_backtest_trades_run ON backtest_trades (run_id);
CREATE INDEX idx_backtest_trades_symbol ON backtest_trades (run_id, symbol);

-- 4. Backtest Regime Periods
CREATE TABLE IF NOT EXISTS backtest_regime_periods (
  id SERIAL PRIMARY KEY,
  symbol VARCHAR(20) NOT NULL,
  timeframe VARCHAR(5) NOT NULL,
  regime VARCHAR(50) NOT NULL,
  confidence NUMERIC(5,2),
  period_start TIMESTAMPTZ,
  period_end TIMESTAMPTZ
);

CREATE INDEX idx_backtest_regime_lookup
  ON backtest_regime_periods (symbol, timeframe, period_start);
