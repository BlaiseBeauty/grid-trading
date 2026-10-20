const costsDb = require('../../../db/queries/costs');

async function routes(fastify) {
  fastify.addHook('preHandler', fastify.authenticate);

  // Clamp the lookback window to 1..365 days
  const parseDays = (v) => Math.min(Math.max(parseInt(v) || 30, 1), 365);

  fastify.get('/costs/summary', async (request) => {
    const days = parseDays(request.query.days);
    const [summary, daily, total] = await Promise.all([
      costsDb.getSummary({ days }),
      costsDb.getDailyBreakdown({ days: Math.min(days, 30) }),
      costsDb.getTotalSpend(),
    ]);
    return { summary, daily, ...total };
  });

  fastify.get('/costs', async (request) => {
    const days = parseDays(request.query.days);
    const [summary, daily, total] = await Promise.all([
      costsDb.getSummary({ days }),
      costsDb.getDailyBreakdown({ days: Math.min(days, 30) }),
      costsDb.getTotalSpend(),
    ]);
    return { summary, daily, ...total };
  });
}

module.exports = routes;
