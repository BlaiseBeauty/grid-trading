const costsDb = require('../db/queries/costs');

async function routes(fastify) {
  fastify.addHook('preHandler', fastify.authenticate);

  fastify.get('/costs/summary', async (request) => {
    const days = parseInt(request.query.days) || 30;
    const [summary, daily, total] = await Promise.all([
      costsDb.getSummary({ days }),
      costsDb.getDailyBreakdown({ days: Math.min(days, 30) }),
      costsDb.getTotalSpend(),
    ]);
    return { summary, daily, ...total };
  });

  fastify.get('/costs', async (request) => {
    const days = parseInt(request.query.days) || 30;
    const [summary, daily, total] = await Promise.all([
      costsDb.getSummary({ days }),
      costsDb.getDailyBreakdown({ days: Math.min(days, 30) }),
      costsDb.getTotalSpend(),
    ]);
    return { summary, daily, ...total };
  });
}

module.exports = routes;
