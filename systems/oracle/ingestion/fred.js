'use strict';

const https = require('https');
const { query, queryAll } = require('../../../db/connection');

// FRED series we track for ORACLE macro context
// All freely available. API key optional but recommended for prod.
const FRED_SERIES = [
  // Interest rates & yield curve
  { id: 'DGS10',    name: '10Y Treasury Yield',        category: 'rates',     unit: 'percent' },
  { id: 'DGS2',     name: '2Y Treasury Yield',         category: 'rates',     unit: 'percent' },
  { id: 'T10Y2Y',   name: '10Y-2Y Yield Spread',       category: 'rates',     unit: 'percent' },
  { id: 'FEDFUNDS', name: 'Fed Funds Rate',             category: 'rates',     unit: 'percent' },
  { id: 'BAMLH0A0HYM2', name: 'HY Credit Spread',      category: 'credit',    unit: 'percent' },
  // Inflation & growth
  { id: 'CPIAUCSL', name: 'CPI YoY',                   category: 'inflation', unit: 'percent' },
  { id: 'UNRATE',   name: 'Unemployment Rate',          category: 'employment',unit: 'percent' },
  { id: 'GDPC1',    name: 'Real GDP Growth',            category: 'growth',    unit: 'percent' },
  // Dollar & liquidity
  { id: 'DTWEXBGS', name: 'Trade Weighted USD Index',   category: 'dollar',    unit: 'index'   },
  { id: 'M2SL',     name: 'M2 Money Supply',            category: 'liquidity', unit: 'billions'},
];

const FRED_BASE = 'https://fred.stlouisfed.org/graph/fredgraph.csv?id=';
const FRED_API  = 'https://api.stlouisfed.org/fred/series/observations';

async function fetchSeries(seriesId) {
  return new Promise((resolve, reject) => {
    const apiKey = process.env.FRED_API_KEY || '';
    let url;

    if (apiKey) {
      // Use JSON API if key available — more reliable
      url = `${FRED_API}?series_id=${seriesId}&api_key=${apiKey}` +
            `&file_type=json&sort_order=desc&limit=5`;
    } else {
      // Fall back to CSV endpoint (no key needed but rate-limited)
      url = `${FRED_BASE}${seriesId}`;
    }

    https.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          if (apiKey) {
            const json = JSON.parse(data);
            const obs  = json.observations || [];
            const latest = obs.find(o => o.value !== '.' && o.value !== '');
            resolve({
              seriesId,
              value: latest ? parseFloat(latest.value) : null,
              date:  latest ? latest.date : null,
            });
          } else {
            // Parse CSV: date,value pairs, last line is latest
            const lines = data.trim().split('\n').filter(l => !l.startsWith('DATE'));
            const last  = lines[lines.length - 1];
            if (!last) return resolve({ seriesId, value: null, date: null });
            const [date, value] = last.split(',');
            resolve({ seriesId, value: parseFloat(value), date });
          }
        } catch (err) {
          reject(new Error(`FRED parse error for ${seriesId}: ${err.message}`));
        }
      });
    }).on('error', err => reject(err));
  });
}

async function ingestFred() {
  console.log('[FRED] Starting macro data ingestion...');
  const results = {};
  const errors  = [];

  // Fetch all series with a small delay to avoid rate limits
  for (const series of FRED_SERIES) {
    try {
      await new Promise(r => setTimeout(r, 200)); // 200ms between requests
      const data = await fetchSeries(series.id);

      if (data.value !== null) {
        results[series.id] = {
          name:     series.name,
          category: series.category,
          unit:     series.unit,
          value:    data.value,
          date:     data.date,
        };
        console.log(`[FRED] ${series.id}: ${data.value} (${data.date})`);
      } else {
        console.warn(`[FRED] ${series.id}: no data returned`);
      }
    } catch (err) {
      errors.push({ series: series.id, error: err.message });
      console.error(`[FRED] ${series.id} failed:`, err.message);
    }
  }

  // Calculate derived metrics
  if (results['DGS10'] && results['DGS2']) {
    results['YIELD_SPREAD'] = {
      name: '10Y-2Y Spread (calculated)',
      category: 'rates',
      unit: 'percent',
      value: results['T10Y2Y']?.value ??
             (results['DGS10'].value - results['DGS2'].value),
      date: results['DGS10'].date,
    };
  }

  // Store each data point as oracle_evidence
  for (const [seriesId, data] of Object.entries(results)) {
    const contentHash = require('crypto')
      .createHash('sha256')
      .update(`fred_${seriesId}_${data.date}`)
      .digest('hex');

    try {
      await query(
        `INSERT INTO oracle_evidence
           (source_type, source_name, headline, content, published_at,
            domain_tags, content_hash, relevance_score, sentiment)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (content_hash) DO NOTHING`,
        [
          'fred_macro', 'FRED',
          `${data.name}: ${data.value} ${data.unit}`,
          JSON.stringify(data),
          data.date ? new Date(data.date) : new Date(),
          [data.category, 'macro'],
          contentHash,
          7.0, // FRED data is always highly relevant to macro analysis
          null,
        ]
      );
    } catch (err) {
      console.error(`[FRED] DB insert failed for ${seriesId}:`, err.message);
    }
  }

  console.log(
    `[FRED] Ingestion complete: ${Object.keys(results).length} series, ` +
    `${errors.length} errors`
  );

  return { results, errors };
}

module.exports = { ingestFred, FRED_SERIES };
