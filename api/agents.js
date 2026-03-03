const decisionsDb = require('../db/queries/decisions');
const orchestrator = require('../agents/orchestrator');
const { queryAll, queryOne } = require('../db/connection');

const AGENT_REGISTRY = {
  knowledge: [
    { name: 'trend', model: 'sonnet', description: 'Trend analysis across timeframes' },
    { name: 'momentum', model: 'sonnet', description: 'Momentum and mean reversion signals' },
    { name: 'volatility', model: 'sonnet', description: 'Volatility regime and breakout detection' },
    { name: 'volume', model: 'sonnet', description: 'Volume profile and flow analysis' },
    { name: 'pattern', model: 'sonnet', description: 'Chart pattern recognition' },
    { name: 'orderflow', model: 'sonnet', description: 'Order book and liquidation analysis' },
    { name: 'macro', model: 'sonnet', description: 'Macro events and correlation' },
    { name: 'sentiment', model: 'sonnet', description: 'Market sentiment and funding rates' },
  ],
  strategy: [
    { name: 'synthesizer', model: 'opus', description: 'Signal synthesis and trade decisions' },
    { name: 'risk_manager', model: 'sonnet', description: 'Position sizing and risk enforcement' },
    { name: 'regime_classifier', model: 'sonnet', description: 'Market regime classification' },
  ],
  analysis: [
    { name: 'performance_analyst', model: 'opus', description: 'Trade and system performance analysis' },
    { name: 'pattern_discovery', model: 'opus', description: 'Strategy template discovery and lifecycle' },
  ],
};

async function routes(fastify) {
  fastify.addHook('preHandler', fastify.authenticate);

  fastify.get('/agents', async () => {
    return AGENT_REGISTRY;
  });

  fastify.get('/agents/decisions', async (request) => {
    const { limit, agent_name } = request.query;
    return decisionsDb.getRecent({
      limit: parseInt(limit) || 50,
      agent_name,
    });
  });

  fastify.get('/agents/decisions/:id', async (request, reply) => {
    const decision = await decisionsDb.getById(request.params.id);
    if (!decision) return reply.code(404).send({ error: 'Decision not found' });
    return decision;
  });

  fastify.get('/agents/costs', async () => {
    return decisionsDb.getCostSummary();
  });

  // POST /api/agents/cycle — manually trigger a full agent cycle
  fastify.post('/agents/cycle', {
    schema: { body: { type: 'object', properties: {} } },
  }, async (request, reply) => {
    // Run async — don't block the response
    orchestrator.runCycle({ broadcast: fastify.broadcast }).catch(err => {
      console.error('[CYCLE] Failed:', err.message);
    });

    return { message: 'Cycle started', status: 'running' };
  });

  // POST /api/agents/refresh-data — just refresh market data without running agents
  fastify.post('/agents/refresh-data', async () => {
    const results = await orchestrator.refreshMarketData();
    return { refreshed: results.length, results };
  });

  // GET /api/agents/rejected — rejected trade opportunities
  fastify.get('/agents/rejected', async (request) => {
    const { limit, symbol } = request.query;
    let sql = `
      SELECT * FROM rejected_opportunities
      ORDER BY created_at DESC
      LIMIT $1
    `;
    const params = [parseInt(limit) || 50];

    if (symbol) {
      sql = `
        SELECT * FROM rejected_opportunities
        WHERE symbol = $2
        ORDER BY created_at DESC
        LIMIT $1
      `;
      params.push(symbol);
    }

    return queryAll(sql, params);
  });

  // POST /api/agents/analyse — manually trigger analysis layer
  fastify.post('/agents/analyse', async (request, reply) => {
    orchestrator.runAnalysisLayer(0, fastify.broadcast).catch(err => {
      console.error('[ANALYSIS] Failed:', err.message);
    });

    return { message: 'Analysis started', status: 'running' };
  });

  // POST /api/agents/monitor — manually trigger position monitoring
  fastify.post('/agents/monitor', async () => {
    const result = await orchestrator.monitorPositions();
    const closed = result?.closed || [];
    if (closed.length > 0) {
      fastify.broadcast('positions_closed', { closed });
    }
    return { closed: closed.length, result };
  });

  // GET /api/agents/regime — current market regime
  fastify.get('/agents/regime', async () => {
    const regimes = await queryAll(`
      SELECT DISTINCT ON (asset_class) *
      FROM market_regime
      ORDER BY asset_class, created_at DESC
    `);
    return regimes;
  });

  // GET /api/agents/regime/history — regime history
  fastify.get('/agents/regime/history', async (request) => {
    const { limit, asset_class } = request.query;
    let sql = 'SELECT * FROM market_regime ORDER BY created_at DESC LIMIT $1';
    const params = [parseInt(limit) || 20];

    if (asset_class) {
      sql = 'SELECT * FROM market_regime WHERE asset_class = $2 ORDER BY created_at DESC LIMIT $1';
      params.push(asset_class);
    }

    return queryAll(sql, params);
  });
}

module.exports = routes;
