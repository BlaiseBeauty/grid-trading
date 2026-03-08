/**
 * Live Trading Readiness Gate
 *
 * Checks 5 conditions that must ALL pass before LIVE_TRADING_ENABLED=true is allowed.
 * Called at boot (blocks startup if live mode enabled but conditions not met)
 * and exposed via GET /api/system/readiness for the Settings UI.
 */

const { queryOne } = require('../db/connection');

async function checkLiveTradingReadiness() {
  const conditions = [];

  // 1. Closed trades >= 300
  try {
    const row = await queryOne("SELECT COUNT(*) as count FROM trades WHERE status = 'closed'");
    const current = parseInt(row.count);
    conditions.push({
      key: 'closed_trades',
      label: 'Closed Trades',
      current,
      required: '>= 300',
      passed: current >= 300,
    });
  } catch (err) {
    conditions.push({ key: 'closed_trades', label: 'Closed Trades', current: 'error', required: '>= 300', passed: false });
  }

  // 2. Win rate (last 50 trades) >= 52%
  try {
    const row = await queryOne(`
      SELECT ROUND(
        SUM(CASE WHEN pnl_realised > 0 THEN 1 ELSE 0 END)::numeric
        / NULLIF(COUNT(*), 0) * 100, 1
      ) as win_rate
      FROM (
        SELECT pnl_realised FROM trades
        WHERE status = 'closed'
        ORDER BY closed_at DESC
        LIMIT 50
      ) t
    `);
    const current = parseFloat(row.win_rate || 0);
    conditions.push({
      key: 'win_rate',
      label: 'Win Rate (last 50)',
      current: current + '%',
      required: '>= 52%',
      passed: current >= 52,
    });
  } catch (err) {
    conditions.push({ key: 'win_rate', label: 'Win Rate (last 50)', current: 'error', required: '>= 52%', passed: false });
  }

  // 3. Active learnings >= 10
  try {
    const row = await queryOne("SELECT COUNT(*) as count FROM learnings WHERE stage = 'active'");
    const current = parseInt(row.count);
    conditions.push({
      key: 'active_learnings',
      label: 'Active Learnings',
      current,
      required: '>= 10',
      passed: current >= 10,
    });
  } catch (err) {
    conditions.push({ key: 'active_learnings', label: 'Active Learnings', current: 'error', required: '>= 10', passed: false });
  }

  // 4. Sharpe ratio (30d) > 0
  try {
    const row = await queryOne(`
      SELECT CASE
        WHEN STDDEV(dr) > 0 THEN ROUND((AVG(dr) / STDDEV(dr) * SQRT(365))::numeric, 2)
        ELSE 0
      END as sharpe
      FROM (
        SELECT DATE(closed_at) as d, SUM(pnl_pct) as dr
        FROM trades
        WHERE status = 'closed' AND closed_at > NOW() - INTERVAL '30 days'
        GROUP BY DATE(closed_at)
      ) t
    `);
    const current = parseFloat(row.sharpe || 0);
    conditions.push({
      key: 'sharpe',
      label: 'Sharpe Ratio (30d)',
      current,
      required: '> 0',
      passed: current > 0,
    });
  } catch (err) {
    conditions.push({ key: 'sharpe', label: 'Sharpe Ratio (30d)', current: 'error', required: '> 0', passed: false });
  }

  // 5. Unresolved learning conflicts = 0
  try {
    const row = await queryOne('SELECT COUNT(*) as count FROM learning_conflicts WHERE resolved_at IS NULL');
    const current = parseInt(row.count);
    conditions.push({
      key: 'conflicts',
      label: 'Unresolved Conflicts',
      current,
      required: '= 0',
      passed: current === 0,
    });
  } catch (err) {
    conditions.push({ key: 'conflicts', label: 'Unresolved Conflicts', current: 'error', required: '= 0', passed: false });
  }

  return {
    ready: conditions.every(c => c.passed),
    conditions,
    checked_at: new Date(),
  };
}

module.exports = { checkLiveTradingReadiness };
