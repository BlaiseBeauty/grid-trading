'use strict';

// ============================================================================
// GRID — Observation API routes
// GET  /api/observation/history  — last 7 days of market_observations
// GET  /api/observation/latest   — most recent observation
// POST /api/observation/collect  — manual trigger (rate-limited)
// ============================================================================

const { queryAll, queryOne } = require('../../../db/connection');

module.exports = async function observationRoutes(fastify) {
  // Last 7 days of observations (28 records max at 6h cadence)
  fastify.get('/observation/history', { preHandler: fastify.authenticate }, async (req, reply) => {
    const rows = await queryAll(`
      SELECT
        id, observed_at,
        btc_price, btc_volume_24h, btc_change_24h,
        eth_price, eth_volume_24h, eth_change_24h,
        total_market_cap, btc_dominance,
        fear_greed_value, fear_greed_label,
        dxy, treasury_10y, gold_price
      FROM market_observations
      ORDER BY observed_at DESC
      LIMIT 28
    `);
    return rows;
  });

  // Latest single observation
  fastify.get('/observation/latest', { preHandler: fastify.authenticate }, async (req, reply) => {
    const row = await queryOne(`
      SELECT *
      FROM market_observations
      ORDER BY observed_at DESC
      LIMIT 1
    `);
    return row ?? { error: 'No observations yet — first run pending' };
  });

  // Manual trigger — rate-limited to 5/min
  fastify.post('/observation/collect', {
    preHandler: fastify.authenticate,
    config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    const { runObservation } = require('../observation/market-observer');
    const result = await runObservation();
    return { ok: true, snapshot: result };
  });
};
