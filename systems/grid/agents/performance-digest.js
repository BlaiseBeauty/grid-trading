'use strict';

const { queryAll, queryOne, query } = require('../../../db/connection');
const bus = require('../../../shared/intelligence-bus');
const aiCosts = require('../../../shared/ai-costs');

/**
 * Build and publish a performance digest for a given period.
 * Called weekly by cron. Also callable manually for backfill.
 *
 * @param {object} opts
 * @param {Date} opts.start  - period start (default: 7 days ago)
 * @param {Date} opts.end    - period end (default: now)
 */
async function buildDigest(opts = {}) {
  const end   = opts.end   || new Date();
  const start = opts.start || new Date(end.getTime() - 7 * 24 * 60 * 60 * 1000);

  // Period label: week_YYYY_WNN
  const weekNum = getWeekNumber(start);
  const year    = start.getFullYear();
  const periodLabel = `week_${year}_W${String(weekNum).padStart(2, '0')}`;

  console.log(`[DIGEST] Building digest for ${periodLabel} (${start.toISOString()} → ${end.toISOString()})`);

  // ── Fetch all closed trades in period ──────────────────────────────────────
  const trades = await queryAll(
    `SELECT id, symbol, side, entry_price, exit_price,
            pnl_realised AS pnl_usd, pnl_pct, close_reason, created_at, closed_at,
            EXTRACT(EPOCH FROM (closed_at - created_at)) / 3600 AS hold_hours
     FROM trades
     WHERE closed_at BETWEEN $1 AND $2
       AND status = 'closed'
     ORDER BY closed_at DESC`,
    [start.toISOString(), end.toISOString()]
  );

  if (trades.length === 0) {
    console.log(`[DIGEST] No closed trades in period ${periodLabel} — skipping`);
    return null;
  }

  // ── Calculate core metrics ─────────────────────────────────────────────────
  const winners = trades.filter(t => parseFloat(t.pnl_usd) > 0);
  const losers  = trades.filter(t => parseFloat(t.pnl_usd) <= 0);

  const totalPnl    = trades.reduce((s, t) => s + parseFloat(t.pnl_usd), 0);
  const grossProfit = winners.reduce((s, t) => s + parseFloat(t.pnl_usd), 0);
  const grossLoss   = Math.abs(losers.reduce((s, t) => s + parseFloat(t.pnl_usd), 0));
  const winRate     = trades.length > 0 ? (winners.length / trades.length) * 100 : 0;
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : null;

  const avgWin  = winners.length > 0 ? grossProfit / winners.length : 0;
  const avgLoss = losers.length  > 0 ? grossLoss   / losers.length  : 0;
  const avgHold = trades.reduce((s, t) => s + parseFloat(t.hold_hours || 0), 0) / trades.length;

  const sortedPnl   = [...trades].sort((a, b) => parseFloat(b.pnl_usd) - parseFloat(a.pnl_usd));
  const largestWin  = sortedPnl[0] ? parseFloat(sortedPnl[0].pnl_usd)  : 0;
  const largestLoss = sortedPnl[sortedPnl.length - 1]
    ? parseFloat(sortedPnl[sortedPnl.length - 1].pnl_usd) : 0;

  // ── Sharpe ratio (simplified — use daily returns if available) ─────────────
  const sharpe = calculateSimpleSharpe(trades);

  // ── Max drawdown ───────────────────────────────────────────────────────────
  const { maxDrawdownPct, maxDrawdownUsd } = calculateMaxDrawdown(trades);

  // ── Per-symbol breakdown ───────────────────────────────────────────────────
  const bySymbol = {};
  for (const t of trades) {
    if (!bySymbol[t.symbol]) {
      bySymbol[t.symbol] = { trades: 0, pnl_usd: 0, wins: 0 };
    }
    bySymbol[t.symbol].trades++;
    bySymbol[t.symbol].pnl_usd += parseFloat(t.pnl_usd);
    if (parseFloat(t.pnl_usd) > 0) bySymbol[t.symbol].wins++;
  }
  for (const sym of Object.keys(bySymbol)) {
    const s = bySymbol[sym];
    s.win_rate = s.trades > 0 ? ((s.wins / s.trades) * 100).toFixed(1) : '0.0';
    s.pnl_usd  = s.pnl_usd.toFixed(2);
  }

  // ── AI cost for period ─────────────────────────────────────────────────────
  const costRow = await queryOne(
    `SELECT SUM(cost_usd) AS total_cost
     FROM platform_ai_costs
     WHERE source_system = 'grid'
       AND created_at BETWEEN $1 AND $2`,
    [start.toISOString(), end.toISOString()]
  );
  const totalAiCost = parseFloat(costRow?.total_cost || 0);
  const costPerTrade = trades.length > 0 ? totalAiCost / trades.length : 0;

  // ── Assemble digest ────────────────────────────────────────────────────────
  const digest = {
    period_start:      start.toISOString(),
    period_end:        end.toISOString(),
    period_label:      periodLabel,
    total_trades:      trades.length,
    winning_trades:    winners.length,
    losing_trades:     losers.length,
    win_rate:          winRate.toFixed(2),
    total_pnl_usd:     totalPnl.toFixed(2),
    avg_win_usd:       avgWin.toFixed(2),
    avg_loss_usd:      avgLoss.toFixed(2),
    largest_win_usd:   largestWin.toFixed(2),
    largest_loss_usd:  largestLoss.toFixed(2),
    profit_factor:     profitFactor ? profitFactor.toFixed(4) : null,
    sharpe_ratio:      sharpe ? sharpe.toFixed(4) : null,
    max_drawdown_pct:  maxDrawdownPct ? maxDrawdownPct.toFixed(4) : null,
    max_drawdown_usd:  maxDrawdownUsd ? maxDrawdownUsd.toFixed(2) : null,
    avg_hold_hours:    avgHold.toFixed(2),
    by_symbol:         bySymbol,
    total_ai_cost_usd: totalAiCost.toFixed(4),
    cost_per_trade:    costPerTrade.toFixed(6),
    trade_ids:         trades.map(t => t.id),
    top_signals:       [],  // TODO: enrich from signals table
    worst_signals:     [],
    best_regime:       null,
    worst_regime:      null,
  };

  // ── Persist to DB ──────────────────────────────────────────────────────────
  await query(
    `INSERT INTO grid_performance_digests (
       period_start, period_end, period_label,
       total_trades, winning_trades, losing_trades, win_rate,
       total_pnl_usd, avg_win_usd, avg_loss_usd,
       largest_win_usd, largest_loss_usd, profit_factor,
       sharpe_ratio, max_drawdown_pct, max_drawdown_usd,
       avg_hold_hours, by_symbol, total_ai_cost_usd, cost_per_trade,
       trade_ids
     ) VALUES (
       $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,
       $11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21
     )
     ON CONFLICT (period_label) DO UPDATE SET
       total_trades = EXCLUDED.total_trades,
       winning_trades = EXCLUDED.winning_trades,
       losing_trades = EXCLUDED.losing_trades,
       win_rate = EXCLUDED.win_rate,
       total_pnl_usd = EXCLUDED.total_pnl_usd,
       sharpe_ratio = EXCLUDED.sharpe_ratio,
       max_drawdown_pct = EXCLUDED.max_drawdown_pct,
       total_ai_cost_usd = EXCLUDED.total_ai_cost_usd,
       cost_per_trade = EXCLUDED.cost_per_trade`,
    [
      digest.period_start, digest.period_end, digest.period_label,
      digest.total_trades, digest.winning_trades, digest.losing_trades,
      digest.win_rate, digest.total_pnl_usd, digest.avg_win_usd,
      digest.avg_loss_usd, digest.largest_win_usd, digest.largest_loss_usd,
      digest.profit_factor, digest.sharpe_ratio, digest.max_drawdown_pct,
      digest.max_drawdown_usd, digest.avg_hold_hours,
      JSON.stringify(digest.by_symbol), digest.total_ai_cost_usd,
      digest.cost_per_trade, digest.trade_ids,
    ]
  );

  // ── Publish to intelligence bus ────────────────────────────────────────────
  // ORACLE will read this on its next cycle to calibrate conviction scoring
  try {
    await bus.publish({
      source_system: 'grid',
      event_type: 'performance_digest',
      payload: digest,
      expires_at: null,  // permanent — never expires
    });
    console.log(`[DIGEST] Published performance_digest to bus for ${periodLabel}`);
  } catch (err) {
    console.error('[DIGEST] Failed to publish to bus:', err.message);
    // Don't fail — digest is saved to DB regardless
  }

  console.log(
    `[DIGEST] ${periodLabel}: ${trades.length} trades, ` +
    `${winRate.toFixed(1)}% win rate, ` +
    `P&L $${totalPnl.toFixed(2)}, ` +
    `Sharpe ${sharpe ? sharpe.toFixed(2) : 'N/A'}`
  );

  return digest;
}

