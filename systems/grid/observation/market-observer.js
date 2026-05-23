'use strict';

// ============================================================================
// GRID — Market Observer (Observation Mode)
// systems/grid/observation/market-observer.js
//
// Collects market + macro data from free public APIs every 6h.
// Zero Claude API calls. Zero trade execution.
// Saves to market_observations table and POSTs to Brain API.
// ============================================================================

const https = require('https');
const { query } = require('../../../db/connection');

const BRAIN_API_URL    = 'https://brain-web-production-41af.up.railway.app';
const BRAIN_API_SECRET = process.env.BRAIN_API_SECRET || null;

// ── Free API fetchers ─────────────────────────────────────────────────────────

async function fetchJSON(url, timeoutMs = 12000) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  return res.json();
}

/** CoinGecko: BTC + ETH price, 24h volume, 24h change */
async function fetchCryptoMarkets() {
  const data = await fetchJSON(
    'https://api.coingecko.com/api/v3/coins/markets' +
    '?vs_currency=usd&ids=bitcoin,ethereum&order=market_cap_desc' +
    '&per_page=2&page=1&price_change_percentage=24h'
  );
  const btc = data.find(d => d.id === 'bitcoin')  || {};
  const eth = data.find(d => d.id === 'ethereum') || {};
  return {
    btc: {
      price:     btc.current_price               ?? null,
      volume24h: btc.total_volume                ?? null,
      change24h: btc.price_change_percentage_24h ?? null,
    },
    eth: {
      price:     eth.current_price               ?? null,
      volume24h: eth.total_volume                ?? null,
      change24h: eth.price_change_percentage_24h ?? null,
    },
  };
}

/** CoinGecko: total market cap (USD) + BTC dominance (%) */
async function fetchGlobalMarket() {
  const data = await fetchJSON('https://api.coingecko.com/api/v3/global');
  const g = data?.data || {};
  return {
    totalMarketCap: g.total_market_cap?.usd      ?? null,
    btcDominance:   g.market_cap_percentage?.btc ?? null,
  };
}

/** alternative.me: Fear & Greed Index (0–100) */
async function fetchFearGreed() {
  const data = await fetchJSON('https://api.alternative.me/fng/?limit=1&format=json');
  const item = data?.data?.[0] || {};
  return {
    value: item.value != null ? parseInt(item.value) : null,
    label: item.value_classification ?? null,
  };
}

/**
 * FRED CSV fallback (no API key needed).
 * Returns the latest non-null numeric value for the given series.
 * Series used:
 *   DTWEXBGS — Trade Weighted USD Index (Broad): weekly
 *   DGS10    — 10-Year Treasury Constant Maturity Rate: daily
 *   GOLDAMGBD228NLBM — Gold AM fix, USD/troy oz: daily
 */
