const templatesDb = require('../db/queries/templates');
const { queryAll, queryOne } = require('../db/connection');

async function routes(fastify) {
  fastify.addHook('preHandler', fastify.authenticate);

  fastify.get('/templates', async (request) => {
    return templatesDb.getAll({ status: request.query.status });
  });

  fastify.get('/templates/active', async () => {
    return templatesDb.getActive();
  });

  fastify.get('/templates/:id', async (request) => {
    const template = await templatesDb.getById(request.params.id);
    return template || { error: 'Template not found' };
  });

  // Template with full performance data
  fastify.get('/templates/:id/performance', async (request) => {
    const template = await queryOne(`
      SELECT st.*, tp.total_trades, tp.wins, tp.losses,
        tp.win_rate, tp.avg_pnl_pct, tp.profit_factor,
        tp.sharpe as sharpe_ratio, tp.max_drawdown as max_drawdown_pct, tp.best_trade_pnl,
        tp.worst_trade_pnl, tp.avg_hold_duration_hours
      FROM strategy_templates st
      LEFT JOIN template_performance tp ON st.id = tp.template_id
      WHERE st.id = $1
    `, [request.params.id]);
    return template || { error: 'Template not found' };
  });

  fastify.patch('/templates/:id/status', async (request) => {
    const { status } = request.body;
    if (!['testing', 'active', 'paused', 'retired'].includes(status)) {
      return { error: 'Invalid status' };
    }
    const template = await templatesDb.updateStatus(request.params.id, status);
    return template || { error: 'Template not found' };
  });

  // Anti-patterns
  fastify.get('/anti-patterns', async () => {
    return queryAll('SELECT * FROM anti_patterns WHERE active = true ORDER BY lose_rate DESC');
  });

  fastify.get('/anti-patterns/all', async () => {
    return queryAll('SELECT * FROM anti_patterns ORDER BY updated_at DESC');
  });
}

module.exports = routes;
