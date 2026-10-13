-- Schema for the auth demo. The CREATE TABLE / ALTER TABLE statements are
-- idempotent, so the migration script can run on every startup without a
-- separate "is this already applied?" check.

CREATE TABLE IF NOT EXISTS users (
  id            SERIAL PRIMARY KEY,
  email         TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Columns added in later iterations. Additive + IF NOT EXISTS so re-running
-- the migration is a no-op on a fully-migrated DB.
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_sign_in_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_admin BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS session_epoch INTEGER NOT NULL DEFAULT 0;

-- Helpful index when the table grows. Unique on email is enforced by the
-- column constraint above, so this is implicit, but a CREATE INDEX IF NOT
-- EXISTS documents intent for future non-unique lookups (e.g. login throttling).
CREATE INDEX IF NOT EXISTS users_created_at_idx ON users (created_at);

-- Personal notes — one row per note, scoped to a user, capped at 5000 chars.
CREATE TABLE IF NOT EXISTS notes (
  id         SERIAL PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body       TEXT NOT NULL CHECK (char_length(body) BETWEEN 1 AND 5000),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Dashboard query: "list this user's notes, newest first." The composite
-- index lets the planner serve both the WHERE and the ORDER BY from one scan.
CREATE INDEX IF NOT EXISTS notes_user_id_created_at_idx ON notes (user_id, created_at DESC);
