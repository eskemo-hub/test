// Centralised config. Reads from env where set, falls back to the dev workspace
// values so the app boots without an .env in this dev container. In production,
// set DATABASE_URL and COOKIE_SECRET in the environment — do not rely on the
// fallback DATABASE_URL.

'use strict';

const path = require('path');

// Hardcoded dev fallback so this repo boots in the dev workspace without an
// .env file. Replace by setting DATABASE_URL in the environment for prod.
const DEV_DATABASE_URL =
  'postgresql://test_auth_db_7cdb30:91693779e326f631ae24f4293b33643891bd23301bf5dd37@db-p-45035r-test-auth-db:5432/test_auth_db_5324';

// Cookie signing secret. Always override in production.
const DEV_COOKIE_SECRET = 'dev-only-not-secret-change-me';

const config = {
  port: Number(process.env.PORT) || 3000,
  nodeEnv: process.env.NODE_ENV || 'development',
  databaseUrl: process.env.DATABASE_URL || DEV_DATABASE_URL,
  cookieSecret: process.env.COOKIE_SECRET || DEV_COOKIE_SECRET,
  // bcrypt cost factor for password hashing. 10 keeps latency low while still
  // requiring measurable work; bump if a security review asks for it.
  bcryptRounds: 10,
  publicDir: path.join(__dirname, 'public'),
};

module.exports = config;