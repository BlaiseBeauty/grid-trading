'use strict';

const { queryAll, queryOne, query } = require('../../../db/connection');

module.exports = async function (fastify) {

  // GET /api/compass/portfolio — latest portfolio guidance
  fastify.get('/portfolio', { preHandler: fastify.authenticate },
    async (request, reply) => {
      const portfolio = await queryOne(
        `SELECT * FROM compass_portfolios ORDER BY created_at DESC LIMIT 1`
      );
      return reply.send({ portfolio: portfolio || null });
    }
  );

  // GET /api/compass/portfolio/history — recent portfolio snapshots
  fastify.get('/portfolio/history', { preHandler: fastify.authenticate },
    async (request, reply) => {
      const limit = Math.min(parseInt(request.query.limit) || 24, 100);
      const history = await queryAll(
        `SELECT id, risk_posture, cash_weight, oracle_thesis_count,
                grid_sharpe, grid_win_rate, created_at
         FROM compass_portfolios ORDER BY created_at DESC LIMIT $1`,
        [limit]
      );
      return reply.send({ history });
    }
  );

  // GET /api/compass/allocations — current valid allocations per symbol
  fastify.get('/allocations', { preHandler: fastify.authenticate },
    async (request, reply) => {
      const allocations = await queryAll(
        `SELECT a.*, p.risk_posture
         FROM compass_allocations a
         JOIN compass_portfolios p ON a.portfolio_id = p.id
         WHERE a.valid_until > NOW()
         ORDER BY a.max_position_usd DESC`
      );
      return reply.send({ allocations });
    }
  );

  // GET /api/compass/risk — latest risk assessment
  fastify.get('/risk', { preHandler: fastify.authenticate },
    async (request, reply) => {
      const assessment = await queryOne(
        `SELECT * FROM compass_risk_assessments ORDER BY created_at DESC LIMIT 1`
      );
      return reply.send({ assessment: assessment || null });
    }
  );

  // GET /api/compass/risk/history — risk score trend
  fastify.get('/risk/history', { preHandler: fastify.authenticate },
    async (request, reply) => {
      const limit = Math.min(parseInt(request.query.limit) || 48, 200);
      const history = await queryAll(
        `SELECT id, risk_score, market_risk, concentration_risk,
                max_single_position_usd, flags, created_at
         FROM compass_risk_assessments ORDER BY created_at DESC LIMIT $1`,
        [limit]
      );
      return reply.send({ history });
    }
  );

  // GET /api/compass/rebalance — pending rebalance recommendations
  fastify.get('/rebalance', { preHandler: fastify.authenticate },
    async (request, reply) => {
      const pending = await queryAll(
        `SELECT * FROM compass_rebalance_log
         WHERE acknowledged_at IS NULL
         ORDER BY created_at DESC LIMIT 20`
      );
      return reply.send({ pending, count: pending.length });
    }
  );

  // POST /api/compass/rebalance/:id/acknowledge
  fastify.post('/rebalance/:id/acknowledge', { preHandler: fastify.authenticate },
    async (request, reply) => {
      await query(
        'UPDATE compass_rebalance_log SET acknowledged_at = NOW() WHERE id = $1',
        [parseInt(request.params.id)]
      );
      return reply.send({ ok: true });
    }
  );

  // POST /api/compass/cycle/run — manually trigger COMPASS cycle
  fastify.post('/cycle/run', { preHandler: fastify.authenticate },
    async (request, reply) => {
      const { runCycle } = require('../agents/orchestrator');
      try {
        const result = await runCycle();
        return reply.send({
          ok:          true,
          risk_posture: result.portfolio?.risk_posture,
          risk_score:   result.risk?.risk_score,
          cash_weight:  result.portfolio?.cash_weight,
        });
      } catch (err) {
        return reply.code(500).send({ error: err.message });
      }
    }
  );
};
