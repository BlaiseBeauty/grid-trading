const { queryOne } = require('../connection');

async function getLatestClose(symbol) {
  return queryOne(
    `SELECT close FROM market_data WHERE symbol = $1 ORDER BY timestamp DESC LIMIT 1`,
    [symbol]
  );
}

module.exports = { getLatestClose };
