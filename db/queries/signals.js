const { queryAll, queryOne, query } = require('../connection');

async function getActive(symbol) {
  const conditions = ['expires_at > NOW()'];
  const params = [];

  if (symbol) {
    conditions.push('symbol = $1');
    params.push(symbol);
  }

  return queryAll(`
    SELECT *,
      CASE decay_model
        WHEN 'linear' THEN strength * GREATEST(0, 1.0 -
          EXTRACT(EPOCH FROM (NOW() - created_at)) /
          NULLIF(EXTRACT(EPOCH FROM (expires_at - created_at)), 0))
        WHEN 'exponential' THEN strength * EXP(
          -3.0 * EXTRACT(EPOCH FROM (NOW() - created_at)) /
          NULLIF(EXTRACT(EPOCH FROM (expires_at - created_at)), 0))
        ELSE strength
      END as current_strength
    FROM signals
    WHERE ${conditions.join(' AND ')}
    ORDER BY created_at DESC
  `, params);
}

async function getRecent({ limit = 50 } = {}) {
  return queryAll('SELECT * FROM signals ORDER BY created_at DESC LIMIT $1', [limit]);
}

async function create(signal) {
  const { agent_name, agent_decision_id, symbol, asset_class, signal_type,
    signal_category, direction, strength, parameters, reasoning,
    cycle_number, timeframe, ttl_candles, expires_at, decay_model } = signal;

  return queryOne(`
    INSERT INTO signals (
      agent_name, agent_decision_id, symbol, asset_class, signal_type,
      signal_category, direction, strength, parameters, reasoning,
      cycle_number, timeframe, ttl_candles, expires_at, decay_model
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
    RETURNING *
  `, [agent_name, agent_decision_id, symbol, asset_class, signal_type,
    signal_category, direction, strength, JSON.stringify(parameters), reasoning,
    cycle_number, timeframe || '4h', ttl_candles || 6, expires_at, decay_model || 'linear']);
}

async function cleanExpired() {
  // First remove FK references in trade_signals, then delete the expired signals
  await query(
    `DELETE FROM trade_signals WHERE signal_id IN (
       SELECT id FROM signals WHERE expires_at < NOW() - INTERVAL '7 days'
     )`
  );
  return query("DELETE FROM signals WHERE expires_at < NOW() - INTERVAL '7 days'");
}

async function linkToTrade(tradeId, signalId, strengthAtEntry) {
  return query(`
    INSERT INTO trade_signals (trade_id, signal_id, was_entry_signal, strength_at_entry)
    VALUES ($1, $2, true, $3)
    ON CONFLICT DO NOTHING
  `, [tradeId, signalId, strengthAtEntry]);
}

module.exports = { getActive, getRecent, create, cleanExpired, linkToTrade };
