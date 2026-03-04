/**
 * Correlation Calculator — computes Pearson correlation coefficients
 * between all tracked crypto pairs using 30 days of daily close prices.
 * Results are stored in the correlation_matrix table.
 */

const { queryAll, query } = require('../db/connection');
const { symbols: trackedSymbols } = require('../config/symbols');

const LOOKBACK_DAYS = 30;
const SYMBOL_NAMES = trackedSymbols.map(s => s.symbol);

// All unique pairs
const PAIRS = [];
for (let i = 0; i < SYMBOL_NAMES.length; i++) {
  for (let j = i + 1; j < SYMBOL_NAMES.length; j++) {
    PAIRS.push([SYMBOL_NAMES[i], SYMBOL_NAMES[j]]);
  }
}

/**
 * Compute Pearson correlation coefficient between two arrays of numbers.
 * Returns null if insufficient data.
 */
function pearson(x, y) {
  const n = Math.min(x.length, y.length);
  if (n < 5) return null; // need at least 5 data points

  const meanX = x.reduce((s, v) => s + v, 0) / n;
  const meanY = y.reduce((s, v) => s + v, 0) / n;

  let sumXY = 0, sumX2 = 0, sumY2 = 0;
  for (let i = 0; i < n; i++) {
    const dx = x[i] - meanX;
    const dy = y[i] - meanY;
    sumXY += dx * dy;
    sumX2 += dx * dx;
    sumY2 += dy * dy;
  }

  const denom = Math.sqrt(sumX2 * sumY2);
  if (denom === 0) return 0;
  return sumXY / denom;
}

/**
 * Fetch daily closing prices for a symbol over the last N days.
 * Tries 1d candles first, falls back to last 4h candle per day.
 */
async function getDailyCloses(symbol) {
  // Try 1d timeframe first
  let rows = await queryAll(`
    SELECT close, DATE(timestamp) as day
    FROM market_data
    WHERE symbol = $1 AND timeframe = '1d'
      AND timestamp >= NOW() - INTERVAL '${LOOKBACK_DAYS} days'
    ORDER BY timestamp ASC
  `, [symbol]);

  // Fallback: use last 4h candle per day if no 1d data
  if (rows.length < 5) {
    rows = await queryAll(`
      SELECT DISTINCT ON (DATE(timestamp))
        close, DATE(timestamp) as day
      FROM market_data
      WHERE symbol = $1 AND timeframe = '4h'
        AND timestamp >= NOW() - INTERVAL '${LOOKBACK_DAYS} days'
      ORDER BY DATE(timestamp), timestamp DESC
    `, [symbol]);
  }

  return rows.map(r => ({
    day: r.day,
    close: parseFloat(r.close),
  }));
}

/**
 * Compute correlations for all pairs and store in correlation_matrix.
 * Returns the correlation object for use by the risk manager.
 */
async function computeCorrelations() {
  // Fetch daily closes for all symbols
  const closesMap = {};
  for (const symbol of SYMBOL_NAMES) {
    closesMap[symbol] = await getDailyCloses(symbol);
  }

  const result = { computed_at: new Date().toISOString() };

  for (const [symA, symB] of PAIRS) {
    const closesA = closesMap[symA];
    const closesB = closesMap[symB];

    // Align by date — only keep days both symbols have data for
    const dayMapA = new Map(closesA.map(c => [c.day.toISOString(), c.close]));
    const alignedA = [];
    const alignedB = [];
    for (const cb of closesB) {
      const dayKey = cb.day.toISOString();
      if (dayMapA.has(dayKey)) {
        alignedA.push(dayMapA.get(dayKey));
        alignedB.push(cb.close);
      }
    }

    const corr = pearson(alignedA, alignedB);
    const pairKey = `${symA.split('/')[0]}_${symB.split('/')[0]}`;
    result[pairKey] = corr !== null ? Math.round(corr * 10000) / 10000 : null;

    // Store in DB
    if (corr !== null) {
      await query(`
        INSERT INTO correlation_matrix (symbol_a, symbol_b, correlation, lookback_days, calculated_at)
        VALUES ($1, $2, $3, $4, NOW())
      `, [symA, symB, Math.round(corr * 10000) / 10000, LOOKBACK_DAYS]);
    }

    console.log(`[CORRELATION] ${pairKey}: ${corr !== null ? corr.toFixed(4) : 'insufficient data'} (${alignedA.length} aligned days)`);
  }

  return result;
}

/**
 * Get the latest correlations from the DB (cached).
 * Returns { BTC_ETH: 0.91, BTC_SOL: 0.87, ETH_SOL: 0.89, computed_at: ... }
 * Falls back to 0.85 default if no data (conservative assumption for crypto).
 */
async function getLatestCorrelations() {
  const rows = await queryAll(`
    SELECT DISTINCT ON (symbol_a, symbol_b)
      symbol_a, symbol_b, correlation, calculated_at
    FROM correlation_matrix
    ORDER BY symbol_a, symbol_b, calculated_at DESC
  `);

  if (rows.length === 0) {
    // No correlations computed yet — return conservative defaults
    const defaults = { computed_at: null };
    for (const [symA, symB] of PAIRS) {
      const pairKey = `${symA.split('/')[0]}_${symB.split('/')[0]}`;
      defaults[pairKey] = 0.85; // Conservative default for crypto
    }
    return defaults;
  }

  const result = { computed_at: rows[0]?.calculated_at };
  for (const row of rows) {
    const pairKey = `${row.symbol_a.split('/')[0]}_${row.symbol_b.split('/')[0]}`;
    result[pairKey] = parseFloat(row.correlation);
  }
  return result;
}

module.exports = { computeCorrelations, getLatestCorrelations, pearson };
