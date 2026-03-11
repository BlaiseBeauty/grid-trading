'use strict';

const { runPortfolioAgent } = require('./portfolio-agent');
const { runRiskAssessor }   = require('./risk-assessor');
const { calculateCorrelations } = require('./correlation-tracker');
const { recordHeartbeat }   = require('../../../shared/system-health');

let cycleRunning = false;

async function runCycle(opts = {}) {
  if (cycleRunning) {
    console.warn('[COMPASS] Skipping — previous cycle still running');
    return { skipped: true, reason: 'already_running' };
  }
  cycleRunning = true;
  const cycleStart = Date.now();
  console.log('[COMPASS] Starting cycle...');

  try {
    // Step 0: Correlation tracking (non-critical)
    try {
      const correlations = await calculateCorrelations();
      const pairs = Object.keys(correlations).length;
      if (pairs > 0) {
        console.log(`[COMPASS] Calculated ${pairs} correlation pairs`);
      }
    } catch (err) {
      console.warn('[COMPASS] Correlation calculation failed (non-critical):', err.message);
    }

    // Step 1: Portfolio Agent — determines posture and allocation weights
    const portfolio = await runPortfolioAgent();

    // Step 2: Risk Assessor — computes risk score and hard limits from positions
    // Always runs even if Portfolio Agent fails (uses fallback data)
    const risk = await runRiskAssessor();

    const duration = Date.now() - cycleStart;

    await recordHeartbeat({
      system_name:       'compass',
      status:            'healthy',
      last_cycle_at:     new Date(cycleStart),
      next_cycle_at:     new Date(cycleStart + 6 * 60 * 60 * 1000),
      cycle_duration_ms: duration,
      agents_succeeded:  2,
      agents_failed:     0,
      metadata: {
        risk_posture:  portfolio?.risk_posture,
        risk_score:    risk?.risk_score,
        cash_weight:   portfolio?.cash_weight,
      },
    });

    console.log(
      `[COMPASS] Cycle complete in ${duration}ms. ` +
      `Posture: ${portfolio?.risk_posture}, ` +
      `Risk: ${risk?.risk_score}/10`
    );

    return { portfolio, risk };

  } catch (err) {
    console.error('[COMPASS] Cycle failed:', err.message);

    await recordHeartbeat({
      system_name:       'compass',
      status:            'down',
      last_cycle_at:     new Date(cycleStart),
      cycle_duration_ms: Date.now() - cycleStart,
      error_message:     err.message,
    });

    throw err;
  } finally {
    cycleRunning = false;
  }
}

module.exports = { runCycle, isCycleRunning: () => cycleRunning };
