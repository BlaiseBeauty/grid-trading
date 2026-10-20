// Intelligence Bus — cross-system event stream for GRID, COMPASS, ORACLE
const { query, queryAll, queryOne, transaction } = require('../db/connection');
const { baseAsset, symbolVariants } = require('../config/symbols');

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

// ── RETENTION ────────────────────────────────────────────────────────────────
// Per event-type retention (days). Used for default expires_at on publish and by cleanup().
// Long-lived intelligence (theses, macro, performance) is kept 30d; trade/risk events shorter.
// The oracle_theses table remains the source of truth for theses — the bus is notification only.
const RETENTION_DAYS = {
  thesis_created:            30,
  thesis_conviction_updated: 30,
  thesis_retired:            30,
  macro_regime_update:       30,
  opportunity_map_update:    30,
  performance_digest:        30,
  trade_executed:            14,
  trade_closed:              14,
  scram_triggered:           14,
  allocation_guidance:        7,
  portfolio_risk_state:       7,
  conflict_flagged:           7,
};
const DEFAULT_RETENTION_DAYS = 7;

function retentionDays(eventType) {
  return RETENTION_DAYS[eventType] || DEFAULT_RETENTION_DAYS;
}

function defaultExpiresAt(eventType, now = Date.now()) {
  return new Date(now + retentionDays(eventType) * 86400000).toISOString();
}

// Event-name aliases: publishers use the NEW name; readers also accept the legacy name.
const RISK_STATE_EVENTS = ['portfolio_risk_state', 'risk_state'];
const OPPORTUNITY_MAP_EVENTS = ['opportunity_map_update', 'opportunity_map'];

/** Map an oracle_theses row to the bus-row shape existing consumers expect. */
function thesisRowToBusShape(t) {
  return {
    id:              t.bus_event_id != null ? Number(t.bus_event_id) : null,
    source_system:   'oracle',
    event_type:      'thesis_created',
    payload: {
      thesis_id:    t.thesis_id,
      name:         t.name,
      domain:       t.domain,
      summary:      t.summary,
      catalyst:     t.catalyst,
      invalidation: t.invalidation,
      long_assets:  t.long_assets || [],
      short_assets: t.short_assets || [],
      watch_assets: t.watch_assets || [],
    },
    conviction:      t.conviction,
    affected_assets: [...(t.long_assets || []), ...(t.short_assets || [])],
    direction:       t.direction,
    time_horizon:    t.time_horizon,
    created_at:      t.created_at,
    updated_at:      t.updated_at,
  };
}

