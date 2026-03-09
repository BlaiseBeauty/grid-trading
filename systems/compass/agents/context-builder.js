'use strict';

const { queryAll, queryOne } = require('../../../db/connection');
const bus = require('../../../shared/intelligence-bus');

/**
 * Build full context for COMPASS agents.
 * Reads: ORACLE theses (via bus), GRID performance (via bus + DB),
 * current open positions (direct DB), recent P&L.
 */
async function buildCompassContext() {
  const [
    activeTheses,
    allocationGuidance,
    latestDigest,
    openPositions,
    recentTrades,
    latestRisk,
  ] = await Promise.all([
    // ORACLE theses (via bus)
    bus.getAllActiveTheses().catch(() => []),

    // Latest COMPASS allocation (for continuity — what did we say last cycle?)
    queryOne(
      `SELECT recommended_weights, cash_weight, risk_posture, created_at
       FROM compass_portfolios ORDER BY created_at DESC LIMIT 1`
    ).catch(() => null),

    // Latest GRID performance digest (via bus)
    bus.getLatestPerformanceDigest().catch(() => null),

    // Current open positions (from portfolio_state — actual schema)
    queryAll(
      `SELECT symbol, quantity, avg_entry_price, current_price,
              unrealised_pnl, unrealised_pnl_pct,
              ROUND(quantity * current_price, 2) AS market_value
       FROM portfolio_state
       WHERE quantity > 0
       ORDER BY quantity * current_price DESC`
    ).catch(() => []),

    // Recent trade performance (last 20 closed trades — actual schema)
    queryAll(
      `SELECT symbol, side, pnl_realised, pnl_pct, close_reason, closed_at
       FROM trades WHERE status = 'closed'
       ORDER BY closed_at DESC LIMIT 20`
    ).catch(() => []),

    // Latest risk assessment
    queryOne(
      `SELECT risk_score, max_total_exposure_usd, max_single_position_usd,
              flags, created_at
       FROM compass_risk_assessments ORDER BY created_at DESC LIMIT 1`
    ).catch(() => null),
  ]);

  // Format theses for agent consumption
  const thesisSummary = activeTheses.length > 0
    ? activeTheses.map(t => {
        const p = typeof t.payload === 'string' ? JSON.parse(t.payload) : t.payload;
        return `- [${(t.direction || '?').toUpperCase()}] ${p?.name || 'Unnamed'} ` +
               `(${t.time_horizon || '?'}, conviction ${t.conviction}/10): ` +
               `Long: ${(p?.long_assets || []).join(',')||'none'} | ` +
               `Short: ${(p?.short_assets || []).join(',')||'none'}`;
      }).join('\n')
    : 'No active ORACLE theses.';

  // Format GRID performance
  let performanceSummary = 'No performance data available.';
  if (latestDigest?.payload) {
    const d = typeof latestDigest.payload === 'string'
      ? JSON.parse(latestDigest.payload) : latestDigest.payload;
    performanceSummary =
      `Period: ${d.period_label || 'unknown'}\n` +
      `Trades: ${d.total_trades} | Win Rate: ${d.win_rate}% | P&L: $${d.total_pnl_usd}\n` +
      `Sharpe: ${d.sharpe_ratio || 'N/A'} | Max Drawdown: ${d.max_drawdown_pct || 'N/A'}%\n` +
      `AI Cost/Trade: $${d.cost_per_trade || '0'}`;
  }

  // Format open positions (adapted for portfolio_state schema)
  const positionsSummary = openPositions.length > 0
    ? openPositions.map(p =>
        `${p.symbol} $${parseFloat(p.market_value || 0).toFixed(2)} ` +
        `(entry $${parseFloat(p.avg_entry_price || 0).toFixed(2)}, ` +
        `P&L ${parseFloat(p.unrealised_pnl_pct || 0).toFixed(2)}%)`
      ).join('\n')
    : 'No open positions.';

  // Calculate current exposure
  const totalExposureUsd = openPositions.reduce(
    (s, p) => s + parseFloat(p.market_value || 0), 0
  );

  // Symbols in recent trades (for correlation context)
  const recentSymbols = [...new Set(recentTrades.map(t => t.symbol))];

  // Previous COMPASS posture (for continuity)
  const previousPosture = allocationGuidance
    ? `${allocationGuidance.risk_posture} (set ${allocationGuidance.created_at})`
    : 'No previous posture.';

  return {
    // For agents
    thesisSummary,
    performanceSummary,
    positionsSummary,
    previousPosture,

    // Raw data for calculations
    activeTheses,
    openPositions,
    recentTrades,
    totalExposureUsd,
    recentSymbols,
    latestRisk,
    latestDigest,
  };
}

module.exports = { buildCompassContext };
