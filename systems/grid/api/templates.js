const templatesDb = require('../../../db/queries/templates');
const { queryAll, queryOne } = require('../../../db/connection');

async function routes(fastify) {
  fastify.addHook('preHandler', fastify.authenticate);

  fastify.get('/templates', async (request) => {
    return templatesDb.getAll({ status: request.query.status });
  });

  fastify.get('/templates/active', async () => {
    return templatesDb.getActive();
  });

  fastify.get('/templates/:id', async (request, reply) => {
    const template = await templatesDb.getById(request.params.id);
    if (!template) return reply.code(404).send({ error: 'Template not found' });
    return template;
  });

  // Template with full performance data
  // H-12: Use actual column names from template_performance schema
  fastify.get('/templates/:id/performance', async (request, reply) => {
    const template = await queryOne(`
      SELECT st.*,
        tp.total_trades, tp.win_rate, tp.avg_return_pct,
        tp.profit_factor, tp.sharpe, tp.max_drawdown,
        tp.calmar_ratio, tp.sortino_ratio, tp.expectancy,
        tp.concentration_ratio, tp.outlier_dependent,
        tp.total_pnl, tp.tail_risk, tp.recovery_factor
      FROM strategy_templates st
      LEFT JOIN template_performance tp ON st.id = tp.template_id
      WHERE st.id = $1
      ORDER BY tp.period_end DESC NULLS LAST
      LIMIT 1
    `, [request.params.id]);
    if (!template) return reply.code(404).send({ error: 'Template not found' });
    return template;
  });

  fastify.patch('/templates/:id/status', async (request, reply) => {
    const { status } = request.body;
    if (!['testing', 'active', 'paused', 'retired'].includes(status)) {
      return reply.code(400).send({ error: 'Invalid status' });
    }
    const template = await templatesDb.updateStatus(request.params.id, status);
    if (!template) return reply.code(404).send({ error: 'Template not found' });
    return template;
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
