const { queryAll, queryOne, query } = require('../connection');

async function getAll({ limit = 50, offset = 0, status, symbol } = {}) {
  const conditions = [];
  const params = [];
  let idx = 1;

  if (status) { conditions.push(`status = $${idx++}`); params.push(status); }
  if (symbol) { conditions.push(`symbol = $${idx++}`); params.push(symbol); }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  params.push(limit, offset);

  return queryAll(`
    SELECT * FROM trades ${where}
    ORDER BY created_at DESC
    LIMIT $${idx++} OFFSET $${idx}
  `, params);
}

async function getById(id) {
  return queryOne('SELECT * FROM trades WHERE id = $1', [id]);
}

async function getOpen() {
  return queryAll("SELECT * FROM trades WHERE status = 'open' ORDER BY opened_at DESC");
}

async function create(trade) {
  const { symbol, asset_class, exchange, side, quantity, entry_price,
    tp_price, sl_price, template_id, execution_tier, confidence,
    mode, cycle_number, agent_decision_id, reasoning, bootstrap_phase,
    entry_confidence, kelly_optimal_pct, kelly_inputs,
    complexity_score, signal_domains, signal_timeframes } = trade;

  return queryOne(`
    INSERT INTO trades (
      symbol, asset_class, exchange, side, quantity, entry_price,
      tp_price, sl_price, template_id, execution_tier, confidence,
      mode, cycle_number, agent_decision_id, reasoning, bootstrap_phase,
      entry_confidence, kelly_optimal_pct, kelly_inputs,
      complexity_score, signal_domains, signal_timeframes
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)
    RETURNING *
  `, [symbol, asset_class, exchange, side, quantity, entry_price,
    tp_price, sl_price, template_id, execution_tier || 'ai_driven', confidence,
    mode || 'paper', cycle_number, agent_decision_id, reasoning, bootstrap_phase,
    entry_confidence, kelly_optimal_pct, JSON.stringify(kelly_inputs),
    complexity_score, JSON.stringify(signal_domains), JSON.stringify(signal_timeframes)]);
}

async function closeTrade(id, { exit_price, pnl_realised, pnl_pct, outcome_class, outcome_reasoning, close_reason }) {
  return queryOne(`
    UPDATE trades SET
      exit_price = $2, pnl_realised = $3, pnl_pct = $4,
      outcome_class = $5, outcome_reasoning = $6,
      close_reason = COALESCE($7, close_reason),
      status = 'closed', closed_at = NOW()
    WHERE id = $1
    RETURNING *
  `, [id, exit_price, pnl_realised, pnl_pct, outcome_class, outcome_reasoning, close_reason || null]);
}

async function updateStops(id, { tp_price, sl_price }) {
  return queryOne(`
    UPDATE trades SET
      tp_price = COALESCE($2, tp_price),
      sl_price = COALESCE($3, sl_price)
    WHERE id = $1 AND status = 'open'
    RETURNING *
  `, [id, tp_price || null, sl_price || null]);
}

async function getOpenWithSignals() {
  return queryAll(`
    SELECT t.*,
           EXTRACT(EPOCH FROM (NOW() - t.opened_at)) / 3600 AS hours_held,
           json_agg(json_build_object(
             'signal_id', s.id,
             'signal_type', s.signal_type,
             'signal_category', s.signal_category,
             'direction', s.direction,
             'strength', s.strength,
             'expires_at', s.expires_at
           )) FILTER (WHERE s.id IS NOT NULL) AS entry_signals
    FROM trades t
    LEFT JOIN trade_signals ts ON ts.trade_id = t.id
    LEFT JOIN signals s ON s.id = ts.signal_id
    WHERE t.status = 'open'
    GROUP BY t.id
    ORDER BY t.opened_at DESC
  `);
}

async function getStats() {
  return queryOne(`
    SELECT
      COUNT(*) FILTER (WHERE status = 'closed') as total_closed,
      COUNT(*) FILTER (WHERE status = 'open') as total_open,
      COALESCE(SUM(pnl_realised) FILTER (WHERE status = 'closed'), 0) as total_pnl,
      ROUND(AVG(pnl_pct) FILTER (WHERE status = 'closed'), 2) as avg_return_pct,
      ROUND(100.0 * COUNT(*) FILTER (WHERE pnl_realised > 0) /
        NULLIF(COUNT(*) FILTER (WHERE status = 'closed'), 0), 1) as win_rate
    FROM trades
  `);
}

module.exports = { getAll, getById, getOpen, create, closeTrade, updateStops, getOpenWithSignals, getStats };
