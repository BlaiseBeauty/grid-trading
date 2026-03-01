const tradesDb = require('../db/queries/trades');
const { queryAll } = require('../db/connection');

async function routes(fastify) {
  fastify.addHook('preHandler', fastify.authenticate);

  fastify.get('/trades', async (request) => {
    const { limit, offset, status, symbol } = request.query;
    return tradesDb.getAll({
      limit: parseInt(limit) || 50,
      offset: parseInt(offset) || 0,
      status,
      symbol,
    });
  });

  fastify.get('/trades/open', async () => {
    return tradesDb.getOpen();
  });

  fastify.get('/trades/stats', async () => {
    return tradesDb.getStats();
  });

  fastify.get('/trades/:id', async (request) => {
    const trade = await tradesDb.getById(request.params.id);
    return trade || { error: 'Trade not found' };
  });

  fastify.post('/trades', async (request, reply) => {
    const trade = await tradesDb.create(request.body);
    fastify.broadcast('trade', trade);
    return reply.code(201).send(trade);
  });

  // GET /api/trades/:id/signals — signals that contributed to this trade
  fastify.get('/trades/:id/signals', async (request) => {
    return queryAll(`
      SELECT ts.*, s.symbol, s.signal_type, s.signal_category, s.direction,
             s.strength, s.agent_name, s.reasoning, s.timeframe
      FROM trade_signals ts
      JOIN signals s ON s.id = ts.signal_id
      WHERE ts.trade_id = $1
      ORDER BY ts.created_at
    `, [request.params.id]);
  });

  fastify.patch('/trades/:id/close', async (request) => {
    const trade = await tradesDb.closeTrade(request.params.id, request.body);
    if (trade) fastify.broadcast('trade_closed', trade);
    return trade || { error: 'Trade not found' };
  });
}

module.exports = routes;
