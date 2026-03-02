const { queryAll, queryOne } = require('../db/connection');

async function routes(fastify) {
  fastify.addHook('preHandler', fastify.authenticate);

  // GET /api/analytics/pnl — daily P&L breakdown
  fastify.get('/analytics/pnl', async (request) => {
    const { period } = request.query; // daily, weekly, monthly
    let trunc = 'day';
    if (period === 'weekly') trunc = 'week';
    if (period === 'monthly') trunc = 'month';

    return queryAll(`
      SELECT DATE_TRUNC($1, closed_at) as period,
        COUNT(*)::int as trade_count,
        COUNT(*) FILTER (WHERE pnl_realised > 0)::int as wins,
        COUNT(*) FILTER (WHERE pnl_realised <= 0)::int as losses,
        COALESCE(SUM(pnl_realised), 0) as total_pnl,
        COALESCE(AVG(pnl_pct), 0) as avg_return_pct,
        COALESCE(MAX(pnl_realised), 0) as best_trade,
        COALESCE(MIN(pnl_realised), 0) as worst_trade
      FROM trades
      WHERE status = 'closed' AND closed_at IS NOT NULL
      GROUP BY DATE_TRUNC($1, closed_at)
      ORDER BY period DESC
      LIMIT 90
    `, [trunc]);
  });

  // GET /api/analytics/drawdown — drawdown series from equity snapshots
  fastify.get('/analytics/drawdown', async () => {
    const snapshots = await queryAll(`
      SELECT total_value, created_at FROM equity_snapshots ORDER BY created_at ASC
    `);
    if (!snapshots.length) return [];

    let peak = 0;
    return snapshots.map(s => {
      const value = parseFloat(s.total_value);
      if (value > peak) peak = value;
      const drawdown = peak > 0 ? ((value - peak) / peak) * 100 : 0;
      return { time: s.created_at, value, peak, drawdown };
    });
  });

  // GET /api/analytics/by-agent — win rate and P&L per originating agent
  fastify.get('/analytics/by-agent', async () => {
    return queryAll(`
      SELECT
        s.agent_name,
        COUNT(DISTINCT t.id)::int as trade_count,
        ROUND(100.0 * COUNT(DISTINCT t.id) FILTER (WHERE t.pnl_realised > 0) /
          NULLIF(COUNT(DISTINCT t.id), 0), 1) as win_rate,
        COALESCE(SUM(t.pnl_realised), 0) as total_pnl,
        COALESCE(AVG(t.pnl_pct), 0) as avg_return
      FROM trade_signals ts
      JOIN signals s ON s.id = ts.signal_id
      JOIN trades t ON t.id = ts.trade_id AND t.status = 'closed'
      GROUP BY s.agent_name
      ORDER BY total_pnl DESC
    `);
  });

  // GET /api/analytics/by-template — performance per template
  fastify.get('/analytics/by-template', async () => {
    return queryAll(`
      SELECT
        st.name as template_name,
        st.status,
        tp.total_trades::int,
        tp.win_rate,
        tp.avg_return_pct,
        tp.total_pnl,
        tp.profit_factor,
        tp.max_drawdown_pct,
        tp.sharpe as sharpe_ratio
      FROM template_performance tp
      JOIN strategy_templates st ON st.id = tp.template_id
      ORDER BY tp.total_pnl DESC
    `);
  });

  // GET /api/analytics/signal-accuracy — signal direction vs trade outcome
  fastify.get('/analytics/signal-accuracy', async () => {
    return queryAll(`
      SELECT
        s.signal_category,
        s.signal_type,
        COUNT(*)::int as total_signals,
        COUNT(*) FILTER (WHERE
          (s.direction = 'bullish' AND t.pnl_realised > 0) OR
          (s.direction = 'bearish' AND t.pnl_realised > 0)
        )::int as correct,
        ROUND(100.0 * COUNT(*) FILTER (WHERE
          (s.direction = 'bullish' AND t.pnl_realised > 0) OR
          (s.direction = 'bearish' AND t.pnl_realised > 0)
        ) / NULLIF(COUNT(*), 0), 1) as accuracy_pct
      FROM trade_signals ts
      JOIN signals s ON s.id = ts.signal_id
      JOIN trades t ON t.id = ts.trade_id AND t.status = 'closed'
      GROUP BY s.signal_category, s.signal_type
      HAVING COUNT(*) >= 3
      ORDER BY accuracy_pct DESC
    `);
  });

  // GET /api/analytics/costs-over-time — AI cost trend
  fastify.get('/analytics/costs-over-time', async () => {
    return queryAll(`
      SELECT DATE(created_at) as date,
        COALESCE(SUM(cost_usd), 0) as daily_cost,
        COUNT(*)::int as call_count,
        COALESCE(SUM(input_tokens + output_tokens), 0) as total_tokens
      FROM system_costs
      GROUP BY DATE(created_at)
      ORDER BY date ASC
      LIMIT 90
    `);
  });

  // GET /api/analytics/summary — high-level performance metrics
  fastify.get('/analytics/summary', async () => {
    const [tradeMetrics, costMetrics, streaks] = await Promise.all([
      queryOne(`
        SELECT
          COUNT(*) FILTER (WHERE status = 'closed')::int as total_trades,
          ROUND(100.0 * COUNT(*) FILTER (WHERE pnl_realised > 0) /
            NULLIF(COUNT(*) FILTER (WHERE status = 'closed'), 0), 1) as win_rate,
          COALESCE(SUM(pnl_realised) FILTER (WHERE status = 'closed'), 0) as total_pnl,
          COALESCE(AVG(pnl_pct) FILTER (WHERE status = 'closed'), 0) as avg_return,
          COALESCE(MAX(pnl_realised) FILTER (WHERE status = 'closed'), 0) as best_trade,
          COALESCE(MIN(pnl_realised) FILTER (WHERE status = 'closed'), 0) as worst_trade,
          COALESCE(AVG(EXTRACT(EPOCH FROM (closed_at - opened_at)) / 3600) FILTER (WHERE status = 'closed'), 0) as avg_hold_hours
        FROM trades
      `),
      queryOne('SELECT COALESCE(SUM(cost_usd), 0) as total_cost, COUNT(*)::int as total_calls FROM system_costs'),
      queryOne(`
        WITH streaks AS (
          SELECT pnl_realised > 0 as win,
            ROW_NUMBER() OVER (ORDER BY closed_at) -
            ROW_NUMBER() OVER (PARTITION BY (pnl_realised > 0) ORDER BY closed_at) as grp
          FROM trades WHERE status = 'closed' AND closed_at IS NOT NULL
        )
        SELECT
          COALESCE(MAX(cnt) FILTER (WHERE win), 0) as max_win_streak,
          COALESCE(MAX(cnt) FILTER (WHERE NOT win), 0) as max_loss_streak
        FROM (SELECT win, COUNT(*) as cnt FROM streaks GROUP BY win, grp) sub
      `),
    ]);

    return { ...tradeMetrics, ...costMetrics, ...streaks };
  });
}

module.exports = routes;
