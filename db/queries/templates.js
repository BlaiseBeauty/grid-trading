const { queryAll, queryOne, query } = require('../connection');

async function getAll({ status } = {}) {
  if (status) {
    return queryAll('SELECT * FROM strategy_templates WHERE status = $1 ORDER BY updated_at DESC', [status]);
  }
  return queryAll('SELECT * FROM strategy_templates ORDER BY updated_at DESC');
}

async function getById(id) {
  return queryOne('SELECT * FROM strategy_templates WHERE id = $1', [id]);
}

async function getActive() {
  return queryAll("SELECT * FROM strategy_templates WHERE status = 'active' ORDER BY trade_count DESC");
}

async function create(template) {
  const { name, description, entry_conditions, exit_conditions,
    valid_regimes, valid_asset_classes, valid_symbols, source } = template;

  return queryOne(`
    INSERT INTO strategy_templates (
      name, description, entry_conditions, exit_conditions,
      valid_regimes, valid_asset_classes, valid_symbols, source
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
    RETURNING *
  `, [name, description, JSON.stringify(entry_conditions), JSON.stringify(exit_conditions),
    JSON.stringify(valid_regimes), JSON.stringify(valid_asset_classes),
    JSON.stringify(valid_symbols), source || 'pattern_discovery']);
}

async function updateStatus(id, status) {
  const extra = status === 'active' ? ', promoted_at = NOW()' :
    status === 'retired' ? ', retired_at = NOW()' : '';
  return queryOne(
    `UPDATE strategy_templates SET status = $2, updated_at = NOW() ${extra} WHERE id = $1 RETURNING *`,
    [id, status]
  );
}

async function incrementTradeCount(id) {
  return query('UPDATE strategy_templates SET trade_count = trade_count + 1, updated_at = NOW() WHERE id = $1', [id]);
}

module.exports = { getAll, getById, getActive, create, updateStatus, incrementTradeCount };
