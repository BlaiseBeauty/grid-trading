const { queryOne, queryAll, query } = require('../../../db/connection');
const riskLimitsConfig = require('../config/risk-limits');
const { getRiskLimits } = riskLimitsConfig;
const { notifications } = require('../../../services/notifications');
const { checkLiveTradingReadiness } = require('../agents/readiness-check');
const bus = require('../../../shared/intelligence-bus');
const platformNotifications = require('../../../shared/notifications');

async function routes(fastify) {
  fastify.addHook('preHandler', fastify.authenticate);

  // GET /api/system/bootstrap — current bootstrap phase
  fastify.get('/system/bootstrap', async () => {
    return queryOne('SELECT * FROM bootstrap_status ORDER BY id DESC LIMIT 1');
  });

  // GET /api/system/scram — active SCRAM events
  fastify.get('/system/scram', async () => {
    return queryAll("SELECT * FROM scram_events WHERE cleared_at IS NULL ORDER BY activated_at DESC");
  });

  // GET /api/system/health-detail — authenticated system health (used by dashboard)
  fastify.get('/system/health-detail', async () => {
    const pythonUrl = process.env.PYTHON_ENGINE_URL || 'http://127.0.0.1:5100';

    const [bootstrap, scramEvents, tradeStats, costTotal, dbHealth, pythonHealth] = await Promise.all([
      queryOne('SELECT * FROM bootstrap_status ORDER BY id DESC LIMIT 1'),
      queryAll("SELECT * FROM scram_events WHERE cleared_at IS NULL"),
      queryOne(`
        SELECT COUNT(*)::int as total_trades,
               COUNT(*) FILTER (WHERE status = 'open')::int as open_trades,
               COUNT(*) FILTER (WHERE status = 'closed')::int as closed_trades,
               COALESCE(SUM(pnl_realised) FILTER (WHERE status = 'closed'), 0) as total_pnl,
               ROUND(100.0 * COUNT(*) FILTER (WHERE pnl_realised > 0 AND status = 'closed') /
                 NULLIF(COUNT(*) FILTER (WHERE status = 'closed'), 0), 1) as win_rate
        FROM trades
      `),
      queryOne('SELECT COALESCE(SUM(cost_usd), 0) as total_cost FROM system_costs'),
      queryOne('SELECT 1 as ok').then(() => true).catch(() => false),
      fetch(`${pythonUrl}/health`, { signal: AbortSignal.timeout(5000) })
        .then(r => r.ok)
        .catch(() => false),
    ]);

    return {
      bootstrap_phase: bootstrap?.phase || 'infant',
      scram_active: scramEvents.length > 0,
      scram_level: scramEvents[0]?.level || null,
      trade_stats: {
        total_trades: tradeStats.total_trades,
        total_closed: tradeStats.closed_trades,
        open_trades: tradeStats.open_trades,
        win_rate: parseFloat(tradeStats.win_rate || 0),
      },
      total_pnl: tradeStats.total_pnl,
      total_ai_cost: costTotal.total_cost,
      live_trading: process.env.LIVE_TRADING_ENABLED === 'true',
      micro_trading: process.env.MICRO_TRADING_ENABLED === 'true',
      standing_orders: process.env.STANDING_ORDERS_ENABLED === 'true',
      python_engine: pythonHealth,
      database: dbHealth,
    };
  });

  // GET /api/system/risk-limits — current risk limits
  fastify.get('/system/risk-limits', async () => {
    const bootstrap = await queryOne('SELECT * FROM bootstrap_status ORDER BY id DESC LIMIT 1');
    const phase = bootstrap?.phase || 'infant';
    const baseLimits = getRiskLimits();
    const overrides = riskLimitsConfig.BOOTSTRAP[phase] || {};
    return {
      phase,
      paper_mode: process.env.LIVE_TRADING_ENABLED !== 'true',
      limits: {
        ...baseLimits,
        ...overrides,
        PAPER_ONLY: overrides.PAPER_ONLY ?? false,
      },
      graduated_limits: {
        MAX_SINGLE_POSITION_PCT: baseLimits.MAX_SINGLE_POSITION_PCT,
        MAX_OPEN_POSITIONS: baseLimits.MAX_OPEN_POSITIONS,
        MAX_DAILY_LOSS_PCT: baseLimits.MAX_DAILY_LOSS_PCT,
        MIN_CONFIDENCE_TO_TRADE: baseLimits.MIN_CONFIDENCE_TO_TRADE,
      },
    };
  });

  // GET /api/system/config — environment config (non-sensitive)
  fastify.get('/system/config', async () => {
    return {
      starting_capital: parseFloat(process.env.STARTING_CAPITAL || '10000'),
      python_engine_url: process.env.PYTHON_ENGINE_URL || 'http://127.0.0.1:5100',
      cycle_interval: '4h',
      monitor_interval: '15m',
      analysis_every_n_cycles: 6,
      live_trading: process.env.LIVE_TRADING_ENABLED === 'true',
      micro_trading: process.env.MICRO_TRADING_ENABLED === 'true',
    };
  });

  // POST /api/system/scram/activate — manually activate SCRAM
  fastify.post('/system/scram/activate', async (request, reply) => {
    const { level } = request.body || {};
    if (!['elevated', 'crisis', 'emergency'].includes(level)) {
      return reply.code(400).send({ error: 'Invalid SCRAM level. Use: elevated, crisis, emergency' });
    }
    // Clear any existing active SCRAM first
    await queryAll("UPDATE scram_events SET cleared_at = NOW(), duration_seconds = EXTRACT(EPOCH FROM (NOW() - activated_at))::int WHERE cleared_at IS NULL");
    // Activate new
    const result = await queryOne(`
      INSERT INTO scram_events (level, trigger_name) VALUES ($1, 'manual')
      RETURNING *
    `, [level]);
    fastify.broadcast('scram_activated', { level });
    notifications.scramActivated(level).catch(() => {});
    try {
      await bus.publish({ source: 'grid', eventType: 'scram_triggered', payload: { level, trigger: 'manual' } });
      await platformNotifications.notifyScram(level);
    } catch (e) { /* best-effort */ }
    return result;
  });

  // POST /api/system/scram/clear — clear active SCRAM
  fastify.post('/system/scram/clear', async () => {
    const cleared = await queryAll(`
      UPDATE scram_events SET cleared_at = NOW(), duration_seconds = EXTRACT(EPOCH FROM (NOW() - activated_at))::int
      WHERE cleared_at IS NULL
      RETURNING *
    `);
    if (cleared.length > 0) {
      fastify.broadcast('scram_cleared', {});
      notifications.scramCleared().catch(() => {});
    }
    return { cleared: cleared.length };
  });

  // GET /api/system/scram/history — SCRAM event history
  fastify.get('/system/scram/history', async (request) => {
    const { limit } = request.query;
    return queryAll('SELECT * FROM scram_events ORDER BY activated_at DESC LIMIT $1', [parseInt(limit) || 20]);
  });

  // POST /api/system/reset-drawdown-hwm — reset high-water mark to current equity
  // Allows trading to resume after reviewing a drawdown period.
  // This deletes all equity snapshots above current equity, effectively resetting the HWM.
  fastify.post('/system/reset-drawdown-hwm', async (request, reply) => {
    // Compute current equity
    const startingCapital = parseFloat(process.env.STARTING_CAPITAL || '10000');
    const [realisedRow, unrealisedRow] = await Promise.all([
      queryOne("SELECT COALESCE(SUM(pnl_realised), 0) as total FROM trades WHERE status = 'closed'"),
      queryOne('SELECT COALESCE(SUM(unrealised_pnl), 0) as total FROM portfolio_state'),
    ]);
    const currentEquity = startingCapital
      + parseFloat(realisedRow?.total || 0)
      + parseFloat(unrealisedRow?.total || 0);

    // Get old HWM for logging
    const hwmRow = await queryOne('SELECT MAX(total_value) as hwm FROM equity_snapshots');
    const oldHwm = parseFloat(hwmRow?.hwm || 0);

    // Delete all snapshots with total_value above current equity
    // This resets the HWM to current equity level
    await query(
      'DELETE FROM equity_snapshots WHERE total_value > $1',
      [currentEquity]
    );

    // Insert a fresh snapshot at current equity to establish the new HWM
    await query(`
      INSERT INTO equity_snapshots (cycle_number, total_value, realised_pnl, unrealised_pnl, open_positions)
      VALUES (-2, $1, $2, $3, (SELECT COUNT(*)::int FROM trades WHERE status = 'open'))
    `, [currentEquity, parseFloat(realisedRow?.total || 0), parseFloat(unrealisedRow?.total || 0)]);

    console.log(`[SYSTEM] Drawdown HWM reset: ${oldHwm.toFixed(2)} → ${currentEquity.toFixed(2)}`);
    fastify.broadcast('hwm_reset', { old_hwm: oldHwm, new_hwm: currentEquity });

    return {
      old_high_water_mark: Math.round(oldHwm * 100) / 100,
      new_high_water_mark: Math.round(currentEquity * 100) / 100,
      message: 'High-water mark reset to current equity. Clear SCRAM separately if active.',
    };
  });

  // POST /api/system/run-cycle — trigger a full agent cycle (fire-and-forget)
  fastify.post('/system/run-cycle', {
    schema: { body: { type: 'object', properties: {} } },
  }, async (request, reply) => {
    const orchestrator = require('../agents/orchestrator');
    if (orchestrator.isCycleRunning()) {
      return reply.code(409).send({ error: 'Cycle already running' });
    }
    const recentRow = await queryOne(
      `SELECT COUNT(*) as cnt FROM cycle_reports WHERE created_at > NOW() - INTERVAL '24 hours'`
    );
    const recentCount = parseInt(recentRow?.cnt || '0');
    if (recentCount >= 10) {
      return reply.code(429).send({ error: `Rate limit: ${recentCount} cycles already ran in the last 24h (max 10)` });
    }
    orchestrator.runCycle({ broadcast: fastify.broadcast }).catch(err => {
      console.error('[CYCLE] Failed:', err.message);
    });
    return { message: 'Cycle started', status: 'running' };
  });

  // GET /api/system/last-cycle — read last cycle result from cycle_reports
  fastify.get('/system/last-cycle', async () => {
    const row = await queryOne(
      'SELECT cycle_id, report, created_at FROM cycle_reports ORDER BY created_at DESC LIMIT 1'
    );
    if (!row) return null;

    const report = row.report;
    const cycleNumber = row.cycle_id;

    const agents = (report.knowledge_agents || []).map(k => ({
      agent: k.name,
      status: k.status === 'ok' ? 'fulfilled' : 'rejected',
      signals: k.signals || 0,
    }));

    const elapsed = report.duration_ms
      ? (report.duration_ms / 1000).toFixed(1) + 's'
      : '?';

    // Count actual trades executed in this cycle
    const tradeCount = await queryOne(
      "SELECT COUNT(*)::int as count FROM trades WHERE cycle_number = $1",
      [cycleNumber]
    );

    return {
      cycleNumber,
      agents,
      strategy: {
        proposals: report.synthesizer?.proposals || 0,
        approved: report.risk_manager?.approved || 0,
        rejected: report.risk_manager?.rejected || 0,
        trades: tradeCount?.count || 0,
      },
      elapsed,
    };
  });

  // GET /api/system/bootstrap/history — bootstrap phase history
  fastify.get('/system/bootstrap/history', async () => {
    return queryAll('SELECT * FROM bootstrap_status ORDER BY entered_at DESC LIMIT 10');
  });

  // GET /api/system/equity — equity curve data
  fastify.get('/system/equity', async (request) => {
    const { limit } = request.query;
    return queryAll(`
      SELECT cycle_number, total_value, realised_pnl, unrealised_pnl, open_positions, created_at
      FROM equity_snapshots
      ORDER BY created_at ASC
      LIMIT $1
    `, [parseInt(limit) || 500]);
  });

  // GET /api/system/regime — current market regimes
  fastify.get('/system/regime', async () => {
    return queryAll(`
      SELECT DISTINCT ON (asset_class) *
      FROM market_regime
      ORDER BY asset_class, created_at DESC
    `);
  });

  // GET /api/system/readiness — live trading readiness check
  fastify.get('/system/readiness', async () => {
    return checkLiveTradingReadiness();
  });
}

module.exports = routes;
