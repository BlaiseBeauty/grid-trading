const cycleReportsDb = require('../db/queries/cycle-reports');

async function routes(fastify) {
  fastify.addHook('preHandler', fastify.authenticate);

  fastify.get('/cycle-reports', async (request) => {
    const limit = parseInt(request.query.limit) || 10;
    return cycleReportsDb.getRecent(limit);
  });
}

module.exports = routes;
