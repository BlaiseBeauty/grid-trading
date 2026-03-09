'use strict';

const { query, queryAll, queryOne } = require('../db/connection');

/**
 * Called when a GRID trade closes.
 * Finds all active ORACLE theses at close time and records alignment.
 *
 * @param {object} trade - closed trade record
 * @param {number} trade.id
 * @param {string} trade.symbol  - e.g. 'BTC'
 * @param {string} trade.side    - 'buy' | 'sell'
 * @param {number} trade.pnl_usd
 * @param {number} trade.pnl_pct
 * @param {string} trade.close_reason
 * @param {number} trade.hold_hours
 */
async function linkTradeToTheses(trade) {
  try {
    // Get all active theses that mention this symbol in their assets
    const symbol = trade.symbol?.replace(/\/.*$/, ''); // 'BTC/USDT' → 'BTC'
    const theses = await queryAll(
      `SELECT thesis_id, direction, conviction
       FROM oracle_theses
       WHERE status = 'active'
         AND ($1 = ANY(long_assets) OR $1 = ANY(short_assets) OR $1 = ANY(watch_assets))`,
      [symbol]
    );
    if (!theses.length) return;

    const tradeDirection = trade.side === 'buy' ? 'bull' : 'bear';
    const pnlUsd = parseFloat(trade.pnl_usd || 0);
    const outcome = pnlUsd > 0.5 ? 'win' : pnlUsd < -0.5 ? 'loss' : 'breakeven';

    for (const thesis of theses) {
      const aligned = thesis.direction === tradeDirection;

      try {
        await query(
          `INSERT INTO thesis_trade_links
             (thesis_id, trade_id, symbol, aligned,
              pnl_usd, pnl_pct, trade_outcome, close_reason,
              hold_hours, conviction_at_trade)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
           ON CONFLICT (thesis_id, trade_id) DO NOTHING`,
          [
            thesis.thesis_id,
            trade.id,
            symbol,
            aligned,
            pnlUsd,
            parseFloat(trade.pnl_pct || 0),
            outcome,
            trade.close_reason || null,
            parseFloat(trade.hold_hours || 0),
            parseFloat(thesis.conviction || 0),
          ]
        );
      } catch (err) {
        // Skip individual link failures
      }
    }

    console.log(`[THESIS-LINKER] Trade ${trade.id} linked to ${theses.length} theses`);
  } catch (err) {
    // Never fail trade close because of linking failure
    console.warn('[THESIS-LINKER] Linking failed (non-critical):', err.message);
  }
}

/**
 * Get all trade links for a thesis — used by Graveyard Auditor.
 */
async function getTradeLinksForThesis(thesisId) {
  return queryAll(
    `SELECT * FROM thesis_trade_links
     WHERE thesis_id = $1
     ORDER BY created_at DESC`,
    [thesisId]
  );
}

/**
 * Get summary stats for a thesis — used in post-mortem generation.
 */
async function getThesisTradeStats(thesisId) {
  return queryOne(
    `SELECT
       COUNT(*)                                     AS total_trades,
       COUNT(*) FILTER (WHERE aligned = true)       AS aligned_trades,
       COUNT(*) FILTER (WHERE aligned = true
         AND trade_outcome = 'win')                 AS aligned_wins,
       SUM(pnl_usd) FILTER (WHERE aligned = true)   AS aligned_pnl,
       AVG(conviction_at_trade)                     AS avg_conviction
     FROM thesis_trade_links
     WHERE thesis_id = $1`,
    [thesisId]
  );
}

module.exports = { linkTradeToTheses, getTradeLinksForThesis, getThesisTradeStats };
