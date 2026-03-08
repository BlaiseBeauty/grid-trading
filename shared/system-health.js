'use strict';

const { query } = require('../db/connection');

/**
 * Record a system health heartbeat.
 * Called by each system's orchestrator after every cycle.
 * Uses UPSERT — one row per system (UNIQUE on system_name).
 */
async function recordHeartbeat(opts) {
  const {
    system_name,
    status = 'healthy',
    last_cycle_at = new Date(),
    cycle_duration_ms = null,
    agents_succeeded = null,
    agents_failed = null,
    error_message = null,
    metadata = {},
  } = opts;

  // Store extra info in metadata JSONB
  const fullMetadata = {
    ...metadata,
    cycle_duration_ms,
    agents_succeeded,
    agents_failed,
    error_message,
  };

  try {
    await query(
      `INSERT INTO platform_system_health
         (system_name, status, last_cycle_at, error_count, metadata, updated_at)
       VALUES ($1, $2, $3, $4, $5, NOW())
       ON CONFLICT (system_name) DO UPDATE SET
         status = EXCLUDED.status,
         last_cycle_at = EXCLUDED.last_cycle_at,
         error_count = CASE
           WHEN EXCLUDED.status = 'healthy' THEN 0
           ELSE platform_system_health.error_count + 1
         END,
         metadata = EXCLUDED.metadata,
         updated_at = NOW()`,
      [system_name, status, last_cycle_at,
       status === 'healthy' ? 0 : 1,
       JSON.stringify(fullMetadata)]
    );
  } catch (err) {
    // Never fail the cycle because of heartbeat recording
    console.error('[HEALTH] Failed to record heartbeat:', err.message);
  }
}

module.exports = { recordHeartbeat };
