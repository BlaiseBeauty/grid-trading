'use strict';

const { isIngestionRunning } = require('../ingestion/orchestrator');
const { runDomainAgents }= require('./domain-agents');
const { runSynthesis }   = require('./synthesis');
const { upsertThesis }   = require('../db/theses');
const { recordHeartbeat }= require('../../../shared/system-health');

const CYCLE_INTERVAL_MS = 6 * 60 * 60 * 1000; // cron: 30 0,6,12,18

let cycleRunning = false;

async function runCycle(opts = {}) {
  if (cycleRunning) {
    console.warn('[ORACLE] Skipping — previous cycle still running');
    return { skipped: true, reason: 'already_running' };
  }
  cycleRunning = true;
  const cycleStart = Date.now();
  // Integer correlation id (epoch seconds): stamped on log lines and platform_ai_costs.cycle_id
  const cycleId = Math.floor(cycleStart / 1000);
  const tag = `[ORACLE c${cycleId}]`;
  console.log(`${tag} Starting cycle...`);

  let agentsSucceeded = 0;
  let agentsFailed    = 0;
  const savedTheses   = [];

  try {
    // Step 1: Ingestion is run by its own cron (runIngestion, which owns the ingestionRunning flag).
    if (isIngestionRunning()) {
      console.warn(`${tag} Ingestion still running — domain agents will use the evidence stored so far`);
    }

    // Step 2: Run 6 domain agents
    const agentResults = await runDomainAgents({ cycleId });

    // Step 3: Persist valid theses
    for (const result of agentResults) {
      if (result.thesis) {
        try {
          const saved = await upsertThesis(result.thesis);
          savedTheses.push(saved);
          agentsSucceeded++;
        } catch (err) {
          console.error(`${tag} Failed to save thesis from ${result.agent}:`, err.message);
          agentsFailed++;
        }
      } else {
        agentsFailed++;
      }
    }

    // Step 4: Run synthesis (only if we have 2+ theses)
    let synthesis = null;
    if (agentsSucceeded >= 2) {
      synthesis = await runSynthesis({ cycleId });
    }
    const synthesisAttempted = agentsSucceeded >= 2;
    const synthesisFailed = synthesisAttempted && synthesis === null;

    // Step 5: Record heartbeat — real counts (domain agents + synthesis when attempted);
    // system-health derives status from them (any failed agent => degraded, all failed => down).
    const hbFailed = agentsFailed + (synthesisFailed ? 1 : 0);
    const hbSucceeded = agentsSucceeded + (synthesisAttempted && !synthesisFailed ? 1 : 0);
    const agentsRun = hbSucceeded + hbFailed;
    await recordHeartbeat({
      system_name:       'oracle',
      last_cycle_at:     new Date(cycleStart),
      next_cycle_at:     new Date(cycleStart + CYCLE_INTERVAL_MS),
      cycle_duration_ms: Date.now() - cycleStart,
      cycle_result:      { agentsRun, agentsSucceeded: hbSucceeded, agentsFailed: hbFailed, aborted: false },
      metadata: {
        cycle_id: cycleId,
        theses_saved: savedTheses.length,
        synthesis_ran: synthesis !== null,
        synthesis_failed: synthesisFailed,
      },
    });

    console.log(
      `${tag} Cycle complete in ${Date.now() - cycleStart}ms. ` +
      `${agentsSucceeded} ok, ${agentsFailed} failed. ` +
      `Synthesis: ${synthesis ? 'ran' : (synthesisFailed ? 'FAILED' : 'skipped')}`
    );

    return { cycleId, agentsRun, agentsSucceeded, agentsFailed, aborted: false, savedTheses, synthesis };

  } catch (err) {
    console.error(`${tag} Cycle failed:`, err.message);

    await recordHeartbeat({
      system_name:       'oracle',
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

module.exports = { runCycle, isCycleRunning: () => cycleRunning, isIngestionRunning };
