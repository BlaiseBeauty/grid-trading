const { query } = require('../connection');

async function cleanExpired() {
  return query(
    `DELETE FROM external_data_cache WHERE source = 'indicators' AND fetched_at < NOW() - INTERVAL '1 second' * ttl_seconds`
  );
}

async function upsertDomain(domain, symbol, data) {
  return query(`
    INSERT INTO external_data_cache (source, metric, symbol, data, ttl_seconds)
    VALUES ('indicators', $1, $2, $3, 14400)
    ON CONFLICT (source, metric, COALESCE(symbol, ''))
    DO UPDATE SET data = EXCLUDED.data, fetched_at = NOW()
  `, [domain, symbol, JSON.stringify(data)]);
}

module.exports = { cleanExpired, upsertDomain };
