const portfolioDb = require('../db/queries/portfolio');

async function routes(fastify) {
  fastify.addHook('preHandler', fastify.authenticate);

  fastify.get('/portfolio', async () => {
    const [holdings, totals, portfolioValue] = await Promise.all([
      portfolioDb.getAll(),
      portfolioDb.getTotalValue(),
      portfolioDb.getPortfolioValue(),
    ]);
    return { holdings, ...totals, ...portfolioValue };
  });

  fastify.get('/portfolio/:symbol', async (request) => {
    const position = await portfolioDb.getBySymbol(request.params.symbol);
    return position || { error: 'No position found' };
  });
}

module.exports = routes;
