'use strict';

const { query, queryAll } = require('../../../db/connection');

/**
 * Persist discovered patterns to grid_signal_patterns.
 * Upserts by pattern_id — updates stats if pattern already known.
 */
async function persistPatterns(patterns) {
  for (const p of patterns) {
    try {
      await query(
        `INSERT INTO grid_signal_patterns
           (pattern_id, symbol, regime, signal_types, signal_direction,
            sample_size, win_rate, avg_pnl_pct, status, description, conditions,
            last_seen_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW(),NOW())
         ON CONFLICT (pattern_id) DO UPDATE SET
           sample_size   = GREATEST(grid_signal_patterns.sample_size, EXCLUDED.sample_size),
           win_rate      = EXCLUDED.win_rate,
           avg_pnl_pct   = EXCLUDED.avg_pnl_pct,
           status        = CASE
             WHEN EXCLUDED.sample_size >= 15 AND EXCLUDED.win_rate >= 65
             THEN 'confirmed'
             ELSE grid_signal_patterns.status
           END,
           description   = EXCLUDED.description,
           last_seen_at  = NOW(),
           updated_at    = NOW()`,
        [
          p.pattern_id,
          p.symbol,
          p.regime || null,
          p.signal_types,
          p.signal_direction,
          parseInt(p.sample_trades || 0),
          parseFloat(p.win_rate || 0),
          parseFloat(p.avg_pnl_pct || 0),
          p.confidence === 'confirmed' ? 'confirmed' : 'emerging',
          p.description || null,
          p.conditions || null,
        ]
      );
      console.log(`[PATTERN-STORE] Upserted: ${p.pattern_id} (${p.signal_types?.join('+')})`);
    } catch (err) {
      console.error(`[PATTERN-STORE] Failed to persist ${p.pattern_id}:`, err.message);
    }
  }
}

/**
 * Get confirmed patterns for a symbol — injected into Synthesizer context.
 */
async function getConfirmedPatterns(symbol) {
  return queryAll(
    `SELECT pattern_id, signal_types, signal_direction, win_rate, description, conditions
     FROM grid_signal_patterns
     WHERE symbol = $1 AND status = 'confirmed'
     ORDER BY win_rate DESC LIMIT 5`,
    [symbol]
  );
}

/**
 * Get all patterns summary for API / dashboard.
 */
async function getAllPatterns() {
  return queryAll(
    `SELECT * FROM grid_signal_patterns
     ORDER BY status DESC, win_rate DESC NULLS LAST`
  );
}

module.exports = { persistPatterns, getConfirmedPatterns, getAllPatterns };
