'use strict';

const { queryAll, queryOne } = require('../../../db/connection');
const { buildDigest } = require('../agents/performance-digest');

module.exports = async function (fastify) {

  // GET /api/performance-digest — list recent digests
  fastify.get('/performance-digest', {
    preHandler: fastify.authenticate,
  }, async (request, reply) => {
    const limit = Math.min(parseInt(request.query.limit) || 12, 52);

    const digests = await queryAll(
      `SELECT id, period_label, period_start, period_end,
              total_trades, win_rate, total_pnl_usd,
              sharpe_ratio, max_drawdown_pct, total_ai_cost_usd,
              cost_per_trade, created_at
       FROM grid_performance_digests
       ORDER BY period_end DESC
       LIMIT $1`,
      [limit]
    );

    return reply.send({ digests });
  });

  // GET /api/performance-digest/latest — most recent digest
  fastify.get('/performance-digest/latest', {
    preHandler: fastify.authenticate,
  }, async (request, reply) => {
    const digest = await queryOne(
      `SELECT * FROM grid_performance_digests
       ORDER BY period_end DESC LIMIT 1`
    );

    return reply.send({ digest: digest || null });
  });

  // GET /api/performance-digest/:id — single digest with full detail
  fastify.get('/performance-digest/:id', {
    preHandler: fastify.authenticate,
  }, async (request, reply) => {
    const { id } = request.params;

    const digest = await queryOne(
      'SELECT * FROM grid_performance_digests WHERE id = $1',
      [parseInt(id)]
    );

    if (!digest) return reply.code(404).send({ error: 'Digest not found' });
    return reply.send({ digest });
  });

  // POST /api/performance-digest/build — manually trigger a digest build
  // Useful for initial backfill and testing
  fastify.post('/performance-digest/build', {
    preHandler: fastify.authenticate,
  }, async (request, reply) => {
    const { start, end } = request.body || {};

    try {
      const digest = await buildDigest({
        start: start ? new Date(start) : undefined,
        end:   end   ? new Date(end)   : undefined,
      });

      if (!digest) {
        return reply.send({ ok: true, message: 'No trades in period — digest not created' });
      }

      return reply.send({ ok: true, digest });
    } catch (err) {
      return reply.code(500).send({ error: err.message });
    }
  });
};
