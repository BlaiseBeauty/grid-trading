// ============================================================================
// GRID — External Data Fetcher
// agents/external-data-fetcher.js
// ============================================================================

const { query } = require('../db/connection');
const { fetchGlassnode } = require('../data-sources/glassnode');

const COINGLASS_API_KEY  = process.env.COINGLASS_API_KEY  || null;

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

async function fetchFearGreed() {
  try {
    const res  = await fetch('https://api.alternative.me/fng/?limit=7&format=json');
    const json = await res.json();
    const data = { current: json.data[0], history_7d: json.data };
    await upsertCache('alternative_me', 'fear_greed_index', data, null, 3600);
    console.log(`[FETCHER] fear_greed: ${data.current.value} (${data.current.value_classification})`);
  } catch (err) {
    console.error('[FETCHER] Alternative.me error:', err.message);
  }
}

async function fetchCoinGlass() {
  if (!COINGLASS_API_KEY) {
    console.warn('[FETCHER] COINGLASS_API_KEY not set — skipping');
    return;
  }

  const headers = { 'coinglassSecret': COINGLASS_API_KEY };
  const symbols = ['BTC', 'ETH', 'SOL'];

  try {
    const res  = await fetch('https://open-api.coinglass.com/public/v2/funding', { headers });
    const json = await res.json();
    if (json.success) {
      await upsertCache('coinglass', 'funding_rates', json.data, null, 900);
      for (const sym of symbols) {
        const symData = json.data?.filter(d => d.symbol === sym) || [];
        if (symData.length) await upsertCache('coinglass', 'funding_rates', symData, `${sym}/USDT`, 900);
      }
      console.log('[FETCHER] CoinGlass funding rates OK');
    }
  } catch (err) {
    console.error('[FETCHER] CoinGlass funding error:', err.message);
  }

  try {
    const res  = await fetch('https://open-api.coinglass.com/public/v2/open_interest', { headers });
    const json = await res.json();
    if (json.success) {
      await upsertCache('coinglass', 'aggregated_oi', json.data, null, 900);
      for (const sym of symbols) {
        const symData = json.data?.find(d => d.symbol === sym);
        if (symData) {
          await upsertCache('coinglass', 'aggregated_oi', symData, `${sym}/USDT`, 900);
          await upsertCache('coinglass', 'oi_change', {
            change_1h:  symData.oiChangePercent1h,
            change_4h:  symData.oiChangePercent4h,
            change_24h: symData.oiChangePercent24h
          }, `${sym}/USDT`, 900);
        }
      }
      console.log('[FETCHER] CoinGlass OI OK');
    }
  } catch (err) {
    console.error('[FETCHER] CoinGlass OI error:', err.message);
  }

  try {
    for (const sym of symbols) {
      const res  = await fetch(
        `https://open-api.coinglass.com/public/v2/long_short?symbol=${sym}&interval=h1&limit=24`,
        { headers }
      );
      const json = await res.json();
      if (json.success) await upsertCache('coinglass', 'long_short_ratio', json.data, `${sym}/USDT`, 900);
    }
    console.log('[FETCHER] CoinGlass long/short OK');
  } catch (err) {
    console.error('[FETCHER] CoinGlass L/S error:', err.message);
  }

  try {
    const res  = await fetch(
      'https://open-api.coinglass.com/public/v2/liquidation_map?symbol=BTC&range=24',
      { headers }
    );
    const json = await res.json();
    if (json.success) {
      await upsertCache('coinglass', 'liquidation_heatmap', json.data, 'BTC/USDT', 1800);
      console.log('[FETCHER] CoinGlass liquidation heatmap OK');
    }
  } catch (err) {
    console.error('[FETCHER] CoinGlass liquidation error:', err.message);
  }
}

async function fetchAll() {
  console.log('[FETCHER] Starting external data fetch...');
  await Promise.allSettled([fetchFearGreed(), fetchCoinGlass(), fetchGlassnode()]);
  console.log('[FETCHER] External data fetch complete');
}

module.exports = { fetchAll, fetchFearGreed, fetchCoinGlass, fetchGlassnode };
