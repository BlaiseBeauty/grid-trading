const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

pool.on('error', (err) => {
  console.error('[DB] Unexpected pool error:', err.message);
});

// Log queries taking >500ms
const { wrapPoolQuery } = require('./query-logger');
wrapPoolQuery(pool);

// Query helper
async function query(text, params) {
  const result = await pool.query(text, params);
  return result;
}

// Get single row
async function queryOne(text, params) {
  const result = await pool.query(text, params);
  return result.rows[0] || null;
}

// Get all rows
async function queryAll(text, params) {
  const result = await pool.query(text, params);
  return result.rows;
}

// Transaction helper
async function transaction(callback) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { pool, query, queryOne, queryAll, transaction };
