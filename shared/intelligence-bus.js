// Intelligence Bus — cross-system event stream for GRID, COMPASS, ORACLE
const { query, queryAll, queryOne } = require('../db/connection');

// Broadcast function — injected at boot time by server.js
// Allows bus to fan out events to WebSocket clients
let _broadcast = null;

function init(broadcastFn) {
  _broadcast = broadcastFn;
  console.log('[BUS] WebSocket broadcast registered');
}

function summarisePayload(eventType, payload) {
  // Return a small human-readable summary for the WebSocket notification
  // Frontend uses this for the notification drawer without fetching full payload
  switch (eventType) {
    case 'thesis_created':
    case 'thesis_conviction_updated':
      return {
        thesis_name: payload.name || payload.thesis_name || 'New thesis',
        domain: payload.domain || null,
      };
    case 'trade_executed':
    case 'trade_closed':
      return {
        symbol:    payload.symbol,
        direction: payload.direction,
        pnl_usd:   payload.pnl_usd || null,
      };
    case 'scram_triggered':
      return {
        level:  payload.level,
        reason: payload.reason,
      };
    case 'performance_digest':
      return {
        period_label: payload.period_label,
        win_rate:     payload.win_rate,
        total_pnl_usd: payload.total_pnl_usd,
      };
    case 'allocation_guidance':
      return { updated: true };
    case 'macro_regime_update':
      return { regime: payload.regime || 'updated' };
    default:
      return {};
  }
}

const bus = {
  /**
   * Publish an event to the intelligence bus.
   * @param {Object} opts
   * @param {string} opts.source - 'grid' | 'compass' | 'oracle'
   * @param {string} opts.eventType - e.g. 'trade_executed', 'thesis_created'
   * @param {Object} opts.payload - arbitrary JSON payload
   * @param {number} [opts.conviction] - 0-1 conviction score
   * @param {string[]} [opts.affectedAssets] - e.g. ['BTC/USDT']
   * @param {string} [opts.direction] - 'long' | 'short' | 'neutral'
   * @param {string} [opts.timeHorizon] - e.g. '4h', '1d', '1w'
   * @param {Date|string} [opts.expiresAt]
   * @param {number} [opts.supersedes] - ID of event this supersedes
   */
  async publish(opts) {
    // Accept both camelCase and snake_case parameter names
    const source = opts.source || opts.source_system;
    const eventType = opts.eventType || opts.event_type;
    const payload = opts.payload || {};
    const conviction = opts.conviction;
    const affectedAssets = opts.affectedAssets || opts.affected_assets;
    const direction = opts.direction;
    const timeHorizon = opts.timeHorizon || opts.time_horizon;
    const expiresAt = opts.expiresAt || opts.expires_at;
    const supersedes = opts.supersedes;

    // If superseding, mark the old event
    if (supersedes) {
      await query('UPDATE intelligence_bus SET superseded_by = -1 WHERE id = $1 AND superseded_by IS NULL', [supersedes]);
    }

    const result = await queryOne(`
      INSERT INTO intelligence_bus (source_system, event_type, payload, conviction, affected_assets, direction, time_horizon, expires_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING id
    `, [source, eventType, JSON.stringify(payload), conviction || null, affectedAssets || null, direction || null, timeHorizon || null, expiresAt || null]);

    // Now set the correct superseded_by on the old event
    if (supersedes && result?.id) {
      await query('UPDATE intelligence_bus SET superseded_by = $1 WHERE id = $2', [result.id, supersedes]);
    }

    // Fan out to WebSocket clients if broadcast is registered
    if (_broadcast) {
      try {
        _broadcast('bus_event', {
          id:             result?.id,
          source_system:  source,
          event_type:     eventType,
          direction:      direction || null,
          conviction:     conviction || null,
          affected_assets: affectedAssets || [],
          time_horizon:   timeHorizon || null,
          payload_summary: summarisePayload(eventType, payload),
          created_at:     new Date().toISOString(),
        });
      } catch (err) {
        // Never fail publish because of WS broadcast failure
        console.error('[BUS] WebSocket broadcast failed:', err.message);
      }
    }

    return result;
  },

  // --- GRID reads from ORACLE ---

  /** Get active theses for a specific symbol (GRID reads ORACLE theses) */
  async getActiveThesesForSymbol(symbol) {
    return queryAll(`
      SELECT * FROM intelligence_bus_active
      WHERE source_system = 'oracle'
        AND event_type = 'thesis_created'
        AND $1 = ANY(affected_assets)
      ORDER BY created_at DESC
      LIMIT 10
    `, [symbol]);
  },

  // --- GRID reads from COMPASS ---

  /** Get latest allocation guidance (GRID reads COMPASS guidance) */
  async getLatestAllocationGuidance() {
    return queryOne(`
      SELECT * FROM intelligence_bus_active
      WHERE source_system = 'compass'
        AND event_type = 'allocation_guidance'
      ORDER BY created_at DESC
      LIMIT 1
    `);
  },

  /** Get current risk state (GRID reads COMPASS risk state) */
  async getRiskState() {
    return queryOne(`
      SELECT * FROM intelligence_bus_active
      WHERE source_system = 'compass'
        AND event_type = 'risk_state'
      ORDER BY created_at DESC
      LIMIT 1
    `);
  },

  // --- ORACLE reads from GRID ---

  /** Get trade outcomes for a thesis (ORACLE reads GRID results) */
  async getTradeOutcomesForThesis(thesisId) {
    return queryAll(`
      SELECT * FROM intelligence_bus
      WHERE source_system = 'grid'
        AND event_type IN ('trade_executed', 'trade_closed')
        AND payload->>'thesis_id' = $1
      ORDER BY created_at DESC
    `, [String(thesisId)]);
  },

  /** Get latest performance digest (ORACLE reads GRID perf) */
  async getLatestPerformanceDigest() {
    return queryOne(`
      SELECT * FROM intelligence_bus_active
      WHERE source_system = 'grid'
        AND event_type = 'performance_digest'
      ORDER BY created_at DESC
      LIMIT 1
    `);
  },

  // --- COMPASS reads from ORACLE ---

  /** Get all active theses (COMPASS reads ORACLE) */
  async getAllActiveTheses() {
    return queryAll(`
      SELECT * FROM intelligence_bus_active
      WHERE source_system = 'oracle'
        AND event_type = 'thesis_created'
      ORDER BY created_at DESC
    `);
  },

  /** Get latest opportunity map (COMPASS reads ORACLE) */
  async getLatestOpportunityMap() {
    return queryOne(`
      SELECT * FROM intelligence_bus_active
      WHERE source_system = 'oracle'
        AND event_type = 'opportunity_map'
      ORDER BY created_at DESC
      LIMIT 1
    `);
  },

  // --- Housekeeping ---

  /** Mark an event as processed by a system */
  async markProcessed(eventId, systemName) {
    await query(`
      UPDATE intelligence_bus
      SET processed_by = array_append(processed_by, $1)
      WHERE id = $2 AND NOT ($1 = ANY(processed_by))
    `, [systemName, eventId]);
  },

  /** Clean up expired and old events */
  async cleanup({ maxAgeDays = 7 } = {}) {
    const result = await query(`
      DELETE FROM intelligence_bus
      WHERE (expires_at IS NOT NULL AND expires_at < NOW())
         OR created_at < NOW() - INTERVAL '1 day' * $1
    `, [maxAgeDays]);
    return { deleted: result.rowCount };
  },
};

bus.init = init;

module.exports = bus;
