'use strict';

const { getActiveTheses, getThesisById, retireThesis } = require('../db/theses');
const { queryAll, queryOne } = require('../../../db/connection');

module.exports = async function (fastify) {

  // GET /api/oracle/theses — all active theses
  fastify.get('/theses', { preHandler: fastify.authenticate },
    async (request, reply) => {
      const theses = await getActiveTheses();
      return reply.send({ theses, count: theses.length });
    }
  );

  // GET /api/oracle/theses/:id — single thesis with evidence
  fastify.get('/theses/:id', { preHandler: fastify.authenticate },
    async (request, reply) => {
      const thesis = await getThesisById(request.params.id);
      if (!thesis) return reply.code(404).send({ error: 'Thesis not found' });

      const evidence = await queryAll(
        `SELECT id, source_name, headline, relevance_score, sentiment, created_at
         FROM oracle_evidence WHERE thesis_id = $1
         ORDER BY relevance_score DESC, created_at DESC LIMIT 20`,
        [request.params.id]
      );

      const history = await queryAll(
        `SELECT old_conviction, new_conviction, reason, created_at
         FROM oracle_conviction_history WHERE thesis_id = $1
         ORDER BY created_at DESC LIMIT 10`,
        [request.params.id]
      );

      return reply.send({ thesis, evidence, conviction_history: history });
    }
  );

  // GET /api/oracle/opportunity-map — latest opportunity map
  fastify.get('/opportunity-map', { preHandler: fastify.authenticate },
    async (request, reply) => {
      const map = await queryOne(
        `SELECT * FROM oracle_opportunity_map ORDER BY created_at DESC LIMIT 1`
      );
      return reply.send({ map: map || null });
    }
  );

  // GET /api/oracle/macro-regime — latest macro regime
  fastify.get('/macro-regime', { preHandler: fastify.authenticate },
    async (request, reply) => {
      const regime = await queryOne(
        `SELECT * FROM oracle_macro_regime ORDER BY created_at DESC LIMIT 1`
      );
      return reply.send({ regime: regime || null });
    }
  );

  // GET /api/oracle/graveyard — retired theses with post-mortems
  fastify.get('/graveyard', { preHandler: fastify.authenticate },
    async (request, reply) => {
      const entries = await queryAll(
        `SELECT * FROM oracle_graveyard ORDER BY closed_at DESC LIMIT 20`
      );
      return reply.send({ graveyard: entries, count: entries.length });
    }
  );

  // GET /api/oracle/evidence — recent evidence feed
  fastify.get('/evidence', { preHandler: fastify.authenticate },
    async (request, reply) => {
      const limit  = Math.min(parseInt(request.query.limit) || 50, 200);
      const domain = request.query.domain;

      const where = domain
        ? `WHERE $2 = ANY(domain_tags) AND created_at > NOW() - INTERVAL '48 hours'`
        : `WHERE created_at > NOW() - INTERVAL '48 hours'`;

      const params = domain ? [limit, domain] : [limit];
      const evidence = await queryAll(
        `SELECT id, source_type, source_name, headline, relevance_score,
                sentiment, domain_tags, created_at
         FROM oracle_evidence
         ${where}
         ORDER BY relevance_score DESC, created_at DESC
         LIMIT $1`,
        params
      );

      return reply.send({ evidence, count: evidence.length });
    }
  );

  // POST /api/oracle/theses/:id/retire — retire a thesis manually
  fastify.post('/theses/:id/retire', { preHandler: fastify.authenticate },
    async (request, reply) => {
      const { reason } = request.body || {};
      await retireThesis(request.params.id, reason || 'Manual retirement');
      return reply.send({ ok: true });
    }
  );

  // POST /api/oracle/cycle/run — manually trigger ORACLE cycle
  fastify.post('/cycle/run', { preHandler: fastify.authenticate },
    async (request, reply) => {
      const { runCycle } = require('../agents/orchestrator');
      try {
        const result = await runCycle();
        return reply.send({
          ok: true,
          agents_succeeded: result.agentsSucceeded,
          agents_failed:    result.agentsFailed,
          theses_saved:     result.savedTheses.length,
        });
      } catch (err) {
        return reply.code(500).send({ error: err.message });
      }
    }
  );

  // POST /api/oracle/graveyard/run — manually trigger Graveyard Auditor
  fastify.post('/graveyard/run', { preHandler: fastify.authenticate },
    async (request, reply) => {
      const { runGraveyardAuditor } = require('../agents/graveyard-auditor');
      const { updateDomainCalibration } = require('../agents/calibration');
      try {
        const result = await runGraveyardAuditor();
        const domains = ['macro', 'geopolitical', 'technology', 'commodity', 'equity', 'crypto'];
        for (const d of domains) await updateDomainCalibration(d).catch(() => {});
        return reply.send({ ok: true, ...result });
      } catch (err) {
        return reply.code(500).send({ error: err.message });
      }
    }
  );

  // GET /api/oracle/calibration — current domain multipliers and stats
  fastify.get('/calibration', { preHandler: fastify.authenticate },
    async (request, reply) => {
      const { computeMultipliers } = require('../agents/calibration');
      const [multipliers, stats, learnings] = await Promise.all([
        computeMultipliers(),
        queryAll(
          `SELECT DISTINCT ON (domain)
             domain, directional_accuracy, trade_win_rate,
             theses_retired, conviction_multiplier, created_at
           FROM oracle_calibration
           ORDER BY domain, created_at DESC`
        ),
        queryAll(
          `SELECT domain, learning_type, summary, adjustment_rule, created_at
           FROM oracle_calibration_learnings
           ORDER BY created_at DESC LIMIT 20`
        ),
      ]);
      return reply.send({ multipliers, stats, learnings });
    }
  );
};
