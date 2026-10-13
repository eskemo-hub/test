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
-- Email verification. New accounts default to unverified; the dashboard
-- surfaces a "verify your email" banner and an `/api/email/verify/confirm`
-- round-trip flips this to TRUE.
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified_at TIMESTAMPTZ;

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

-- ---------- Password reset ----------
-- One row per active reset request. The raw token only ever lives in the link
-- emailed to the user; we store SHA-256(token) and look up by it. Single use
-- is enforced by DELETE on consume, so there's no `used_at` column to forget
-- to set.
CREATE TABLE IF NOT EXISTS password_reset_tokens (
  id         SERIAL PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS password_reset_tokens_user_id_idx
  ON password_reset_tokens (user_id);

-- ---------- Email verification ----------
-- Same shape, plus a `used_at` so re-clicking a stale link is a clean
-- "already consumed" rather than a duplicate-key error.
CREATE TABLE IF NOT EXISTS email_verification_tokens (
  id         SERIAL PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at    TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS email_verification_tokens_user_id_idx
  ON email_verification_tokens (user_id);

-- ---------- Security / audit log ----------
-- `user_id` is nullable on purpose: a `login_failed` for an unknown email has
-- no user row to point at. `type` is a free TEXT rather than an enum so
-- adding a new event type later is just an INSERT — no ALTER TABLE.
CREATE TABLE IF NOT EXISTS security_events (
  id         SERIAL PRIMARY KEY,
  user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  type       TEXT NOT NULL,
  ip         TEXT,
  user_agent TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Dashboard query: "last 50 events for this user, newest first." The composite
-- index covers both the filter and the sort.
CREATE INDEX IF NOT EXISTS security_events_user_id_created_at_idx
  ON security_events (user_id, created_at DESC);
