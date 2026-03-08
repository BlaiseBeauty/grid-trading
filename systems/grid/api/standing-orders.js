const { queryAll, queryOne, query } = require('../db/connection');

async function routes(fastify) {
  fastify.addHook('preHandler', fastify.authenticate);

  // GET /api/standing-orders — list standing orders (excludes expired by default)
  fastify.get('/standing-orders', async (request) => {
    const { status, symbol } = request.query;
    const conditions = [];
    const params = [];
    let idx = 1;

    if (status) {
      conditions.push(`status = $${idx++}`); params.push(status);
    } else {
      conditions.push(`status != 'expired'`);
    }
    if (symbol) { conditions.push(`symbol = $${idx++}`); params.push(symbol); }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    return queryAll(`SELECT * FROM standing_orders ${where} ORDER BY created_at DESC LIMIT 50`, params);
  });

  // GET /api/standing-orders/active — only active, non-expired orders
  // L-7: Filter out expired orders
  fastify.get('/standing-orders/active', async () => {
    return queryAll("SELECT * FROM standing_orders WHERE status = 'active' AND (expires_at IS NULL OR expires_at > NOW()) ORDER BY priority, created_at DESC");
  });

  // POST /api/standing-orders — create manual standing order
  fastify.post('/standing-orders', {
    schema: {
      body: {
        type: 'object',
        required: ['symbol', 'side', 'conditions'],
        properties: {
          symbol:           { type: 'string', minLength: 1 },
          side:             { type: 'string', enum: ['buy', 'sell'] },
          conditions:       { type: 'object' },
          execution_params: { type: 'object', default: {} },
          confidence:       { type: 'number', minimum: 0, maximum: 100, default: 50 },
          expires_hours:    { type: 'number', minimum: 1, maximum: 720, default: 24 },
        },
      },
    },
  }, async (request, reply) => {
    const { symbol, side, conditions, execution_params, confidence, expires_hours } = request.body;

    const expiresAt = new Date(Date.now() + (expires_hours || 24) * 3600 * 1000).toISOString();

    const result = await queryOne(`
      INSERT INTO standing_orders (
        created_by_agent, symbol, asset_class, side, conditions,
        execution_params, confidence, risk_validated_at, expires_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), $8)
      RETURNING *
    `, [
      'manual',
      symbol,
      'crypto',
      side,
      JSON.stringify(conditions),
      JSON.stringify(execution_params || {}),
      confidence || 50,
      expiresAt,
    ]);

    return reply.code(201).send(result);
  });

  // PATCH /api/standing-orders/:id/cancel — cancel an order
  fastify.patch('/standing-orders/:id/cancel', async (request) => {
    const { reason } = request.body || {};
    return queryOne(`
      UPDATE standing_orders SET status = 'cancelled', cancellation_reason = $2
      WHERE id = $1 AND status = 'active'
      RETURNING *
    `, [request.params.id, reason || 'Manual cancellation']);
  });
}

module.exports = routes;