// ── HELPERS ───────────────────────────────────────────────────────────────────

function calculateSimpleSharpe(trades) {
  if (trades.length < 3) return null;
  const returns = trades.map(t => parseFloat(t.pnl_pct) / 100);
  const mean    = returns.reduce((s, r) => s + r, 0) / returns.length;
  const variance = returns.reduce((s, r) => s + Math.pow(r - mean, 2), 0) / returns.length;
  const stdDev  = Math.sqrt(variance);
  if (stdDev === 0) return null;
  // Annualised (assuming ~2 trades/day average)
  return (mean / stdDev) * Math.sqrt(252 * 2);
}

function calculateMaxDrawdown(trades) {
  if (trades.length === 0) return { maxDrawdownPct: null, maxDrawdownUsd: null };

  let cumPnl = 0;
  let maxDrawdownUsd = 0;
  let peakPnl = 0;

  for (const t of [...trades].reverse()) { // oldest first
    cumPnl += parseFloat(t.pnl_usd);
    if (cumPnl > peakPnl) peakPnl = cumPnl;
    const drawdown = peakPnl - cumPnl;
    if (drawdown > maxDrawdownUsd) maxDrawdownUsd = drawdown;
  }

  const maxDrawdownPct = peakPnl > 0 ? (maxDrawdownUsd / peakPnl) * 100 : null;
  return { maxDrawdownPct, maxDrawdownUsd };
}

function getWeekNumber(date) {
  const d    = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
}

module.exports = { buildDigest };
