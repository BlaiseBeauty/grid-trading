const { queryOne, queryAll } = require('../db/connection');
const riskLimits = require('../config/risk-limits');
const { notifications } = require('../services/notifications');

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
    const [bootstrap, scramEvents, tradeStats, costTotal] = await Promise.all([
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
    };
  });

  // GET /api/system/risk-limits — current risk limits
  fastify.get('/system/risk-limits', async () => {
    const bootstrap = await queryOne('SELECT * FROM bootstrap_status ORDER BY id DESC LIMIT 1');
    const phase = bootstrap?.phase || 'infant';
    const overrides = riskLimits.BOOTSTRAP[phase] || {};
    return {
      phase,
      limits: {
        MAX_SINGLE_POSITION_PCT: overrides.MAX_SINGLE_POSITION_PCT ?? riskLimits.MAX_SINGLE_POSITION_PCT,
        MAX_ASSET_CLASS_EXPOSURE_PCT: riskLimits.MAX_ASSET_CLASS_EXPOSURE_PCT,
        MAX_CORRELATED_EXPOSURE_PCT: riskLimits.MAX_CORRELATED_EXPOSURE_PCT,
        MAX_OPEN_POSITIONS: overrides.MAX_OPEN_POSITIONS ?? riskLimits.MAX_OPEN_POSITIONS,
        MAX_DAILY_LOSS_PCT: overrides.MAX_DAILY_LOSS_PCT ?? riskLimits.MAX_DAILY_LOSS_PCT,
        MAX_DRAWDOWN_PCT: riskLimits.MAX_DRAWDOWN_PCT,
        MAX_SINGLE_TRADE_LOSS_PCT: riskLimits.MAX_SINGLE_TRADE_LOSS_PCT,
        MIN_RISK_REWARD_RATIO: riskLimits.MIN_RISK_REWARD_RATIO,
        MIN_CONFIDENCE_TO_TRADE: overrides.MIN_CONFIDENCE_TO_TRADE ?? riskLimits.MIN_CONFIDENCE_TO_TRADE,
        MIN_SIGNAL_COMPLEXITY: riskLimits.MIN_SIGNAL_COMPLEXITY,
        EVENT_BLACKOUT_HOURS: riskLimits.EVENT_BLACKOUT_HOURS,
        PAPER_ONLY: overrides.PAPER_ONLY ?? false,
      },
      graduated_limits: {
        MAX_SINGLE_POSITION_PCT: riskLimits.MAX_SINGLE_POSITION_PCT,
        MAX_OPEN_POSITIONS: riskLimits.MAX_OPEN_POSITIONS,
        MAX_DAILY_LOSS_PCT: riskLimits.MAX_DAILY_LOSS_PCT,
        MIN_CONFIDENCE_TO_TRADE: riskLimits.MIN_CONFIDENCE_TO_TRADE,
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
  fastify.post('/system/scram/activate', async (request) => {
    const { level } = request.body || {};
    if (!['elevated', 'crisis', 'emergency'].includes(level)) {
      return { error: 'Invalid SCRAM level. Use: elevated, crisis, emergency' };
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

  // POST /api/system/run-cycle — trigger a full agent cycle (fire-and-forget)
  fastify.post('/system/run-cycle', async (request, reply) => {
    const orchestrator = require('../agents/orchestrator');
    orchestrator.runCycle({ broadcast: fastify.broadcast }).catch(err => {
      console.error('[CYCLE] Failed:', err.message);
    });
    return { message: 'Cycle started', status: 'running' };
  });

  // GET /api/system/last-cycle — reconstruct last cycle result for dashboard
  fastify.get('/system/last-cycle', async () => {
    const lastDecision = await queryOne(
      'SELECT cycle_number, created_at FROM agent_decisions ORDER BY cycle_number DESC LIMIT 1'
    );
    if (!lastDecision) return null;

    const cycleNumber = lastDecision.cycle_number;
    const decisions = await queryAll(
      'SELECT agent_name, error, output_json, created_at FROM agent_decisions WHERE cycle_number = $1 ORDER BY created_at ASC',
      [cycleNumber]
    );

    const firstTs = decisions[0]?.created_at;
    const lastTs = decisions[decisions.length - 1]?.created_at;
    const elapsed = firstTs && lastTs
      ? ((new Date(lastTs) - new Date(firstTs)) / 1000).toFixed(1) + 's'
      : '?';

    const knowledgeAgents = ['trend', 'momentum', 'volatility', 'volume', 'pattern', 'orderflow', 'macro', 'sentiment'];
    const agents = decisions
      .filter(d => knowledgeAgents.includes(d.agent_name))
      .map(d => ({
        agent: d.agent_name,
        status: d.error ? 'rejected' : 'fulfilled',
        signals: d.output_json?.signals?.length || 0,
      }));

    const synthDecision = decisions.find(d => d.agent_name === 'synthesizer');
    const riskDecision = decisions.find(d => d.agent_name === 'risk_manager');
    const proposals = synthDecision?.output_json?.proposals || [];
    const approved = riskDecision?.output_json?.approved || riskDecision?.output_json?.trades || [];
    const rejected = riskDecision?.output_json?.rejected || [];

    // Count actual trades executed in this cycle
    const tradeCount = await queryOne(
      "SELECT COUNT(*)::int as count FROM trades WHERE cycle_number = $1",
      [cycleNumber]
    );

    return {
      cycleNumber,
      agents,
      strategy: {
        proposals: proposals.length,
        approved: approved.length,
        rejected: rejected.length,
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
}

module.exports = routes;
