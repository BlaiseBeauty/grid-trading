'use strict';

const { runIngestion }   = require('../ingestion/orchestrator');
const { runDomainAgents }= require('./domain-agents');
const { runSynthesis }   = require('./synthesis');
const { upsertThesis }   = require('../db/theses');
const { recordHeartbeat }= require('../../../shared/system-health');
const aiCosts            = require('../../../shared/ai-costs');

let cycleRunning = false;
let ingestionRunning = false;

async function runCycle(opts = {}) {
  if (cycleRunning) {
    console.warn('[ORACLE] Skipping — previous cycle still running');
    return { skipped: true, reason: 'already_running' };
  }
  cycleRunning = true;
  const cycleStart = Date.now();
  console.log('[ORACLE] Starting cycle...');

  let agentsSucceeded = 0;
  let agentsFailed    = 0;
  const savedTheses   = [];

  try {
    // Step 1: Ingestion (already run by separate cron, but refresh if stale)
    // Only re-ingest if last ingestion was > 5 hours ago
    // For now: skip re-ingestion here — the :00 cron handles it separately

    // Step 2: Run 6 domain agents
    const agentResults = await runDomainAgents();

    // Step 3: Persist valid theses
    for (const result of agentResults) {
      if (result.thesis) {
        try {
          const saved = await upsertThesis(result.thesis);
          savedTheses.push(saved);
          agentsSucceeded++;
        } catch (err) {
          console.error(`[ORACLE] Failed to save thesis from ${result.agent}:`, err.message);
          agentsFailed++;
        }
      } else {
        agentsFailed++;
      }
    }

    // Step 4: Run synthesis (only if we have 2+ theses)
    let synthesis = null;
    if (agentsSucceeded >= 2) {
      synthesis = await runSynthesis();
    }

    // Step 5: Record heartbeat
    await recordHeartbeat({
      system_name:       'oracle',
      status:            'healthy',
      last_cycle_at:     new Date(cycleStart),
      cycle_duration_ms: Date.now() - cycleStart,
      agents_succeeded:  agentsSucceeded,
      agents_failed:     agentsFailed,
      metadata: {
        theses_saved: savedTheses.length,
        synthesis_ran: synthesis !== null,
      },
    });

    console.log(
      `[ORACLE] Cycle complete in ${Date.now() - cycleStart}ms. ` +
      `${agentsSucceeded} theses, ${agentsFailed} failed. ` +
      `Synthesis: ${synthesis ? 'ran' : 'skipped'}`
    );

    return { agentsSucceeded, agentsFailed, savedTheses, synthesis };

  } catch (err) {
    console.error('[ORACLE] Cycle failed:', err.message);

    await recordHeartbeat({
      system_name:       'oracle',
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

module.exports = { runCycle, isCycleRunning: () => cycleRunning, isIngestionRunning: () => ingestionRunning };
