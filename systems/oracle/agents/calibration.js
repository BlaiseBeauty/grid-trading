'use strict';

const { queryAll, queryOne, query } = require('../../../db/connection');

/**
 * Build per-domain conviction multipliers from calibration data.
 * Called at the start of each ORACLE domain agent cycle.
 *
 * Multiplier logic:
 * - directional_accuracy >= 70%: multiplier = 1.1 (domain is well-calibrated)
 * - directional_accuracy 50-70%: multiplier = 1.0 (no adjustment)
 * - directional_accuracy 30-50%: multiplier = 0.9 (reduce conviction)
 * - directional_accuracy <  30%: multiplier = 0.8 (significantly reduce)
 * - Minimum 5 theses required before any adjustment
 */
async function computeMultipliers() {
  const domains = [
    'macro', 'geopolitical', 'technology', 'commodity', 'equity', 'crypto'
  ];

  const multipliers = {};
  for (const domain of domains) multipliers[domain] = 1.0; // default

  // Get latest calibration record per domain
  const calibrations = await queryAll(
    `SELECT DISTINCT ON (domain)
       domain, directional_accuracy, trade_win_rate,
       theses_retired, conviction_multiplier, created_at
     FROM oracle_calibration
     ORDER BY domain, created_at DESC`
  );

  for (const cal of calibrations) {
    if (parseInt(cal.theses_retired) < 5) continue; // not enough data

    const acc = parseFloat(cal.directional_accuracy || 50);
    let mult;
    if      (acc >= 70) mult = 1.1;
    else if (acc >= 50) mult = 1.0;
    else if (acc >= 30) mult = 0.9;
    else                mult = 0.8;

    // Clamp: never go below 0.5 or above 1.5
    multipliers[cal.domain] = Math.max(0.5, Math.min(1.5, mult));
  }

  return multipliers;
}

/**
 * Get recent calibration learnings for injection into agent prompts.
 * Returns the 3 most actionable learnings per domain.
 */
async function getLearningsForDomain(domain) {
  return queryAll(
    `SELECT learning_type, summary, adjustment_rule
     FROM oracle_calibration_learnings
     WHERE domain = $1
       AND created_at > NOW() - INTERVAL '90 days'
     ORDER BY created_at DESC
     LIMIT 3`,
    [domain]
  );
}

/**
 * Get all domain multipliers as a formatted string for agent prompt injection.
 */
async function getMultiplierContext() {
  const mults = await computeMultipliers();
  const lines = Object.entries(mults)
    .filter(([, v]) => v !== 1.0)
    .map(([d, v]) => `  ${d}: ×${v.toFixed(2)} (${v > 1 ? 'well-calibrated' : 'needs improvement'})`);

  if (lines.length === 0) return '';
  return `\nCALIBRATION CONTEXT (apply to your conviction scores):\n${lines.join('\n')}\n`;
}

/**
 * Compute and persist monthly calibration stats for a domain.
 * Called by Graveyard Auditor after each audit run.
 */
async function updateDomainCalibration(domain) {
  const periodLabel = (() => {
    const d = new Date();
    return `month_${d.getFullYear()}_${String(d.getMonth() + 1).padStart(2, '0')}`;
  })();

  const periodStart = new Date();
  periodStart.setDate(1);
  periodStart.setHours(0, 0, 0, 0);

  // Count theses and outcomes for this domain this month
  const stats = await queryOne(
    `SELECT
       COUNT(t.id)                                     AS theses_active,
       COUNT(g.id)                                     AS theses_retired,
       COUNT(g.id) FILTER (WHERE g.directional_hit)    AS directional_hits,
       COUNT(g.id) FILTER (WHERE g.directional_hit IS NOT NULL) AS directional_total
     FROM oracle_theses t
     LEFT JOIN oracle_graveyard g ON g.thesis_id = t.thesis_id
     WHERE t.domain = $1
       AND t.created_at >= $2`,
    [domain, periodStart.toISOString()]
  );

  // Count aligned trade wins
  const tradeStats = await queryOne(
    `SELECT
       COUNT(*) FILTER (WHERE aligned = true)             AS aligned_trades,
       COUNT(*) FILTER (WHERE aligned = true
         AND trade_outcome = 'win')                       AS aligned_wins,
       SUM(pnl_usd) FILTER (WHERE aligned = true)         AS aligned_pnl,
       AVG(conviction_at_trade)                           AS avg_conviction
     FROM thesis_trade_links ttl
     JOIN oracle_theses t ON t.thesis_id = ttl.thesis_id
     WHERE t.domain = $1
       AND ttl.created_at >= $2`,
    [domain, periodStart.toISOString()]
  );

  const dirHits  = parseInt(stats?.directional_hits  || 0);
  const dirTotal = parseInt(stats?.directional_total || 0);
  const dirAcc   = dirTotal > 0 ? (dirHits / dirTotal) * 100 : null;

  const aligned      = parseInt(tradeStats?.aligned_trades || 0);
  const alignedWins  = parseInt(tradeStats?.aligned_wins   || 0);
  const tradeWinRate = aligned > 0 ? (alignedWins / aligned) * 100 : null;

  // Compute multiplier
  let multiplier = 1.0;
  if (dirAcc !== null && parseInt(stats?.theses_retired) >= 5) {
    if      (dirAcc >= 70) multiplier = 1.1;
    else if (dirAcc >= 50) multiplier = 1.0;
    else if (dirAcc >= 30) multiplier = 0.9;
    else                   multiplier = 0.8;
  }

  await query(
    `INSERT INTO oracle_calibration
       (domain, period_label, period_start, period_end,
        theses_active, theses_retired,
        directional_hits, directional_total, directional_accuracy,
        aligned_trades, aligned_wins, aligned_pnl_usd,
        trade_win_rate, avg_conviction_at_call, conviction_multiplier)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
     ON CONFLICT (domain, period_label) DO UPDATE SET
       theses_active = EXCLUDED.theses_active,
       theses_retired = EXCLUDED.theses_retired,
       directional_hits = EXCLUDED.directional_hits,
       directional_total = EXCLUDED.directional_total,
       directional_accuracy = EXCLUDED.directional_accuracy,
       aligned_trades = EXCLUDED.aligned_trades,
       aligned_wins = EXCLUDED.aligned_wins,
       aligned_pnl_usd = EXCLUDED.aligned_pnl_usd,
       trade_win_rate = EXCLUDED.trade_win_rate,
       conviction_multiplier = EXCLUDED.conviction_multiplier`,
    [
      domain, periodLabel, periodStart.toISOString(), new Date().toISOString(),
      parseInt(stats?.theses_active || 0),
      parseInt(stats?.theses_retired || 0),
      dirHits, dirTotal,
      dirAcc ? parseFloat(dirAcc.toFixed(2)) : null,
      aligned, alignedWins,
      parseFloat(tradeStats?.aligned_pnl || 0),
      tradeWinRate ? parseFloat(tradeWinRate.toFixed(2)) : null,
      parseFloat(tradeStats?.avg_conviction || 0),
      multiplier,
    ]
  );

  console.log(
    `[CALIBRATION] ${domain}: accuracy=${dirAcc ? dirAcc.toFixed(1)+'%' : 'N/A'}, ` +
    `multiplier=×${multiplier}`
  );
}

module.exports = {
  computeMultipliers,
  getLearningsForDomain,
  getMultiplierContext,
  updateDomainCalibration,
};
