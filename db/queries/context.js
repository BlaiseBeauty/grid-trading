const { queryAll, queryOne } = require('../connection');

async function getCurrentRegime() {
  const row = await queryOne(`
    SELECT regime, confidence, transition_probabilities, created_at
    FROM market_regime ORDER BY created_at DESC LIMIT 1
  `);
  return row || { regime: 'unknown', confidence: 0 };
}

async function getPortfolioState() {
  const positions = await queryAll(`
    SELECT symbol, asset_class, quantity, avg_entry_price, current_price,
           unrealised_pnl, allocation_pct, exchange
    FROM portfolio_state WHERE quantity > 0
    ORDER BY allocation_pct DESC
  `);
  const total = await queryOne(`
    SELECT SUM(unrealised_pnl) as total_unrealised,
           COUNT(*) as open_positions
    FROM portfolio_state WHERE quantity > 0
  `);
  return { positions: positions || [], ...total };
}

async function getActiveSignals(symbol = null, maxAge = '24 hours', limit = null) {
  const params = symbol ? [maxAge, symbol] : [maxAge];
  let limitClause = '';
  if (limit) {
    params.push(limit);
    limitClause = `LIMIT $${params.length}`;
  }
  return queryAll(`
    SELECT id, agent_name, symbol, signal_type, signal_category,
           direction, strength, timeframe, parameters, reasoning,
           ttl_candles, decay_model, created_at,
           CASE decay_model
             WHEN 'linear' THEN GREATEST(0, strength * (1.0 -
               EXTRACT(EPOCH FROM (NOW() - created_at)) /
               NULLIF(EXTRACT(EPOCH FROM (expires_at - created_at)), 0)))
             WHEN 'exponential' THEN strength * EXP(
               -3.0 * EXTRACT(EPOCH FROM (NOW() - created_at)) /
               NULLIF(EXTRACT(EPOCH FROM (expires_at - created_at)), 0))
             ELSE strength
           END AS decayed_strength
    FROM signals
    WHERE expires_at > NOW()
    AND created_at > NOW() - $1::interval
    ${symbol ? 'AND symbol = $2' : ''}
    ORDER BY decayed_strength DESC
    ${limitClause}
  `, params);
}

async function getRecentTrades(limit = 20) {
  return queryAll(`
    SELECT id, symbol, side, entry_price, exit_price, pnl_pct,
           template_id, entry_confidence, outcome_class, execution_tier,
           opened_at, closed_at, status
    FROM trades ORDER BY opened_at DESC LIMIT $1
  `, [limit]);
}

async function getUpcomingEvents(hours = 48) {
  return queryAll(`
    SELECT event_type, event_name, affected_assets, event_date, impact_estimate, notes
    FROM events_calendar
    WHERE event_date BETWEEN NOW() AND NOW() + $1::interval
    ORDER BY event_date
  `, [`${hours} hours`]);
}

async function getScramState() {
  return queryOne(`
    SELECT level, trigger_name, trigger_value, threshold_value, activated_at
    FROM scram_events
    WHERE cleared_at IS NULL
    ORDER BY activated_at DESC LIMIT 1
  `);
}

async function getBootstrapPhase() {
  return queryOne(`
    SELECT phase, total_closed_trades, system_age_days
    FROM bootstrap_status ORDER BY id DESC LIMIT 1
  `);
}

async function getExternalData(source, metrics, symbol = null) {
  const rows = await queryAll(`
    SELECT DISTINCT ON (metric) source, metric, symbol, data, fetched_at
    FROM external_data_cache
    WHERE source = $1
    AND metric = ANY($2)
    ${symbol ? 'AND (symbol = $3 OR symbol IS NULL)' : ''}
    AND fetched_at > NOW() - INTERVAL '1 second' * ttl_seconds
    ORDER BY metric, fetched_at DESC
  `, symbol ? [source, metrics, symbol] : [source, metrics]);

  const result = {};
  rows.forEach(r => { result[r.metric] = { data: r.data, fetched_at: r.fetched_at }; });
  return result;
}

module.exports = {
  getCurrentRegime, getPortfolioState, getActiveSignals,
  getRecentTrades, getUpcomingEvents, getScramState,
  getBootstrapPhase, getExternalData,
};
