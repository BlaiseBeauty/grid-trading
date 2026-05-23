-- 031_observation_mode.sql
-- Passive market observation table — zero AI calls, zero trades
-- Populated every 6h by the market-observer cron job

CREATE TABLE IF NOT EXISTS market_observations (
  id               SERIAL PRIMARY KEY,
  observed_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Crypto prices (CoinGecko)
  btc_price        NUMERIC,
  btc_volume_24h   NUMERIC,
  btc_change_24h   NUMERIC,
  eth_price        NUMERIC,
  eth_volume_24h   NUMERIC,
  eth_change_24h   NUMERIC,

  -- Market structure (CoinGecko /global)
  total_market_cap NUMERIC,
  btc_dominance    NUMERIC,

  -- Sentiment (alternative.me)
  fear_greed_value   INTEGER,
  fear_greed_label   VARCHAR(50),

  -- Macro (FRED — free, no key required)
  dxy              NUMERIC,   -- DTWEXBGS: Trade Weighted USD Index
  treasury_10y     NUMERIC,   -- DGS10: 10-Year Treasury Yield
  gold_price       NUMERIC,   -- GOLDAMGBD228NLBM: London AM gold fix (USD/troy oz)

  -- Full raw snapshot for replay / debug
  raw              JSONB
);

CREATE INDEX IF NOT EXISTS idx_market_observations_observed_at
  ON market_observations (observed_at DESC);
