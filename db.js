// Singleton pg Pool. Imported by the migration script and the auth routes so
// the whole app shares one connection pool.

'use strict';

const { Pool } = require('pg');
const config = require('./config');

const pool = new Pool({
  connectionString: config.databaseUrl,
  // Keep the pool small — this app is a demo. Real apps should tune this.
  max: 10,
  idleTimeoutMillis: 30_000,
});

pool.on('error', (err) => {
  // A backend error after the client has connected (e.g. the server killed
  // an idle connection). Log it; the next query will reconnect.
  console.error('[pg] idle client error:', err.message);
});

module.exports = pool;