async function fetchFredCSV(seriesId) {
  return new Promise((resolve) => {
    const url = `https://fred.stlouisfed.org/graph/fredgraph.csv?id=${seriesId}`;
    const req = https.get(url, { timeout: 12000 }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const lines = data.trim().split('\n').filter(l => !l.startsWith('DATE'));
          for (let i = lines.length - 1; i >= 0; i--) {
            const [, val] = lines[i].split(',');
            const num = parseFloat(val);
            if (!isNaN(num)) { resolve(num); return; }
          }
        } catch { /* fall through */ }
        resolve(null);
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

// ── Main collection run ───────────────────────────────────────────────────────

async function runObservation() {
  console.log('[OBS] Market observation starting...');

  const [cryptoRes, globalRes, fearGreedRes, dxyRes, treasuryRes, goldRes] =
    await Promise.allSettled([
      fetchCryptoMarkets(),
      fetchGlobalMarket(),
      fetchFearGreed(),
      fetchFredCSV('DTWEXBGS'),          // USD Index (Trade Weighted, Broad)
      fetchFredCSV('DGS10'),             // 10-Year Treasury Yield
      fetchFredCSV('GOLDAMGBD228NLBM'),  // Gold AM Fix, USD/troy oz
    ]);

  const logErr = (label, res) => {
    if (res.status === 'rejected') console.warn(`[OBS] ${label} fetch failed:`, res.reason?.message);
  };
  logErr('Crypto',    cryptoRes);
  logErr('Global',    globalRes);
  logErr('FearGreed', fearGreedRes);
  logErr('DXY',       dxyRes);
  logErr('Treasury',  treasuryRes);
  logErr('Gold',      goldRes);

  const crypto    = cryptoRes.status    === 'fulfilled' ? cryptoRes.value    : {};
  const global    = globalRes.status    === 'fulfilled' ? globalRes.value    : {};
  const fearGreed = fearGreedRes.status === 'fulfilled' ? fearGreedRes.value : {};

  const snapshot = {
    btcPrice:       crypto.btc?.price        ?? null,
    btcVolume24h:   crypto.btc?.volume24h    ?? null,
    btcChange24h:   crypto.btc?.change24h    ?? null,
    ethPrice:       crypto.eth?.price        ?? null,
    ethVolume24h:   crypto.eth?.volume24h    ?? null,
    ethChange24h:   crypto.eth?.change24h    ?? null,
    totalMarketCap: global.totalMarketCap    ?? null,
    btcDominance:   global.btcDominance      ?? null,
    fearGreedValue: fearGreed.value          ?? null,
    fearGreedLabel: fearGreed.label          ?? null,
    dxy:            dxyRes.status      === 'fulfilled' ? dxyRes.value      : null,
    treasury10y:    treasuryRes.status === 'fulfilled' ? treasuryRes.value : null,
    goldPrice:      goldRes.status     === 'fulfilled' ? goldRes.value     : null,
  };

  // Persist to local DB
  try {
    await query(`
      INSERT INTO market_observations (
        btc_price, btc_volume_24h, btc_change_24h,
        eth_price, eth_volume_24h, eth_change_24h,
        total_market_cap, btc_dominance,
        fear_greed_value, fear_greed_label,
        dxy, treasury_10y, gold_price, raw
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
    `, [
      snapshot.btcPrice,      snapshot.btcVolume24h,  snapshot.btcChange24h,
      snapshot.ethPrice,      snapshot.ethVolume24h,  snapshot.ethChange24h,
      snapshot.totalMarketCap, snapshot.btcDominance,
      snapshot.fearGreedValue, snapshot.fearGreedLabel,
      snapshot.dxy,            snapshot.treasury10y,   snapshot.goldPrice,
      JSON.stringify(snapshot),
    ]);

    const btcFmt = snapshot.btcPrice != null ? `$${Math.round(snapshot.btcPrice).toLocaleString()}` : 'n/a';
    const fgFmt  = snapshot.fearGreedValue != null ? `${snapshot.fearGreedValue} (${snapshot.fearGreedLabel})` : 'n/a';
    console.log(`[OBS] Saved — BTC: ${btcFmt} | F&G: ${fgFmt} | Gold: $${snapshot.goldPrice?.toFixed(0) ?? 'n/a'}`);
  } catch (err) {
    console.error('[OBS] DB save failed:', err.message);
  }

  // Post to Brain API — best-effort, never blocks the observer
  postToBrain(snapshot).catch(err =>
    console.warn('[OBS] Brain POST skipped (non-fatal):', err.message)
  );

  return snapshot;
}

// ── Brain API integration ─────────────────────────────────────────────────────

async function postToBrain(snapshot) {
  if (!BRAIN_API_SECRET) {
    console.log('[OBS] BRAIN_API_SECRET not set — skipping Brain POST');
    return;
  }

  const content = buildSummary(snapshot);
  const payload = {
    type:  'market_observation',
    space: 'GRID',
    content,
    data: {
      btc:       { price: snapshot.btcPrice, change24h: snapshot.btcChange24h, volume24h: snapshot.btcVolume24h },
      eth:       { price: snapshot.ethPrice, change24h: snapshot.ethChange24h, volume24h: snapshot.ethVolume24h },
      marketCap: snapshot.totalMarketCap,
      dominance: snapshot.btcDominance,
      fearGreed: { value: snapshot.fearGreedValue, label: snapshot.fearGreedLabel },
      dxy:       snapshot.dxy,
      treasury:  snapshot.treasury10y,
      gold:      snapshot.goldPrice,
    },
    timestamp: new Date().toISOString(),
  };

  const res = await fetch(`${BRAIN_API_URL}/api/capture/market-observation`, {
    method:  'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${BRAIN_API_SECRET}`,
    },
    body:   JSON.stringify(payload),
    signal: AbortSignal.timeout(10000),
  });

  if (!res.ok) throw new Error(`Brain API HTTP ${res.status}`);
  console.log('[OBS] Brain POST OK');
}

function buildSummary(s) {
  const fmt = (n, d = 0)   => n != null ? n.toFixed(d) : 'n/a';
  const pct  = (n)          => n != null ? `${n > 0 ? '+' : ''}${n.toFixed(2)}%` : 'n/a';
  const cap  = (n)          => n != null ? `$${(n / 1e12).toFixed(2)}T` : 'n/a';
  const usd  = (n, d = 0)   => n != null ? `$${fmt(n, d)}` : 'n/a';

  return [
    `BTC ${usd(s.btcPrice)} (${pct(s.btcChange24h)} 24h)`,
    `ETH ${usd(s.ethPrice)} (${pct(s.ethChange24h)} 24h)`,
    `Market ${cap(s.totalMarketCap)} · BTC dom ${fmt(s.btcDominance, 1)}%`,
    `Fear & Greed ${s.fearGreedValue ?? 'n/a'} — ${s.fearGreedLabel ?? 'n/a'}`,
    `DXY ${fmt(s.dxy, 2)} · 10Y ${fmt(s.treasury10y, 2)}% · Gold ${usd(s.goldPrice)}/oz`,
  ].join(' | ');
}

module.exports = { runObservation };
