// ============================================================================
// GRID — Glassnode On-Chain Data Source
// data-sources/glassnode.js
//
// Fetches on-chain metrics from the Glassnode API and stores them in
// external_data_cache. Called by agents/external-data-fetcher.js on the
// 30-minute cron schedule.
//
// Required env var: GLASSNODE_API_KEY
// ============================================================================

const { query } = require('../db/connection');

const GLASSNODE_API_KEY = process.env.GLASSNODE_API_KEY || null;
const BASE_URL = 'https://api.glassnode.com/v1/metrics';

// TTL: 24h for daily metrics, 2h for intraday
const TTL_DAILY   = 86400;
const TTL_INTRADAY = 7200;

const ENDPOINTS = [
  // --- Existing metrics (daily, BTC-only) ---
  { metric: 'mvrv_zscore',           path: 'market/mvrv_z_score',                    resolution: '24h', ttl: TTL_DAILY },
  { metric: 'nupl',                  path: 'indicators/nupl',                        resolution: '24h', ttl: TTL_DAILY },
  { metric: 'realised_price',        path: 'market/price_realized_usd',              resolution: '24h', ttl: TTL_DAILY },
  { metric: 'reserve_risk',          path: 'indicators/reserve_risk',                resolution: '24h', ttl: TTL_DAILY },
  { metric: 'puell_multiple',        path: 'indicators/puell_multiple',              resolution: '24h', ttl: TTL_DAILY },

  // --- New metrics requested ---
  { metric: 'mvrv_ratio',            path: 'market/mvrv',                            resolution: '24h', ttl: TTL_DAILY },
  { metric: 'sopr',                  path: 'indicators/sopr',                        resolution: '1h',  ttl: TTL_INTRADAY },
  { metric: 'exchange_inflow',       path: 'transactions/transfers_volume_to_exchanges_sum',   resolution: '1h',  ttl: TTL_INTRADAY },
  { metric: 'exchange_outflow',      path: 'transactions/transfers_volume_from_exchanges_sum', resolution: '1h',  ttl: TTL_INTRADAY },
  { metric: 'active_addresses',      path: 'addresses/active_count',                 resolution: '24h', ttl: TTL_DAILY },
  { metric: 'supply_in_profit_pct',  path: 'supply/profit_relative',                 resolution: '24h', ttl: TTL_DAILY },
];

async function upsertCache(source, metric, data, symbol = null, ttlSeconds = 3600) {
  await query(`
    INSERT INTO external_data_cache
      (source, metric, symbol, data, ttl_seconds, fetched_at)
    VALUES ($1, $2, $3, $4, $5, NOW())
    ON CONFLICT (source, metric, COALESCE(symbol, ''))
    DO UPDATE SET
      data        = EXCLUDED.data,
      ttl_seconds = EXCLUDED.ttl_seconds,
      fetched_at  = NOW()
  `, [source, metric, symbol, JSON.stringify(data), ttlSeconds]);
}

async function fetchGlassnode() {
  if (!GLASSNODE_API_KEY) {
    console.warn('[FETCHER] GLASSNODE_API_KEY not set — skipping on-chain metrics');
    return;
  }

  let fetched = 0;
  let failed  = 0;

  for (const { metric, path, resolution, ttl } of ENDPOINTS) {
    try {
      const url = `${BASE_URL}/${path}?a=BTC&i=${resolution}&limit=1&api_key=${GLASSNODE_API_KEY}`;
      const res = await fetch(url);

      if (res.status === 429) {
        console.warn(`[FETCHER] Glassnode rate limited on ${metric} — will retry next cycle`);
        failed++;
        continue;
      }
      if (!res.ok) {
        console.warn(`[FETCHER] Glassnode ${metric}: HTTP ${res.status}`);
        failed++;
        continue;
      }

      const json   = await res.json();
      const latest = Array.isArray(json) ? json[json.length - 1] : json;

      if (!latest || latest.v === undefined) {
        console.warn(`[FETCHER] Glassnode ${metric}: empty response — API returned no data`);
        failed++;
        continue;
      }

      await upsertCache('glassnode', metric, {
        value:     latest.v,
        timestamp: latest.t,
        asset:     'BTC',
      }, null, ttl);

      fetched++;
      console.log(`[FETCHER] Glassnode ${metric}: ${typeof latest.v === 'number' ? latest.v.toFixed(4) : latest.v}`);
    } catch (err) {
      console.error(`[FETCHER] Glassnode ${metric} error:`, err.message);
      failed++;
    }
  }

  console.log(`[FETCHER] Glassnode complete — ${fetched}/${ENDPOINTS.length} OK, ${failed} failed`);
  if (failed > 0 && fetched === 0) {
    console.error('[FETCHER] Glassnode: ALL metrics failed — check API key or network');
  }
}

module.exports = { fetchGlassnode, ENDPOINTS };
