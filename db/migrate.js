require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { pool, query } = require('./connection');

async function migrate() {
  console.log('[MIGRATE] Starting database migration...');

  // Create migrations tracking table
  await query(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id SERIAL PRIMARY KEY,
      filename VARCHAR(255) NOT NULL UNIQUE,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  // Get already-applied migrations
  const applied = await query('SELECT filename FROM _migrations ORDER BY id');
  const appliedSet = new Set(applied.rows.map(r => r.filename));

  // Read migration files
  const migrationsDir = path.join(__dirname, 'migrations');
  const files = fs.readdirSync(migrationsDir)
    .filter(f => f.endsWith('.sql'))
    .sort();

  let count = 0;
  for (const file of files) {
    if (appliedSet.has(file)) {
      console.log(`[MIGRATE] Already applied: ${file}`);
      continue;
    }

    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
    console.log(`[MIGRATE] Applying: ${file}`);

    try {
      await query(sql);
      await query('INSERT INTO _migrations (filename) VALUES ($1)', [file]);
      count++;
      console.log(`[MIGRATE] Applied: ${file}`);
    } catch (err) {
      console.error(`[MIGRATE] Failed on ${file}:`, err.message);
      process.exit(1);
    }
  }

  console.log(`[MIGRATE] Done. Applied ${count} new migration(s).`);
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
