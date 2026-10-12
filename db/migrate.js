// Runs db/schema.sql against the shared pool. Called once on server startup;
// CREATE TABLE IF NOT EXISTS makes this safe to run every boot.

'use strict';

const fs = require('fs');
const path = require('path');
const pool = require('../db');

async function migrate() {
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  await pool.query(sql);
}

module.exports = migrate;

if (require.main === module) {
  // Allow running the migration on its own: `node db/migrate.js`.
  migrate()
    .then(() => {
      console.log('[migrate] schema applied');
      return pool.end();
    })
    .catch((err) => {
      console.error('[migrate] failed:', err.message);
      process.exitCode = 1;
      pool.end();
    });
}