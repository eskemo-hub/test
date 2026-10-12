-- Schema for the auth demo. The CREATE TABLE is idempotent, so the migration
-- script can run on every startup without a separate "is this already
-- applied?" check.

CREATE TABLE IF NOT EXISTS users (
  id            SERIAL PRIMARY KEY,
  email         TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Helpful index when the table grows. Unique on email is enforced by the
-- column constraint above, so this is implicit, but a CREATE INDEX IF NOT
-- EXISTS documents intent for future non-unique lookups (e.g. login throttling).
CREATE INDEX IF NOT EXISTS users_created_at_idx ON users (created_at);