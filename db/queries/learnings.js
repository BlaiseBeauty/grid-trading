const { queryAll, queryOne, query } = require('../connection');

async function getActive({ category, limit = 100 } = {}) {
  if (category) {
    return queryAll(`
      SELECT * FROM learnings
      WHERE invalidated_at IS NULL AND category = $1
      ORDER BY created_at DESC LIMIT $2
    `, [category, limit]);
  }
  return queryAll(`
    SELECT * FROM learnings
    WHERE invalidated_at IS NULL
    ORDER BY created_at DESC LIMIT $1
  `, [limit]);
}

async function getById(id) {
  return queryOne('SELECT * FROM learnings WHERE id = $1', [id]);
}

async function create(learning) {
  const { insight_text, category, confidence, symbols, asset_classes,
    supporting_trade_ids, source_agent, evidence,
    parent_learning_id, learning_type, scope_level,
    sample_size, influenced_trades, influenced_wins } = learning;

  return queryOne(`
    INSERT INTO learnings (
      insight_text, category, confidence, symbols, asset_classes,
      supporting_trade_ids, source_agent, evidence,
      parent_learning_id, learning_type, scope_level,
      sample_size, influenced_trades, influenced_wins
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
    RETURNING *
  `, [insight_text, category, confidence || 'med',
    JSON.stringify(symbols), JSON.stringify(asset_classes),
    supporting_trade_ids, source_agent, JSON.stringify(evidence),
    parent_learning_id, learning_type || 'observation', scope_level || 'specific',
    sample_size || 0, influenced_trades || 0, influenced_wins || 0]);
}

async function invalidate(id, invalidated_by) {
  return queryOne(`
    UPDATE learnings SET stage = 'invalidated', invalidated_by = $2, invalidated_at = NOW(), updated_at = NOW()
    WHERE id = $1 RETURNING *
  `, [id, invalidated_by]);
}

async function getForContext({ symbols, asset_classes, limit = 20 } = {}) {
  return queryAll(`
    SELECT * FROM learnings
    WHERE invalidated_at IS NULL
      AND confidence IN ('high', 'med')
      AND (symbols IS NULL OR symbols ?| $1 OR asset_classes ?| $2)
    ORDER BY
      CASE confidence WHEN 'high' THEN 1 WHEN 'med' THEN 2 ELSE 3 END,
      created_at DESC
    LIMIT $3
  `, [symbols || [], asset_classes || [], limit]);
}

module.exports = { getActive, getById, create, invalidate, getForContext };