const bus = {
  RETENTION_DAYS,
  retentionDays,

  /**
   * Publish an event to the intelligence bus.
   * @param {Object} opts
   * @param {string} opts.source - 'grid' | 'compass' | 'oracle'
   * @param {string} opts.eventType - e.g. 'trade_executed', 'thesis_created'
   * @param {Object} opts.payload - arbitrary JSON payload
   * @param {number} [opts.conviction] - 0-10 conviction score
   * @param {string[]} [opts.affectedAssets] - canonical tickers, e.g. ['BTC']
   * @param {string} [opts.direction] - 'long' | 'short' | 'neutral' | 'bull' | 'bear' (bull/bear need migration 040)
   * @param {string} [opts.timeHorizon] - e.g. '4h', '1d', '1w'
   * @param {Date|string|null} [opts.expiresAt] - default: per-event-type retention; null = no expiry
   * @param {number} [opts.supersedes] - ID of event this supersedes (done in the same transaction)
   * @param {string} [opts.dedupeKey] - idempotency key: re-publishing the same key is a no-op
   *                                    returning the existing event ({deduped:true}). Needs migration 040.
   */
  async publish(opts) {
    // Accept both camelCase and snake_case parameter names
    const source = opts.source || opts.source_system;
    const eventType = opts.eventType || opts.event_type;
    const payload = opts.payload || {};
    const conviction = opts.conviction;
    const rawAssets = opts.affectedAssets || opts.affected_assets;
    const affectedAssets = Array.isArray(rawAssets)
      ? [...new Set(rawAssets.map((a) => baseAsset(a) || String(a)))]
      : null;
    const direction = opts.direction;
    const timeHorizon = opts.timeHorizon || opts.time_horizon;
    const explicitExpiry = opts.expiresAt !== undefined ? opts.expiresAt : opts.expires_at;
    const expiresAt = explicitExpiry === undefined ? defaultExpiresAt(eventType) : explicitExpiry;
    const supersedes = opts.supersedes;
    const dedupeKey = opts.dedupeKey || opts.dedupe_key || null;

    const params = [
      source, eventType, JSON.stringify(payload),
      conviction ?? null, affectedAssets, direction || null, timeHorizon || null, expiresAt || null,
    ];

    let result;
    try {
      result = await publishTx();
    } catch (err) {
      // Graceful degradation while migration 040 is not applied yet.
      if (err.code === '42703' && dedupeKey) {
        console.warn('[BUS] dedupe_key column missing (migration 040 pending) — publishing without idempotency');
        return bus.publish({ ...opts, dedupeKey: null, dedupe_key: null });
      }
      if (err.code === '23514' && (direction === 'bull' || direction === 'bear')) {
        console.warn('[BUS] direction bull/bear rejected by CHECK (migration 040 pending) — publishing as long/short');
        return bus.publish({ ...opts, direction: direction === 'bull' ? 'long' : 'short' });
      }
      throw err;
    }

    async function publishTx() {
      return transaction(async (client) => {
      let row;
      if (dedupeKey) {
        const ins = await client.query(`
          INSERT INTO intelligence_bus
            (source_system, event_type, payload, conviction, affected_assets, direction, time_horizon, expires_at, dedupe_key)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
          ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING
          RETURNING id
        `, [...params, dedupeKey]);
        row = ins.rows[0];
        if (!row) {
          const existing = await client.query('SELECT id FROM intelligence_bus WHERE dedupe_key = $1', [dedupeKey]);
          return { id: existing.rows[0]?.id, deduped: true };
        }
      } else {
        const ins = await client.query(`
          INSERT INTO intelligence_bus
            (source_system, event_type, payload, conviction, affected_assets, direction, time_horizon, expires_at)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
          RETURNING id
        `, params);
        row = ins.rows[0];
      }

      // Supersede the old event in the SAME transaction (no sentinel value).
      if (supersedes && row?.id) {
        await client.query(
          'UPDATE intelligence_bus SET superseded_by = $1 WHERE id = $2 AND superseded_by IS NULL AND id <> $1',
          [row.id, supersedes]
        );
      }
      return { id: row.id };
      });
    }

    // Fan out to WebSocket clients if broadcast is registered (not for deduped no-ops)
    if (_broadcast && !result.deduped) {
      try {
        _broadcast('bus_event', {
          id:             result?.id,
          source_system:  source,
          event_type:     eventType,
          direction:      direction || null,
          conviction:     conviction ?? null,
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
  // oracle_theses (status = 'active') is the SOURCE OF TRUTH for theses: bus events expire,
  // theses do not. Rows are returned in the legacy bus-row shape.

  /** Get active theses for a symbol. Accepts 'BTC', 'BTC/USDT', 'btcusdt'... matches on base asset. */
  async getActiveThesesForSymbol(symbol) {
    const variants = symbolVariants(symbol);
    if (variants.length === 0) return [];
    const rows = await queryAll(`
      SELECT * FROM oracle_theses
      WHERE status = 'active'
        AND (long_assets && $1::text[] OR short_assets && $1::text[])
      ORDER BY conviction DESC, updated_at DESC
      LIMIT 10
    `, [variants]);
    return rows.map(thesisRowToBusShape);
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

  /** Get current risk state (COMPASS publishes 'portfolio_risk_state'; legacy 'risk_state' accepted) */
  async getRiskState() {
    return queryOne(`
      SELECT * FROM intelligence_bus_active
      WHERE source_system = 'compass'
        AND event_type = ANY($1::text[])
      ORDER BY (event_type = 'portfolio_risk_state') DESC, created_at DESC
      LIMIT 1
    `, [RISK_STATE_EVENTS]);
  },

  /** Latest bus event of the given type(s) from a source (for consumers that read raw bus events). */
  async getLatestEvent(sourceSystem, eventTypes, { maxAgeHours = null } = {}) {
    const types = Array.isArray(eventTypes) ? eventTypes : [eventTypes];
    return queryOne(`
      SELECT * FROM intelligence_bus_active
      WHERE source_system = $1
        AND event_type = ANY($2::text[])
        AND ($3::numeric IS NULL OR created_at > NOW() - ($3::numeric * INTERVAL '1 hour'))
      ORDER BY created_at DESC
      LIMIT 1
    `, [sourceSystem, types, maxAgeHours]);
  },

  // --- ORACLE reads from GRID ---

  /** Get latest performance digest (ORACLE/COMPASS read GRID perf) */
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

  /** Get all active theses (COMPASS reads ORACLE) — from oracle_theses, not the expiring bus. */
  async getAllActiveTheses() {
    const rows = await queryAll(`
      SELECT * FROM oracle_theses
      WHERE status = 'active'
      ORDER BY conviction DESC, updated_at DESC
    `);
    return rows.map(thesisRowToBusShape);
  },

  /** Get latest opportunity map (ORACLE publishes 'opportunity_map_update'; legacy name accepted). */
  async getLatestOpportunityMap() {
    const ev = await queryOne(`
      SELECT * FROM intelligence_bus_active
      WHERE source_system = 'oracle'
        AND event_type = ANY($1::text[])
      ORDER BY (event_type = 'opportunity_map_update') DESC, created_at DESC
      LIMIT 1
    `, [OPPORTUNITY_MAP_EVENTS]);
    if (ev) return ev;
    // Bus event expired — fall back to the persisted snapshot (source of truth)
    const snap = await queryOne(
      'SELECT opportunities, thesis_count, generated_at FROM oracle_opportunity_map ORDER BY generated_at DESC LIMIT 1'
    );
    if (!snap) return null;
    return {
      id: null, source_system: 'oracle', event_type: 'opportunity_map_update',
      payload: { opportunity_map: snap.opportunities, thesis_count: snap.thesis_count },
      created_at: snap.generated_at,
    };
  },

  // --- Housekeeping ---

  /** Mark an event as processed by a system (feeds getBusLag; optional for consumers). */
  async markProcessed(eventId, systemName) {
    await query(`
      UPDATE intelligence_bus
      SET processed_by = array_append(processed_by, $1)
      WHERE id = $2 AND NOT ($1 = ANY(processed_by))
    `, [systemName, eventId]);
  },

  /**
   * Bus lag / health for the readiness endpoint.
   * "unprocessed" = active events no consumer called markProcessed() on.
   * @returns {{oldest_unprocessed_age_s:number|null,total_unprocessed:number,newest_event_age_s:number|null,by_type:Array}}
   */
  async getBusLag() {
    const rows = await queryAll(`
      SELECT source_system, event_type,
             COUNT(*)::int AS total,
             COUNT(*) FILTER (WHERE COALESCE(array_length(processed_by, 1), 0) = 0)::int AS unprocessed,
             EXTRACT(EPOCH FROM (NOW() - MIN(created_at) FILTER (WHERE COALESCE(array_length(processed_by, 1), 0) = 0)))::int AS oldest_unprocessed_age_s,
             EXTRACT(EPOCH FROM (NOW() - MAX(created_at)))::int AS newest_age_s
      FROM intelligence_bus
      WHERE superseded_by IS NULL AND (expires_at IS NULL OR expires_at > NOW())
      GROUP BY source_system, event_type
      ORDER BY source_system, event_type
    `);
    const ages = rows.map((r) => r.oldest_unprocessed_age_s).filter((a) => a != null);
    const newest = rows.map((r) => r.newest_age_s).filter((a) => a != null);
    return {
      oldest_unprocessed_age_s: ages.length ? Math.max(...ages) : null,
      total_unprocessed: rows.reduce((s, r) => s + r.unprocessed, 0),
      newest_event_age_s: newest.length ? Math.min(...newest) : null,
      by_type: rows,
    };
  },

  /**
   * Clean up expired and old events using PER-EVENT-TYPE retention (see RETENTION_DAYS).
   * maxAgeDays is the retention for event types without an explicit entry.
   */
  async cleanup({ maxAgeDays = DEFAULT_RETENTION_DAYS } = {}) {
    const types = Object.keys(RETENTION_DAYS);
    const days = types.map((t) => RETENTION_DAYS[t]);
    const result = await query(`
      WITH doomed AS (
        SELECT id FROM intelligence_bus
        WHERE (expires_at IS NOT NULL AND expires_at < NOW())
           OR created_at < NOW() - (
                COALESCE((SELECT r.d FROM unnest($1::text[], $2::int[]) AS r(t, d)
                          WHERE r.t = intelligence_bus.event_type), $3::int) * INTERVAL '1 day')
      )
      DELETE FROM intelligence_bus
      WHERE id IN (SELECT id FROM doomed)
         OR superseded_by IN (SELECT id FROM doomed)
    `, [types, days, maxAgeDays]);
    return { deleted: result.rowCount };
  },
};

bus.init = init;

module.exports = bus;
