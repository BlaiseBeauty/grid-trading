require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { pool } = require('./connection');

// Arbitrary constant key for the migration advisory lock (same on every replica).
const MIGRATION_LOCK_KEY = 727001;

async function migrate() {
  console.log('[MIGRATE] Starting database migration...');

  // One dedicated client for the whole run: the advisory lock is session-level
  // and BEGIN/COMMIT/ROLLBACK must all hit the same connection.
  const client = await pool.connect();
  let locked = false;
  try {
    // Serialise migrations across replicas — a second instance waits here, then
    // sees everything already applied and exits quickly.
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
    locked = true;

    // Create migrations tracking table
    await client.query(`
      CREATE TABLE IF NOT EXISTS _migrations (
        id SERIAL PRIMARY KEY,
        filename VARCHAR(255) NOT NULL UNIQUE,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    // Get already-applied migrations (read AFTER taking the lock)
    const applied = await client.query('SELECT filename FROM _migrations ORDER BY id');
    const appliedSet = new Set(applied.rows.map(r => r.filename));

    // Read migration files. Ordering is by FULL filename (plain string sort), so
    // two files sharing a numeric prefix (e.g. the two 025_*) run alphabetically
    // and each is tracked by its full name. Never rename an applied file.
    const migrationsDir = path.join(__dirname, 'migrations');
    const files = fs.readdirSync(migrationsDir)
      .filter(f => f.endsWith('.sql'))
      .sort();

    const prefixes = new Map();
    for (const f of files) {
      const prefix = f.split('_')[0];
      prefixes.set(prefix, [...(prefixes.get(prefix) || []), f]);
    }
    for (const [prefix, group] of prefixes) {
      if (group.length > 1) {
        console.warn(`[MIGRATE] NOTE: duplicate prefix ${prefix} (${group.join(', ')}) — applied in filename order`);
      }
    }

    let count = 0;
    for (const file of files) {
      if (appliedSet.has(file)) {
        console.log(`[MIGRATE] Already applied: ${file}`);
        continue;
      }

      const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
      console.log(`[MIGRATE] Applying: ${file}`);

      // Wrap each migration in a transaction (unless it already manages its own)
      const hasTransaction = /^\s*BEGIN\b/im.test(sql);
      try {
        if (!hasTransaction) {
          await client.query('BEGIN');
        }
        await client.query(sql);
        await client.query('INSERT INTO _migrations (filename) VALUES ($1)', [file]);
        if (!hasTransaction) {
          await client.query('COMMIT');
        }
        count++;
        console.log(`[MIGRATE] Applied: ${file}`);
      } catch (err) {
        try {
          await client.query('ROLLBACK');
        } catch (rollbackErr) {
          console.error('[MIGRATE] ROLLBACK failed:', rollbackErr.message);
        }
        console.error(`[MIGRATE] Failed on ${file}:`, err.message);
        process.exit(1);
      }
    }

    console.log(`[MIGRATE] Done. Applied ${count} new migration(s).`);
  } finally {
    if (locked) {
      try {
        await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]);
      } catch (unlockErr) {
        console.error('[MIGRATE] Advisory unlock failed:', unlockErr.message);
      }
    }
    client.release();
  }
}

// Run if called directly
if (require.main === module) {
  migrate()
    .then(() => pool.end())
    .catch(err => {
      console.error('[MIGRATE] Fatal:', err.message);
      process.exit(1);
    });
}

module.exports = { migrate };
