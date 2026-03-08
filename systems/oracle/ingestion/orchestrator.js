'use strict';

const { ingestFred  } = require('./fred');
const { ingestRSS   } = require('./rss');
const { ingestGDELT } = require('./gdelt');
const { query }       = require('../../../db/connection');

/**
 * Run all ingestion feeds.
 * Called every 6 hours by cron — before ORACLE agent cycle.
 * Always runs feeds independently — one failure never blocks others.
 */
async function runIngestion() {
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

  // Record to platform health
  try {
    const { recordHeartbeat } = require('../../../shared/system-health');
    await recordHeartbeat({
      system_name: 'oracle',
      status: 'healthy',
      last_cycle_at: new Date(start),
      cycle_duration_ms: duration,
      metadata: { type: 'ingestion', ...results },
    });
  } catch {}

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

module.exports = { runIngestion, getEvidenceSummary };
