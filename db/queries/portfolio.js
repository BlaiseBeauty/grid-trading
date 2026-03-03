const { queryAll, queryOne, query } = require('../connection');

async function getAll() {
  return queryAll(`
    SELECT *,
      ROUND(quantity * current_price, 2) as market_value
    FROM portfolio_state
    ORDER BY allocation_pct DESC NULLS LAST
  `);
}

async function getBySymbol(symbol) {
  return queryOne('SELECT * FROM portfolio_state WHERE symbol = $1', [symbol]);
}

async function upsert({ symbol, asset_class, exchange, quantity, avg_entry_price, current_price }) {
  return queryOne(`
    INSERT INTO portfolio_state (symbol, asset_class, exchange, quantity, avg_entry_price, current_price)
    VALUES ($1, $2, $3, $4, $5, $6)
    ON CONFLICT (symbol, exchange) DO UPDATE SET
      quantity = EXCLUDED.quantity,
      avg_entry_price = EXCLUDED.avg_entry_price,
      current_price = EXCLUDED.current_price,
      updated_at = NOW()
    RETURNING *
  `, [symbol, asset_class, exchange, quantity, avg_entry_price, current_price]);
}

async function updatePrice(symbol, current_price) {
  return query(`
    UPDATE portfolio_state
    SET current_price = $2,
        unrealised_pnl = quantity * ($2 - avg_entry_price),
        unrealised_pnl_pct = CASE WHEN avg_entry_price > 0
          THEN (($2 - avg_entry_price) / avg_entry_price) * 100
          ELSE 0 END,
        updated_at = NOW()
    WHERE symbol = $1
  `, [symbol, current_price]);
}

async function removePosition(symbol, exchange) {
  return query('DELETE FROM portfolio_state WHERE symbol = $1 AND exchange = $2', [symbol, exchange]);
}

async function getTotalValue() {
  return queryOne(`
    SELECT COALESCE(SUM(quantity * current_price), 0) as total_value,
           COALESCE(SUM(unrealised_pnl), 0) as total_unrealised_pnl
    FROM portfolio_state
  `);
}

async function getPortfolioValue() {
  const startingCapital = parseFloat(process.env.STARTING_CAPITAL || '10000');
  const pnl = await queryOne(`
    SELECT COALESCE(SUM(pnl_realised), 0) as total_realised
    FROM trades WHERE status = 'closed'
  `);
  const positions = await queryOne(`
    SELECT COALESCE(SUM(unrealised_pnl), 0) as total_unrealised,
           MAX(updated_at) as last_price_update
    FROM portfolio_state
  `);
  const realised = parseFloat(pnl?.total_realised || 0);
  const unrealised = parseFloat(positions?.total_unrealised || 0);
  const lastUpdate = positions?.last_price_update;
  const priceStale = lastUpdate && (Date.now() - new Date(lastUpdate).getTime()) > 10 * 60 * 1000;
  return {
    starting_capital: startingCapital,
    realised_pnl: realised,
    unrealised_pnl: unrealised,
    total_value: startingCapital + realised + unrealised,
    price_stale: !!priceStale,
  };
}

module.exports = { getAll, getBySymbol, upsert, updatePrice, removePosition, getTotalValue, getPortfolioValue };
