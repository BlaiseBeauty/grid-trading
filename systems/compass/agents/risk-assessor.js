'use strict';

const CompassBaseAgent     = require('./base-agent');
const { buildCompassContext } = require('./context-builder');
const { query, queryOne }  = require('../../../db/connection');
const bus                  = require('../../../shared/intelligence-bus');

const RISK_SYSTEM_PROMPT = `You are the COMPASS Risk Assessor.
You review the current GRID trading portfolio against macro context and
compute a risk score and hard limits. Your output directly governs
GRID's maximum position sizes.

RISK SCORE SCALE (0–10):
0–3:  Low risk — GRID can operate aggressively
4–6:  Moderate risk — normal GRID operation
7–8:  Elevated risk — reduce position sizes, increase caution
9–10: High risk — minimal new positions, prioritise closing

OUTPUT: Return ONLY valid JSON matching this schema:
{
  "risk_score": 5.5,
  "components": {
    "market_risk": 6.0,
    "concentration_risk": 4.0,
    "correlation_risk": 5.5,
    "drawdown_risk": 3.0,
    "thesis_conflict_risk": 6.0
  },
  "limits": {
    "max_total_exposure_usd": 15000,
    "max_single_position_usd": 5000,
    "max_open_positions": 4,
    "scram_threshold_pct": 8.0
  },
  "flags": [
    {"severity": "warn", "message": "BTC and ETH showing high correlation (0.89)"},
    {"severity": "info", "message": "1 ORACLE conflict with current positions"}
  ],
  "assessment_summary": "2-3 sentence summary of current risk posture"
}

HARD CONSTRAINTS (never exceed regardless of context):
- max_total_exposure_usd: never > 20000
- max_single_position_usd: never > 10000
- max_open_positions: never > 6
- scram_threshold_pct: never < 5.0 (always keep SCRAM trigger active)

If GRID has no open positions, risk_score should reflect macro environment only.`;

async function runRiskAssessor() {
  console.log('[COMPASS-RISK] Running risk assessor...');

  const context = await buildCompassContext();

  // Get latest portfolio guidance for this cycle
  const latestPortfolio = await queryOne(
    `SELECT recommended_weights, cash_weight, risk_posture, posture_reasoning
     FROM compass_portfolios ORDER BY created_at DESC LIMIT 1`
  );

  const agent = new CompassBaseAgent({
    name:     'compass-risk-assessor',
    model:    'claude-opus-4-5',
    costTier: 'compass_risk',
  });

  // Calculate basic correlation (simplified — BTC/ETH correlation proxy)
  const correlationNote = context.openPositions.length >= 2
    ? `${context.openPositions.length} open positions — correlation analysis recommended`
    : 'Fewer than 2 open positions — correlation risk low';

  const userPrompt = `
CURRENT OPEN POSITIONS (${context.openPositions.length}):
${context.positionsSummary}
Total exposure: $${context.totalExposureUsd.toFixed(2)}

PORTFOLIO AGENT GUIDANCE:
Risk posture: ${latestPortfolio?.risk_posture || 'unknown'}
Reasoning: ${latestPortfolio?.posture_reasoning || 'none'}
Recommended cash: ${((latestPortfolio?.cash_weight || 0.25) * 100).toFixed(0)}%

ORACLE ACTIVE THESES (${context.activeTheses.length}):
${context.thesisSummary}

GRID PERFORMANCE:
${context.performanceSummary}

CORRELATION NOTE: ${correlationNote}

Compute the risk score, identify flags, and set GRID's hard limits.
Return ONLY valid JSON.`;

  try {
    const raw    = await agent.callClaude(RISK_SYSTEM_PROMPT, userPrompt);
    const result = agent.parseJSON(raw);

    if (!result) throw new Error('Risk assessor produced invalid JSON');

    // Enforce hard constraints — never let Claude exceed these
    const limits = result.limits || {};
    limits.max_total_exposure_usd  = Math.min(parseFloat(limits.max_total_exposure_usd  || 15000), 20000);
    limits.max_single_position_usd = Math.min(parseFloat(limits.max_single_position_usd || 5000),  10000);
    limits.max_open_positions      = Math.min(parseInt(limits.max_open_positions         || 4),     6);
    limits.scram_threshold_pct     = Math.max(parseFloat(limits.scram_threshold_pct      || 8),     5.0);
    result.limits = limits;

    // Persist
    const riskResult = await query(
      `INSERT INTO compass_risk_assessments
         (risk_score, market_risk, concentration_risk, correlation_risk,
          drawdown_risk, thesis_conflict_risk,
          max_total_exposure_usd, max_single_position_usd,
          max_open_positions, scram_threshold_pct,
          flags, open_positions)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       RETURNING id`,
      [
        result.risk_score,
        result.components?.market_risk         || null,
        result.components?.concentration_risk  || null,
        result.components?.correlation_risk    || null,
        result.components?.drawdown_risk       || null,
        result.components?.thesis_conflict_risk|| null,
        limits.max_total_exposure_usd,
        limits.max_single_position_usd,
        limits.max_open_positions,
        limits.scram_threshold_pct,
        JSON.stringify(result.flags || []),
        JSON.stringify(context.openPositions),
      ]
    );

    const assessmentId = riskResult.rows[0].id;

    // Publish portfolio_risk_state to bus — GRID reads this for position sizing
    const busId = await bus.publish({
      source_system: 'compass',
      event_type:    'portfolio_risk_state',
      payload: {
        assessment_id:         assessmentId,
        risk_score:            result.risk_score,
        limits,
        flags:                 result.flags || [],
        assessment_summary:    result.assessment_summary || '',
      },
      expires_at: new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString(), // 4h
    });

    await query(
      'UPDATE compass_risk_assessments SET bus_event_id = $1 WHERE id = $2',
      [busId, assessmentId]
    );

    console.log(
      `[COMPASS-RISK] Score: ${result.risk_score}/10, ` +
      `Max position: $${limits.max_single_position_usd}, ` +
      `Max exposure: $${limits.max_total_exposure_usd}, ` +
      `Flags: ${(result.flags || []).length} (bus:${busId})`
    );

    return result;

  } catch (err) {
    console.error('[COMPASS-RISK] Failed:', err.message);
    throw err;
  }
}

module.exports = { runRiskAssessor };
