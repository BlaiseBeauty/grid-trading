'use strict';

/**
 * Read-only helpers over GRID's portfolio/trade tables for OTHER systems (COMPASS).
 * COMPASS must not embed raw SQL against GRID tables; it calls these instead, so a GRID
 * schema change has exactly one place to be fixed.
 */

const { queryAll, queryOne } = require('../db/connection');

/** Open positions with market value, largest first. */
async function getOpenPositions() {
  return queryAll(
    `SELECT symbol, quantity, avg_entry_price, current_price,
            unrealised_pnl, unrealised_pnl_pct,
            ROUND(quantity * current_price, 2) AS market_value
     FROM portfolio_state
     WHERE quantity > 0
     ORDER BY quantity * current_price DESC`
  );
}

/** Most recent closed trades (default 20). */
async function getRecentClosedTrades(limit = 20) {
  const n = Math.max(1, Math.min(200, parseInt(limit, 10) || 20));
  return queryAll(
    `SELECT symbol, side, pnl_realised, pnl_pct, close_reason, closed_at
     FROM trades WHERE status = 'closed'
     ORDER BY closed_at DESC LIMIT $1`,
    [n]
  );
}

/** Closed trades with a day bucket over the last N days (for correlation tracking). */
async function getClosedTradesByDay(days = 30) {
  const n = Math.max(1, Math.min(365, parseInt(days, 10) || 30));
  return queryAll(
    `SELECT symbol, side, pnl_pct,
            DATE_TRUNC('day', closed_at) AS day
     FROM trades
     WHERE status = 'closed'
       AND closed_at > NOW() - ($1::int * INTERVAL '1 day')
     ORDER BY day, symbol`,
    [n]
  );
}

/** Latest market regime row (or null). */
async function getLatestRegime() {
  return queryOne('SELECT regime, confidence, created_at FROM market_regime ORDER BY created_at DESC LIMIT 1');
}

module.exports = { getOpenPositions, getRecentClosedTrades, getClosedTradesByDay, getLatestRegime };
