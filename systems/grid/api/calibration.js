/**
 * Calibration API — returns confidence calibration data.
 * GET /api/calibration — full calibration table + calibration_score
 */

const { queryAll } = require('../../../db/connection');
const { runCalibration } = require('../agents/calibration-worker');
const { getLatestCorrelations } = require('../agents/correlation-calculator');

async function routes(fastify) {
  fastify.addHook('preHandler', fastify.authenticate);

  fastify.get('/calibration', async () => {
    const buckets = await queryAll(`
      SELECT confidence_bracket, confidence_bucket, sample_size,
             predicted_avg, actual_win_rate, calibration_error,
             adjustment_factor, avg_pnl, calculated_at
      FROM confidence_calibration
      ORDER BY confidence_bracket ASC
    `);

    // Calibration score: 100 minus average absolute deviation between
    // predicted midpoint and actual win rate, across buckets with >5 samples.
    const qualified = buckets.filter(b => b.sample_size > 5);
    let calibrationScore = null;

    if (qualified.length > 0) {
      const avgDeviation = qualified.reduce((sum, b) => {
        return sum + Math.abs(parseFloat(b.predicted_avg) - parseFloat(b.actual_win_rate));
      }, 0) / qualified.length;
      calibrationScore = Math.max(0, Math.round((100 - avgDeviation) * 100) / 100);
    }

    const totalTrades = buckets.reduce((sum, b) => sum + (b.sample_size || 0), 0);

    return {
      buckets,
      calibration_score: calibrationScore,
      total_trades: totalTrades,
      qualified_buckets: qualified.length,
    };
  });

  // POST /api/calibration/run — manually trigger recalibration
  fastify.post('/calibration/run', async (request, reply) => {
    const result = await runCalibration();
    fastify.broadcast('calibration_update', result);
    return reply.code(200).send(result);
  });

  // GET /api/correlations — latest correlation matrix
  fastify.get('/correlations', async () => {
    return getLatestCorrelations();
  });
}

module.exports = routes;
