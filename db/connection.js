const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 20,
  idleTimeoutMillis: 60000,
  connectionTimeoutMillis: 10000,
});

pool.on('error', (err) => {
  console.error('[DB] Unexpected pool error:', err.message);
});

// Periodic pool health check — log if connections are being exhausted
setInterval(() => {
  const { totalCount, idleCount, waitingCount } = pool;
  if (waitingCount > 0) {
    console.warn(`[DB] Pool pressure: ${totalCount} total, ${idleCount} idle, ${waitingCount} waiting`);
  }
}, 30000).unref();

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
    try {
      await client.query('ROLLBACK');
    } catch (rollbackErr) {
      console.error('[DB] ROLLBACK failed:', rollbackErr.message);
    }
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Run fn() only if this process wins a Postgres session-level advisory lock
 * named `name`. A second replica trying the same name skips instead of
 * double-running. The lock is held on a dedicated pooled client for the whole
 * run and released in finally (it is also dropped automatically if the
 * connection dies). fn receives no client — it uses the normal helpers.
 *
 * Returns { ran: true, result } or { ran: false } when another holder has it.
 * If the lock query itself fails the run is SKIPPED (fail closed), never
 * run unlocked.
 */
async function withAdvisoryLock(name, fn) {
  let client;
  try {
    client = await pool.connect();
  } catch (err) {
    console.error(`[LOCK] ${name}: could not get a DB client — skipping:`, err.message);
    return { ran: false, error: err };
  }
  let locked = false;
  try {
    const { rows } = await client.query('SELECT pg_try_advisory_lock(hashtext($1)) AS ok', [name]);
    locked = !!rows[0]?.ok;
    if (!locked) {
      console.log(`[LOCK] ${name}: held by another instance — skipping`);
      return { ran: false };
    }
    const result = await fn();
    return { ran: true, result };
  } catch (err) {
    if (!locked) {
      console.error(`[LOCK] ${name}: lock attempt failed — skipping:`, err.message);
      return { ran: false, error: err };
    }
    throw err;
  } finally {
    if (locked) {
      try {
        await client.query('SELECT pg_advisory_unlock(hashtext($1))', [name]);
      } catch (unlockErr) {
        console.error(`[LOCK] ${name}: unlock failed:`, unlockErr.message);
      }
    }
    client.release();
  }
}

module.exports = { pool, query, queryOne, queryAll, transaction, withAdvisoryLock };
