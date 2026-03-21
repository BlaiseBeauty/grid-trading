'use strict';

const { queryAll, queryOne, query } = require('../../../db/connection');

module.exports = async function (fastify) {

  // GET /api/compass/portfolio — latest portfolio guidance with drawdown + last-run
  fastify.get('/portfolio', { preHandler: fastify.authenticate },
    async (request, reply) => {
      const [portfolio, health, drawdownData] = await Promise.all([
        queryOne(`SELECT * FROM compass_portfolios ORDER BY created_at DESC LIMIT 1`),
        queryOne(
          `SELECT last_cycle_at FROM platform_system_health
           WHERE system_name = 'compass' LIMIT 1`
        ).catch(() => null),
        queryOne(
          `SELECT
            MAX(total_value) AS peak,
            (SELECT total_value FROM equity_snapshots ORDER BY created_at DESC LIMIT 1) AS current_val
           FROM equity_snapshots
           WHERE created_at > NOW() - INTERVAL '90 days'`
        ).catch(() => null),
      ]);

      const peak       = parseFloat(drawdownData?.peak);
      const currentVal = parseFloat(drawdownData?.current_val);
      const current_drawdown_pct = (peak > 0 && !isNaN(currentVal))
        ? parseFloat(((peak - currentVal) / peak * 100).toFixed(2))
        : null;

      return reply.send({
        portfolio: portfolio || null,
        last_cycle_at: health?.last_cycle_at || null,
        current_drawdown_pct,
      });
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
