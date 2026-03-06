const { query, queryAll } = require('../connection');

async function save(cycleId, report) {
  return query(
    'INSERT INTO cycle_reports (cycle_id, report) VALUES ($1, $2)',
    [cycleId, JSON.stringify(report)]
  );
}

async function getRecent(limit = 10) {
  return queryAll(
    'SELECT id, cycle_id, report, created_at FROM cycle_reports ORDER BY created_at DESC LIMIT $1',
    [limit]
  );
}

module.exports = { save, getRecent };
