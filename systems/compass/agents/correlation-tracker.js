'use strict';

const { queryAll, queryOne, query } = require('../../../db/connection');

/**
 * Calculate rolling correlation between GRID symbols using recent trade P&L.
 * Simple proxy: correlated symbols tend to both win or both lose together.
 * Real correlation requires price series — this is a trade-outcome proxy.
 */
async function calculateCorrelations() {
  // Get last 30 days of closed trades, grouped by day and symbol
  const trades = await queryAll(
    `SELECT symbol, side, pnl_pct,
            DATE_TRUNC('day', closed_at) AS day
     FROM trades
     WHERE status = 'closed'
       AND closed_at > NOW() - INTERVAL '30 days'
     ORDER BY day, symbol`
  );

  if (trades.length < 10) {
    return {}; // Not enough data
  }

  // Group by day → symbol → average pnl_pct
  const byDay = {};
  for (const t of trades) {
    const day = t.day.toISOString().split('T')[0];
    if (!byDay[day]) byDay[day] = {};
    if (!byDay[day][t.symbol]) byDay[day][t.symbol] = [];
    byDay[day][t.symbol].push(parseFloat(t.pnl_pct));
  }

  // Get symbols with enough data
  const symbolCounts = {};
  for (const day of Object.values(byDay)) {
    for (const sym of Object.keys(day)) {
      symbolCounts[sym] = (symbolCounts[sym] || 0) + 1;
    }
  }
  const symbols = Object.keys(symbolCounts).filter(s => symbolCounts[s] >= 5);

  if (symbols.length < 2) return {};

  // Build daily return series per symbol
  const series = {};
  const days   = Object.keys(byDay).sort();
  for (const sym of symbols) {
    series[sym] = days.map(d => {
      const vals = byDay[d]?.[sym];
      return vals ? vals.reduce((s, v) => s + v, 0) / vals.length : null;
    });
  }

  // Calculate pairwise correlation
  const correlations = {};
  for (let i = 0; i < symbols.length; i++) {
    for (let j = i + 1; j < symbols.length; j++) {
      const a = symbols[i];
      const b = symbols[j];

      // Filter to days where both have data
      const pairs = days
        .map((_, idx) => [series[a][idx], series[b][idx]])
        .filter(([x, y]) => x !== null && y !== null);

      if (pairs.length < 5) continue;

      const n  = pairs.length;
      const xs = pairs.map(p => p[0]);
      const ys = pairs.map(p => p[1]);

      const meanX = xs.reduce((s, v) => s + v, 0) / n;
      const meanY = ys.reduce((s, v) => s + v, 0) / n;

      const cov = pairs.reduce((s, [x, y]) => s + (x - meanX) * (y - meanY), 0) / n;
      const stdX = Math.sqrt(xs.reduce((s, x) => s + Math.pow(x - meanX, 2), 0) / n);
      const stdY = Math.sqrt(ys.reduce((s, y) => s + Math.pow(y - meanY, 2), 0) / n);

      if (stdX === 0 || stdY === 0) continue;

      const corr = cov / (stdX * stdY);
      correlations[`${a}_${b}`] = parseFloat(corr.toFixed(4));
    }
  }

  // Persist snapshot
  if (Object.keys(correlations).length > 0) {
    await query(
      `INSERT INTO compass_correlation_snapshots (correlations)
       VALUES ($1)`,
      [JSON.stringify(correlations)]
    );
  }

  return correlations;
}

/**
 * Get the latest correlation snapshot.
 */
async function getLatestCorrelations() {
  const row = await queryOne(
    `SELECT correlations FROM compass_correlation_snapshots
     ORDER BY created_at DESC LIMIT 1`
  );
  return row?.correlations || {};
}

module.exports = { calculateCorrelations, getLatestCorrelations };
