'use strict';

const { runPortfolioAgent } = require('./portfolio-agent');
const { runRiskAssessor }   = require('./risk-assessor');
const { calculateCorrelations } = require('./correlation-tracker');
const { recordHeartbeat }   = require('../../../shared/system-health');

const CYCLE_INTERVAL_MS = 6 * 60 * 60 * 1000; // cron: 15 1,7,13,19

let cycleRunning = false;

async function runCycle(opts = {}) {
  if (cycleRunning) {
    console.warn('[COMPASS] Skipping — previous cycle still running');
    return { skipped: true, reason: 'already_running' };
  }
  cycleRunning = true;
  const cycleStart = Date.now();
  // Integer correlation id (epoch seconds): stamped on log lines and platform_ai_costs.cycle_id
  const cycleId = Math.floor(cycleStart / 1000);
  const tag = `[COMPASS c${cycleId}]`;
  console.log(`${tag} Starting cycle...`);

  try {
    // Step 0: Correlation tracking (non-critical)
    try {
      const correlations = await calculateCorrelations();
      const pairs = Object.keys(correlations).length;
      if (pairs > 0) {
        console.log(`${tag} Calculated ${pairs} correlation pairs`);
      }
    } catch (err) {
      console.warn(`${tag} Correlation calculation failed (non-critical):`, err.message);
    }

    let agentsSucceeded = 0;
    let agentsFailed = 0;
    const errors = [];

    // Step 1: Portfolio Agent — determines posture and allocation weights
    let portfolio = null;
    try {
      portfolio = await runPortfolioAgent({ cycleId });
      agentsSucceeded++;
    } catch (err) {
      agentsFailed++;
      errors.push(`portfolio: ${err.message}`);
      console.error(`${tag} Portfolio agent failed:`, err.message);
    }

    // Step 2: Risk Assessor — computes risk score and hard limits from positions.
    // Always runs even if the Portfolio Agent failed (it falls back to the last stored guidance).
    let risk = null;
    try {
      risk = await runRiskAssessor({ cycleId });
      agentsSucceeded++;
    } catch (err) {
      agentsFailed++;
      errors.push(`risk: ${err.message}`);
      console.error(`${tag} Risk assessor failed:`, err.message);
    }

    const duration = Date.now() - cycleStart;

    // Real counts; system-health derives status (1 failed => degraded, both failed => down)
    await recordHeartbeat({
      system_name:       'compass',
      last_cycle_at:     new Date(cycleStart),
      next_cycle_at:     new Date(cycleStart + CYCLE_INTERVAL_MS),
      cycle_duration_ms: duration,
      error_message:     errors.length ? errors.join(' | ').slice(0, 500) : null,
      cycle_result:      { agentsRun: agentsSucceeded + agentsFailed, agentsSucceeded, agentsFailed, aborted: false },
      metadata: {
        cycle_id:      cycleId,
        risk_posture:  portfolio?.risk_posture,
        risk_score:    risk?.risk_score,
        cash_weight:   portfolio?.cash_weight,
      },
    });

    console.log(
      `${tag} Cycle complete in ${duration}ms. ` +
      `Posture: ${portfolio?.risk_posture ?? 'n/a'}, ` +
      `Risk: ${risk?.risk_score ?? 'n/a'}/10, ${agentsFailed} agent(s) failed`
    );

    if (agentsSucceeded === 0) {
      throw new Error(`COMPASS cycle failed — both agents failed (${errors.join(' | ')})`);
    }

    return { cycleId, portfolio, risk, agentsRun: agentsSucceeded + agentsFailed, agentsSucceeded, agentsFailed };

  } catch (err) {
    console.error(`${tag} Cycle failed:`, err.message);

    await recordHeartbeat({
      system_name:       'compass',
      status:            'down',
      last_cycle_at:     new Date(cycleStart),
      next_cycle_at:     new Date(cycleStart + CYCLE_INTERVAL_MS),
      cycle_duration_ms: Date.now() - cycleStart,
      error_message:     err.message,
      metadata:          { cycle_id: cycleId },
    });

    throw err;
  } finally {
    cycleRunning = false;
  }
}

module.exports = { runCycle, isCycleRunning: () => cycleRunning };
