-- Add unique constraint for upsert support on external_data_cache
-- Uses COALESCE(symbol, '') to handle NULL symbols in the unique index

BEGIN;

-- Remove duplicates first (keep newest per source/metric/symbol)
DELETE FROM external_data_cache a
USING external_data_cache b
WHERE a.id < b.id
  AND a.source = b.source
  AND a.metric = b.metric
  AND COALESCE(a.symbol, '') = COALESCE(b.symbol, '');

-- Create unique index for ON CONFLICT support
CREATE UNIQUE INDEX IF NOT EXISTS idx_cache_upsert
  ON external_data_cache (source, metric, COALESCE(symbol, ''));

COMMIT;
