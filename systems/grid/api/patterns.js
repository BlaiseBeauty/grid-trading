'use strict';

const { getAllPatterns } = require('../agents/pattern-store');
const { queryAll }       = require('../../../db/connection');

module.exports = async function (fastify) {

  // GET /api/patterns — all discovered patterns
  fastify.get('/patterns', { preHandler: fastify.authenticate },
    async (request, reply) => {
      const patterns = await getAllPatterns();
      return reply.send({ patterns, count: patterns.length });
    }
  );

  // GET /api/patterns/confirmed — confirmed patterns only
  fastify.get('/patterns/confirmed', { preHandler: fastify.authenticate },
    async (request, reply) => {
      const patterns = await queryAll(
        `SELECT * FROM grid_signal_patterns
         WHERE status = 'confirmed'
         ORDER BY win_rate DESC`
      );
      return reply.send({ patterns, count: patterns.length });
    }
  );

  // GET /api/patterns/:symbol — patterns for a specific symbol
  fastify.get('/patterns/:symbol', { preHandler: fastify.authenticate },
    async (request, reply) => {
      const patterns = await queryAll(
        `SELECT * FROM grid_signal_patterns
         WHERE symbol = $1
         ORDER BY status DESC, win_rate DESC`,
        [request.params.symbol.toUpperCase()]
      );
      return reply.send({ patterns, count: patterns.length });
    }
  );
};
