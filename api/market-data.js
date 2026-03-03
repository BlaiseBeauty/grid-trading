const { queryAll, queryOne } = require('../db/connection');

async function routes(fastify) {
  fastify.addHook('preHandler', fastify.authenticate);

  // GET /api/market-data/:symbol?timeframe=4h&limit=100
  fastify.get('/market-data/:symbol', async (request) => {
    const { symbol } = request.params;
    const timeframe = request.query.timeframe || '4h';
    const limit = parseInt(request.query.limit) || 100;

    // Convert URL-friendly symbol (BTC-USDT) to exchange format (BTC/USDT)
    const dbSymbol = symbol.replace('-', '/');

    return queryAll(`
      SELECT symbol, timeframe, open, high, low, close, volume, indicators, timestamp
      FROM market_data
      WHERE symbol = $1 AND timeframe = $2
      ORDER BY timestamp DESC
      LIMIT $3
    `, [dbSymbol, timeframe, limit]);
  });

  // GET /api/market-data/:symbol/latest
  fastify.get('/market-data/:symbol/latest', async (request, reply) => {
    const dbSymbol = request.params.symbol.replace('-', '/');
    const candle = await queryOne(`
      SELECT * FROM market_data
      WHERE symbol = $1
      ORDER BY timestamp DESC
      LIMIT 1
    `, [dbSymbol]);
    if (!candle) return reply.code(404).send({ error: 'No data found' });
    return candle;
  });
}

module.exports = routes;
