'use strict';

const { ingestFred  } = require('./fred');
const { ingestRSS   } = require('./rss');
const { ingestGDELT } = require('./gdelt');
const { query }       = require('../../../db/connection');
const { getSourceStats } = require('./http-fetch');

// Guards against overlapping runs and backs isIngestionRunning() (re-exported by agents/orchestrator).
let ingestionRunning = false;

/**
 * Run all ingestion feeds.
 * Called every 6 hours by cron — before ORACLE agent cycle.
 * Always runs feeds independently — one failure never blocks others.
 */
async function runIngestion() {
  if (ingestionRunning) {
    console.warn('[INGESTION] Skipping — previous ingestion still running');
    return { skipped: true, reason: 'already_running' };
  }
  ingestionRunning = true;
  try {
    return await runIngestionInner();
  } finally {
    ingestionRunning = false;
  }
}

async function runIngestionInner() {
  const start = Date.now();
  console.log('[INGESTION] Starting all feeds...');
  const results = {};

  // FRED: run first — highest reliability, critical for macro agent
  try {
    results.fred = await ingestFred();
  } catch (err) {
    results.fred = { error: err.message };
    console.error('[INGESTION] FRED failed:', err.message);
  }

  // RSS: run second — broad news coverage
  try {
    results.rss = await ingestRSS();
  } catch (err) {
    results.rss = { error: err.message };
    console.error('[INGESTION] RSS failed:', err.message);
  }

  // GDELT: run last — least critical, most likely to have issues
  try {
    results.gdelt = await ingestGDELT();
  } catch (err) {
    results.gdelt = { error: err.message };
    console.error('[INGESTION] GDELT failed:', err.message);
  }

  const duration = Date.now() - start;
  console.log(`[INGESTION] Complete in ${duration}ms`, results);

  // Record to platform health under its OWN component so a successful ingestion can never
  // overwrite the ORACLE agent-cycle heartbeat (which may legitimately be 'down'/'degraded').
  try {
    const { recordHeartbeat } = require('../../../shared/system-health');
    const feedErrors = Object.values(results).filter(r => r && r.error).length;
    const feedCount = Object.keys(results).length;
    await recordHeartbeat({
      system_name: 'oracle_ingestion',
      status: feedErrors === 0 ? 'healthy' : (feedErrors >= feedCount ? 'down' : 'degraded'),
      last_cycle_at: new Date(start),
      next_cycle_at: new Date(start + 6 * 60 * 60 * 1000),
      cycle_duration_ms: duration,
      agents_succeeded: feedCount - feedErrors,
      agents_failed: feedErrors,
      metadata: { type: 'ingestion', results, sources: getSourceStats() },
    });
  } catch (err) {
    console.error('[INGESTION] Heartbeat recording failed:', err.message);
  }

  return results;
}

/**
 * Get a summary of what's in the evidence DB — used by agents for context.
 */
async function getEvidenceSummary() {
  const { queryAll } = require('../../../db/connection');

  const [recent, bySource, byDomain] = await Promise.all([
    queryAll(
      `SELECT headline, source_name, relevance_score, sentiment, created_at
       FROM oracle_evidence
       WHERE created_at > NOW() - INTERVAL '24 hours'
       ORDER BY relevance_score DESC, created_at DESC
       LIMIT 30`
    ),
    queryAll(
      `SELECT source_type, COUNT(*) as count
       FROM oracle_evidence
       WHERE created_at > NOW() - INTERVAL '24 hours'
       GROUP BY source_type ORDER BY count DESC`
    ),
    queryAll(
      `SELECT unnest(domain_tags) as tag, COUNT(*) as count
       FROM oracle_evidence
       WHERE created_at > NOW() - INTERVAL '24 hours'
       GROUP BY tag ORDER BY count DESC LIMIT 10`
    ),
  ]);

  return { recent, bySource, byDomain };
}

module.exports = { runIngestion, getEvidenceSummary, isIngestionRunning: () => ingestionRunning };
