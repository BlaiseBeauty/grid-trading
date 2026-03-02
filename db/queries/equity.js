const { query } = require('../connection');

async function insert({ cycleNumber, totalValue, realisedPnl, unrealisedPnl, openPositions }) {
  return query(`
    INSERT INTO equity_snapshots (cycle_number, total_value, realised_pnl, unrealised_pnl, open_positions)
    VALUES ($1, $2, $3, $4, $5)
  `, [cycleNumber, totalValue, realisedPnl, unrealisedPnl, openPositions]);
}

module.exports = { insert };
