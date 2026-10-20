'use strict';

// db/connection is required lazily so deriveStatus()/effectiveStatus() are testable offline.
const db = () => require('../db/connection');

// Components that own their own platform_system_health row. ORACLE ingestion has its own
// component so a successful ingestion can never overwrite a failed ORACLE cycle heartbeat.
const COMPONENTS = ['grid', 'compass', 'oracle', 'oracle_ingestion'];

const num = (v) => (v === undefined || v === null || Number.isNaN(Number(v)) ? null : Number(v));

/**
 * Normalise the many ways callers describe a cycle outcome.
 * Accepts GRID runCycle's result shape {agentsRun, agentsSucceeded, agentsFailed, aborted}
 * via `cycle_result` / `cycleResult`, and the legacy flat agents_succeeded / agents_failed.
 */
function normaliseOutcome(opts) {
  const r = opts.cycle_result || opts.cycleResult || {};
  const failed = num(opts.agents_failed ?? opts.agentsFailed ?? r.agentsFailed);
  let succeeded = num(opts.agents_succeeded ?? opts.agentsSucceeded ?? r.agentsSucceeded);
  const run = num(r.agentsRun ?? opts.agentsRun);
  if (succeeded === null && run !== null) succeeded = Math.max(0, run - (failed || 0));
  return {
    succeeded,
    failed,
    run,
    aborted: Boolean(opts.aborted ?? r.aborted),
    abort_reason: opts.abort_reason ?? r.reason ?? null,
  };
}

/**
 * Derive the status to store. An explicit 'down' / 'starting' always wins.
 * aborted cycles and cycles with failed agents are 'degraded' (all agents failed -> 'down').
 * Pure function.
 */
function deriveStatus(requested, outcome) {
  if (requested === 'down' || requested === 'starting') return requested;
  if (outcome.aborted) return 'degraded';
  if ((outcome.failed || 0) > 0) {
    return outcome.succeeded === 0 ? 'down' : 'degraded';
  }
  return requested || 'healthy';
}

/**
 * Staleness view of a stored health row, honouring next_cycle_at (set by the cycle owner).
 * A row that claimed 'healthy' but whose next cycle is overdue by more than `graceMs`
 * (default 30 min) is reported 'stale'. Pure function — for api/platform/health.js.
 */
function effectiveStatus(row, now = Date.now(), graceMs = 30 * 60 * 1000) {
  if (!row) return 'unknown';
  if (row.status !== 'healthy') return row.status;
  const next = row.next_cycle_at || row.metadata?.next_cycle_at;
  if (next && now > new Date(next).getTime() + graceMs) return 'stale';
  return row.status;
}

/**
 * Record a system health heartbeat.
 * Called by each system's orchestrator after every cycle.
 * Uses UPSERT — one row per component (UNIQUE on system_name).
 *
 * @param {object} opts
 * @param {'grid'|'compass'|'oracle'|'oracle_ingestion'} opts.system_name
 * @param {string} [opts.status]            requested status (derived/overridden by outcome)
 * @param {Date}   [opts.last_cycle_at]
 * @param {Date}   [opts.next_cycle_at]
 * @param {object} [opts.cycle_result]      {agentsRun, agentsSucceeded, agentsFailed, aborted, reason}
 */
async function recordHeartbeat(opts) {
  const {
    system_name,
    last_cycle_at = new Date(),
    next_cycle_at = null,
    cycle_duration_ms = null,
    error_message = null,
    metadata = {},
  } = opts;

  if (!COMPONENTS.includes(system_name)) {
    console.error(`[HEALTH] Unknown component "${system_name}" — heartbeat ignored`);
    return;
  }

  const outcome = normaliseOutcome(opts);
  const status = deriveStatus(opts.status, outcome);

  const fullMetadata = {
    ...metadata,
    cycle_duration_ms,
    agents_succeeded: outcome.succeeded,
    agents_failed: outcome.failed,
    agents_run: outcome.run,
    aborted: outcome.aborted || undefined,
    abort_reason: outcome.aborted ? outcome.abort_reason : undefined,
    error_message,
    next_cycle_at: next_cycle_at ? new Date(next_cycle_at).toISOString() : null,
  };

  const healthy = status === 'healthy';
  const baseParams = [system_name, status, last_cycle_at, healthy ? 0 : 1, JSON.stringify(fullMetadata)];

  const upsert = (withNext) => db().query(
    `INSERT INTO platform_system_health
       (system_name, status, last_cycle_at, error_count, metadata, updated_at${withNext ? ', next_cycle_at' : ''})
     VALUES ($1, $2, $3, $4, $5, NOW()${withNext ? ', $6' : ''})
     ON CONFLICT (system_name) DO UPDATE SET
       status = EXCLUDED.status,
       last_cycle_at = EXCLUDED.last_cycle_at,
       error_count = CASE
         WHEN EXCLUDED.status = 'healthy' THEN 0
         ELSE platform_system_health.error_count + 1
       END,
       metadata = EXCLUDED.metadata,
       ${withNext ? 'next_cycle_at = EXCLUDED.next_cycle_at,' : ''}
       updated_at = NOW()`,
    withNext ? [...baseParams, next_cycle_at] : baseParams
  );

  try {
    try {
      await upsert(true);
    } catch (err) {
      if (err.code === '42703') await upsert(false);      // next_cycle_at column missing (migration 041)
      else throw err;
    }
  } catch (err) {
    if (err.code === '23514' && system_name === 'oracle_ingestion') {
      // Constraint not widened yet (migration 041): park ingestion info inside the ORACLE row's
      // metadata WITHOUT touching its status or last_cycle_at.
      try {
        await db().query(
          `UPDATE platform_system_health
             SET metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{ingestion}', $1::jsonb), updated_at = NOW()
           WHERE system_name = 'oracle'`,
          [JSON.stringify({ status, at: new Date().toISOString(), ...fullMetadata })]
        );
      } catch (err2) {
        console.error('[HEALTH] Failed to record ingestion heartbeat (fallback):', err2.message);
      }
      return;
    }
    // Never fail the cycle because of heartbeat recording
    console.error('[HEALTH] Failed to record heartbeat:', err.message);
  }
}

module.exports = { recordHeartbeat, deriveStatus, normaliseOutcome, effectiveStatus, COMPONENTS };
