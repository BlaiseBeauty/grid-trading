/**
 * Confidence Calibration Worker — measures whether the system's confidence
 * scores predict actual win rates. Populates confidence_calibration table.
 */

const { queryAll, query } = require('../../../db/connection');

const BUCKETS = [
  { lower: 50, upper: 55, label: '50-55' },
  { lower: 55, upper: 60, label: '55-60' },
  { lower: 60, upper: 65, label: '60-65' },
  { lower: 65, upper: 70, label: '65-70' },
  { lower: 70, upper: 75, label: '70-75' },
  { lower: 75, upper: 80, label: '75-80' },
  { lower: 80, upper: 101, label: '80+' },
];

/**
 * Run calibration: query all closed trades with entry_confidence,
 * bucket them, compute win rate and avg pnl, upsert into confidence_calibration.
 */
async function runCalibration() {
  const trades = await queryAll(`
    SELECT entry_confidence, pnl_realised
    FROM trades
    WHERE status = 'closed' AND entry_confidence IS NOT NULL
  `);

  if (trades.length === 0) {
    console.log('[CALIBRATION] No closed trades with entry_confidence — skipping');
    return { buckets: [], totalTrades: 0 };
  }

  const results = [];

  for (const bucket of BUCKETS) {
    const inBucket = trades.filter(t => {
      const conf = parseFloat(t.entry_confidence);
      return conf >= bucket.lower && conf < bucket.upper;
    });

    const sampleCount = inBucket.length;
    if (sampleCount === 0) {
      // Upsert with zeros so the table always has all buckets
      await upsertBucket(bucket, 0, 0, 0);
      results.push({
        confidence_bucket: bucket.label,
        confidence_bracket: bucket.lower,
        sample_count: 0,
        actual_win_rate: 0,
        avg_pnl: 0,
        predicted_avg: (bucket.lower + Math.min(bucket.upper, 100)) / 2,
      });
      continue;
    }

    const wins = inBucket.filter(t => parseFloat(t.pnl_realised) > 0).length;
    const winRate = (wins / sampleCount) * 100;
    const avgPnl = inBucket.reduce((sum, t) => sum + parseFloat(t.pnl_realised), 0) / sampleCount;
    const predictedAvg = (bucket.lower + Math.min(bucket.upper, 100)) / 2;
    const calibrationError = Math.abs(predictedAvg - winRate);
    // adjustment_factor: ratio of actual to predicted (>1 = underconfident, <1 = overconfident)
    const adjustmentFactor = predictedAvg > 0 ? winRate / predictedAvg : 1;

    await upsertBucket(bucket, sampleCount, winRate, avgPnl, predictedAvg, calibrationError, adjustmentFactor);

    results.push({
      confidence_bucket: bucket.label,
      confidence_bracket: bucket.lower,
      sample_count: sampleCount,
      actual_win_rate: Math.round(winRate * 100) / 100,
      avg_pnl: Math.round(avgPnl * 100) / 100,
      predicted_avg: predictedAvg,
      calibration_error: Math.round(calibrationError * 100) / 100,
    });
  }

  console.log(`[CALIBRATION] Updated ${results.length} buckets from ${trades.length} closed trades`);
  return { buckets: results, totalTrades: trades.length };
}

async function upsertBucket(bucket, sampleCount, winRate, avgPnl, predictedAvg, calibrationError, adjustmentFactor) {
  predictedAvg = predictedAvg ?? (bucket.lower + Math.min(bucket.upper, 100)) / 2;
  calibrationError = calibrationError ?? 0;
  adjustmentFactor = adjustmentFactor ?? 1;

  await query(`
    INSERT INTO confidence_calibration (
      confidence_bracket, confidence_bucket, sample_size, predicted_avg,
      actual_win_rate, calibration_error, adjustment_factor, avg_pnl, calculated_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
    ON CONFLICT (confidence_bracket)
    DO UPDATE SET
      confidence_bucket = EXCLUDED.confidence_bucket,
      sample_size = EXCLUDED.sample_size,
      predicted_avg = EXCLUDED.predicted_avg,
      actual_win_rate = EXCLUDED.actual_win_rate,
      calibration_error = EXCLUDED.calibration_error,
      adjustment_factor = EXCLUDED.adjustment_factor,
      avg_pnl = EXCLUDED.avg_pnl,
      calculated_at = NOW()
  `, [
    bucket.lower,
    bucket.label,
    sampleCount,
    Math.round(predictedAvg * 100) / 100,
    Math.round(winRate * 100) / 100,
    Math.round(calibrationError * 100) / 100,
    Math.round(adjustmentFactor * 10000) / 10000,
    Math.round(avgPnl * 100) / 100,
  ]);
}

module.exports = { runCalibration };
