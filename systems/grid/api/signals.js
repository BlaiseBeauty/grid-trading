const signalsDb = require('../db/queries/signals');

async function routes(fastify) {
  fastify.addHook('preHandler', fastify.authenticate);

  fastify.get('/signals', async (request) => {
    const { symbol } = request.query;
    if (symbol) {
      return signalsDb.getActive(symbol);
    }
    return signalsDb.getRecent({ limit: parseInt(request.query.limit) || 50 });
  });

  fastify.get('/signals/active', async (request) => {
    return signalsDb.getActive(request.query.symbol);
  });
}

module.exports = routes;
