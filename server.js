// Express app: serves the static frontend from public/ and exposes the auth
// API under /api/*.

'use strict';

const path = require('path');
const crypto = require('crypto');
const express = require('express');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcrypt');

const config = require('./config');
const pool = require('./db');
const migrate = require('./db/migrate');

const app = express();
const SESSION_COOKIE = 'session';

// ---------- Middleware ----------
app.use(express.json());
app.use(cookieParser(config.cookieSecret));
app.use(express.static(config.publicDir));

// ---------- Helpers ----------

// RFC-5322 is huge; this is a deliberately permissive shape check. The DB has
// a UNIQUE constraint on the lowercased email, which is the real source of
// truth.
function isValidEmail(s) {
  if (typeof s !== 'string') return false;
  if (s.length > 254) return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}

// Cookie value is `${userId}.${epoch}` — both are non-negative integers
// separated by a single dot. Parse into parts, or null if the cookie is
// absent or malformed.
function parseSessionCookie(req) {
  const raw = req.signedCookies[SESSION_COOKIE];
  if (!raw || typeof raw !== 'string') return null;
  const idx = raw.indexOf('.');
  if (idx <= 0 || idx === raw.length - 1) return null;
  const userId = Number.parseInt(raw.slice(0, idx), 10);
  const epoch = Number.parseInt(raw.slice(idx + 1), 10);
  if (!Number.isInteger(userId) || userId <= 0) return null;
  if (!Number.isInteger(epoch) || epoch < 0) return null;
  return { userId, epoch };
}

function setSessionCookie(res, userId, epoch) {
  res.cookie(SESSION_COOKIE, `${userId}.${epoch}`, {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.nodeEnv === 'production',
    signed: true,
    path: '/',
    // Demo session — 7 days. Real apps should tie this to refresh/rotate.
    maxAge: 7 * 24 * 60 * 60 * 1000,
  });
}

function clearSessionCookie(res) {
  res.clearCookie(SESSION_COOKIE, { path: '/' });
}

// Loads the user row for a valid session cookie, and verifies the cookie's
// epoch matches the user's current session_epoch. On any failure, returns
// null and clears the cookie so a stale client is not stuck in a loop.
async function loadAuthUser(req, res) {
  const parsed = parseSessionCookie(req);
  if (!parsed) return null;
  try {
    const result = await pool.query(
      `SELECT id, email, password_hash, created_at, last_sign_in_at,
              is_admin, session_epoch, email_verified, email_verified_at
         FROM users
        WHERE id = $1`,
      [parsed.userId]
    );
    const row = result.rows[0];
    if (!row) {
      clearSessionCookie(res);
      return null;
    }
    if (row.session_epoch !== parsed.epoch) {
      // "Sign out everywhere" bumped the counter on a different device.
      clearSessionCookie(res);
      return null;
    }
    return row;
  } catch (err) {
    console.error('[loadAuthUser] error:', err.message);
    return null;
  }
}

function requireAuth(req, res, next) {
  loadAuthUser(req, res).then((user) => {
    if (!user) {
      return res.status(401).json({ error: 'Not signed in.' });
    }
    req.user = user;
    next();
  });
}

function requireAdmin(req, res, next) {
  if (!req.user || req.user.is_admin !== true) {
    return res.status(403).json({ error: 'Admin access required.' });
  }
  next();
}

// ---------- Security event logging ----------
//
// Audit logging must never break a user flow. All DB errors are swallowed
// (and logged) inside this helper so callers can `await` it without a try/
// catch and trust that the response is still the only thing that matters.
function recordSecurityEvent({ userId, type, req }) {
  const ip = (req && req.ip) || null;
  const userAgent = (req && req.headers && req.headers['user-agent']) || null;
  pool
    .query(
      `INSERT INTO security_events (user_id, type, ip, user_agent)
       VALUES ($1, $2, $3, $4)`,
      [userId == null ? null : userId, type, ip, userAgent]
    )
    .catch((err) => {
      console.error('[security_events] insert failed:', err.message);
    });
}

// ---------- Token helpers ----------
//
// Tokens are 32 random bytes (256 bits) hex-encoded. We only ever store
// SHA-256(token) so a database leak does not hand the attacker valid
// reset / verification links. Constant-time compare is unnecessary here:
// the token is the only credential, and the DB lookup on token_hash is
// already an indexed UNIQUE equality check.
function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

function hashToken(raw) {
  return crypto.createHash('sha256').update(String(raw)).digest('hex');
}

// ---------- Routes ----------

app.post('/api/register', async (req, res) => {
  const { email, password } = req.body || {};
  if (!isValidEmail(email)) {
    return res.status(400).json({ error: 'Please enter a valid email address.' });
  }
  if (typeof password !== 'string' || password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters.' });
  }

  const normalizedEmail = email.trim().toLowerCase();

  try {
    const hash = await bcrypt.hash(password, config.bcryptRounds);
    // Set last_sign_in_at on insert so /api/me and the dashboard reflect the
    // registration moment without a second round-trip.
    const result = await pool.query(
      `INSERT INTO users (email, password_hash, last_sign_in_at)
       VALUES ($1, $2, now())
       RETURNING id, email, is_admin, session_epoch`,
      [normalizedEmail, hash]
    );
    const user = result.rows[0];

    // Promote to admin if the email is on the allowlist. Cheap conditional so
    // a one-row update only runs when needed.
    if (config.adminEmails.has(user.email)) {
      await pool.query('UPDATE users SET is_admin = TRUE WHERE id = $1', [user.id]);
      user.is_admin = true;
    }

    setSessionCookie(res, user.id, user.session_epoch);
    recordSecurityEvent({ userId: user.id, type: 'register', req });

    // Issue an email-verification token so the dashboard banner has
    // something to "Resend" from. In dev we surface the link inline so
    // the demo flow works without SMTP; in prod we log it and the user
    // gets the link out of band.
    const verifyToken = generateToken();
    const verifyTokenHash = hashToken(verifyToken);
    const verifyLink = `/verify.html?token=${verifyToken}`;
    let verifyInserted = false;
    try {
      await pool.query(
        `INSERT INTO email_verification_tokens (user_id, token_hash, expires_at)
         VALUES ($1, $2, now() + interval '24 hours')`,
        [user.id, verifyTokenHash]
      );
      verifyInserted = true;
      if (config.nodeEnv === 'production') {
        console.log(`[email/verify] link for ${user.email}: ${verifyLink}`);
      }
    } catch (err) {
      // Non-fatal: registration succeeded; the dashboard can still issue a
      // "Resend verification email" if the user wants to.
      console.error('[register] verify token insert failed:', err.message);
    }

    const payload = { id: user.id, email: user.email, is_admin: user.is_admin };
    if (verifyInserted && config.nodeEnv !== 'production') {
      payload.verifyLink = verifyLink;
    }
    return res.status(200).json(payload);
  } catch (err) {
    if (err && err.code === '23505') {
      // unique_violation on email
      return res.status(409).json({ error: 'An account with that email already exists.' });
    }
    console.error('[register] error:', err.message);
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

app.post('/api/login', async (req, res) => {
  const { email, password } = req.body || {};
  if (!isValidEmail(email) || typeof password !== 'string') {
    return res.status(401).json({ error: 'Invalid email or password.' });
  }

  const normalizedEmail = email.trim().toLowerCase();

  try {
    const result = await pool.query(
      'SELECT id, email, password_hash, is_admin, session_epoch FROM users WHERE email = $1',
      [normalizedEmail]
    );
    // Always run bcrypt.compare against *something* so timing does not reveal
    // whether the email exists. If the row is missing, compare against a
    // pre-hashed dummy value.
    const row = result.rows[0];
    const hashToCompare = row
      ? row.password_hash
      : '$2b$10$abcdefghijklmnopqrstuuMTjUNNkf0Z4Y0X0X0X0X0X0X0X0X0X0X0';
    const ok = await bcrypt.compare(password, hashToCompare);

    if (!row || !ok) {
      // Log the failure against the user we *found* if any, so the audit
      // trail still tells us which email was attempted. A missing row →
      // user_id stays NULL.
      recordSecurityEvent({ userId: row ? row.id : null, type: 'login_failed', req });
      return res.status(401).json({ error: 'Invalid email or password.' });
    }

    // Stamp last_sign_in_at and, if applicable, promote to admin in one
    // round-trip. RETURNING gives us the current session_epoch for the
    // cookie payload without a follow-up SELECT.
    const update = await pool.query(
      `UPDATE users
         SET last_sign_in_at = now(),
             is_admin = CASE WHEN $2 THEN TRUE ELSE is_admin END
       WHERE id = $1
       RETURNING id, email, is_admin, session_epoch`,
      [row.id, config.adminEmails.has(row.email)]
    );
    const fresh = update.rows[0];

    setSessionCookie(res, fresh.id, fresh.session_epoch);
    recordSecurityEvent({ userId: fresh.id, type: 'login', req });
    return res.json({ id: fresh.id, email: fresh.email, is_admin: fresh.is_admin });
  } catch (err) {
    console.error('[login] error:', err.message);
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

app.post('/api/logout', async (req, res) => {
  // Resolve the user from the cookie *before* clearing it, so the audit
  // log can attribute the event. A stale/expired cookie just produces a
  // no-op logout with no audit row, which is fine.
  try {
    const user = await loadAuthUser(req, res);
    if (user) {
      recordSecurityEvent({ userId: user.id, type: 'logout', req });
    }
  } catch (err) {
    console.error('[logout] audit lookup failed:', err.message);
  }
  clearSessionCookie(res);
  res.status(204).end();
});

app.get('/api/me', requireAuth, (req, res) => {
  const {
    id, email, is_admin, created_at, last_sign_in_at,
    email_verified, email_verified_at,
  } = req.user;
  return res.json({
    id,
    email,
    is_admin,
    created_at: created_at.toISOString(),
    last_sign_in_at: last_sign_in_at ? last_sign_in_at.toISOString() : null,
    email_verified: email_verified === true,
    email_verified_at: email_verified_at ? email_verified_at.toISOString() : null,
  });
});

// Liveness check that also surfaces the resolved local-state directory. Cheap
// to hit and useful for confirming the published container sees `/data` after
// a publish — no auth, no DB call.
app.get('/api/healthz', (req, res) => {
  res.json({ ok: true, dataDir: config.dataDir });
});

// ---------- Account: change password ----------

app.post('/api/change-password', requireAuth, async (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (typeof currentPassword !== 'string' || typeof newPassword !== 'string') {
    return res.status(400).json({ error: 'Both current and new password are required.' });
  }
  if (newPassword.length < 8) {
    return res.status(400).json({ error: 'New password must be at least 8 characters.' });
  }

  try {
    const ok = await bcrypt.compare(currentPassword, req.user.password_hash);
    if (!ok) {
      return res.status(401).json({ error: 'Current password is incorrect.' });
    }
    const hash = await bcrypt.hash(newPassword, config.bcryptRounds);
    await pool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [hash, req.user.id]);
    recordSecurityEvent({ userId: req.user.id, type: 'change_password', req });
    return res.json({ ok: true });
  } catch (err) {
    console.error('[change-password] error:', err.message);
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// ---------- Account: sign out everywhere ----------

app.post('/api/sign-out-everywhere', requireAuth, async (req, res) => {
  try {
    await pool.query(
      'UPDATE users SET session_epoch = session_epoch + 1 WHERE id = $1',
      [req.user.id]
    );
    recordSecurityEvent({ userId: req.user.id, type: 'sign_out_everywhere', req });
    clearSessionCookie(res);
    return res.status(204).end();
  } catch (err) {
    console.error('[sign-out-everywhere] error:', err.message);
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// ---------- Password reset: request ----------
//
// Always returns 200 with the same body shape so the caller cannot use the
// response to enumerate which emails are registered. If the email is
// known, we mint a 1-hour token and either surface the link (dev) or log
// it (prod). The dummy bcrypt compare on the missing-user path mirrors
// `/api/login` so timing doesn't reveal the account list.
app.post('/api/password/reset/request', async (req, res) => {
  const { email } = req.body || {};
  if (!isValidEmail(email)) {
    // Don't disclose that the email shape was wrong — same response either
    // way, just like login.
    return res.json({ ok: true });
  }
  const normalizedEmail = email.trim().toLowerCase();

  try {
    const result = await pool.query(
      'SELECT id, password_hash FROM users WHERE email = $1',
      [normalizedEmail]
    );
    const row = result.rows[0];
    const dummyHash = '$2b$10$abcdefghijklmnopqrstuuMTjUNNkf0Z4Y0X0X0X0X0X0X0X0X0X0X0';

    if (!row) {
      // Burn the same amount of bcrypt work as the happy path.
      await bcrypt.compare(normalizedEmail, dummyHash);
      recordSecurityEvent({ userId: null, type: 'password_reset_request', req });
      return res.json({ ok: true });
    }

    // Match the cost factor the dummy uses so timing is comparable.
    await bcrypt.compare(normalizedEmail, row.password_hash || dummyHash);

    const token = generateToken();
    const tokenHash = hashToken(token);
    await pool.query(
      `INSERT INTO password_reset_tokens (user_id, token_hash, expires_at)
       VALUES ($1, $2, now() + interval '1 hour')`,
      [row.id, tokenHash]
    );
    recordSecurityEvent({ userId: row.id, type: 'password_reset_request', req });

    const link = `/reset.html?token=${token}`;
    if (config.nodeEnv === 'production') {
      console.log(`[password/reset] link for ${normalizedEmail}: ${link}`);
      return res.json({ ok: true });
    }
    return res.json({ ok: true, link });
  } catch (err) {
    console.error('[password/reset/request] error:', err.message);
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// ---------- Password reset: confirm ----------
//
// Single use is enforced by DELETE-ing the token row in the same query that
// reads it. The new password also bumps session_epoch, so any active cookie
// the user had is invalidated — they have to sign in with the new one.
app.post('/api/password/reset/confirm', async (req, res) => {
  const { token, newPassword } = req.body || {};
  if (typeof token !== 'string' || token.length < 16) {
    return res.status(400).json({ error: 'Invalid or expired link.' });
  }
  if (typeof newPassword !== 'string' || newPassword.length < 8) {
    return res.status(400).json({ error: 'New password must be at least 8 characters.' });
  }

  const tokenHash = hashToken(token);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Find + atomically delete a still-valid token row. If `rowCount` is 0
    // the token was unknown, expired, or already consumed.
    const del = await client.query(
      `DELETE FROM password_reset_tokens
        WHERE token_hash = $1
          AND expires_at > now()
       RETURNING user_id`,
      [tokenHash]
    );
    if (del.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'This reset link is invalid or has expired.' });
    }
    const userId = del.rows[0].user_id;

    const hash = await bcrypt.hash(newPassword, config.bcryptRounds);
    // Bump session_epoch so any cookie the user has for this account dies.
    const upd = await client.query(
      `UPDATE users
          SET password_hash = $1,
              session_epoch = session_epoch + 1
        WHERE id = $2
        RETURNING id`,
      [hash, userId]
    );
    if (upd.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'This reset link is invalid or has expired.' });
    }
    await client.query('COMMIT');
    recordSecurityEvent({ userId, type: 'password_reset_confirm', req });
    clearSessionCookie(res);
    return res.json({ ok: true });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[password/reset/confirm] error:', err.message);
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  } finally {
    client.release();
  }
});

// ---------- Email verification: request ----------
//
// Auth required so we can attribute the event and rate-limit per user.
// The check is "any verification token created in the last 60s for this
// user?" — cheap, no extra table needed.
app.post('/api/email/verify/request', requireAuth, async (req, res) => {
  try {
    const recent = await pool.query(
      `SELECT 1
         FROM email_verification_tokens
        WHERE user_id = $1
          AND created_at > now() - interval '60 seconds'
        LIMIT 1`,
      [req.user.id]
    );
    if (recent.rowCount > 0) {
      return res.status(429).json({ error: 'Please wait a minute before requesting another link.' });
    }

    const token = generateToken();
    const tokenHash = hashToken(token);
    await pool.query(
      `INSERT INTO email_verification_tokens (user_id, token_hash, expires_at)
       VALUES ($1, $2, now() + interval '24 hours')`,
      [req.user.id, tokenHash]
    );
    recordSecurityEvent({ userId: req.user.id, type: 'email_verify_request', req });

    const link = `/verify.html?token=${token}`;
    if (config.nodeEnv === 'production') {
      console.log(`[email/verify] link for ${req.user.email}: ${link}`);
      return res.json({ ok: true });
    }
    return res.json({ ok: true, link });
  } catch (err) {
    console.error('[email/verify/request] error:', err.message);
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// ---------- Email verification: confirm ----------
//
// Mark the token `used_at` rather than DELETE-ing it so we can show a
// "this link was already used" message instead of a 500 on a duplicate
// click. Validates `expires_at > now()` and `used_at IS NULL` in the
// same query to avoid TOCTOU.
app.post('/api/email/verify/confirm', async (req, res) => {
  const { token } = req.body || {};
  if (typeof token !== 'string' || token.length < 16) {
    return res.status(400).json({ error: 'Invalid verification link.' });
  }
  const tokenHash = hashToken(token);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const upd = await client.query(
      `UPDATE email_verification_tokens
          SET used_at = now()
        WHERE token_hash = $1
          AND used_at IS NULL
          AND expires_at > now()
       RETURNING user_id`,
      [tokenHash]
    );
    if (upd.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'This verification link is invalid or has expired.' });
    }
    const userId = upd.rows[0].user_id;
    await client.query(
      `UPDATE users
          SET email_verified = TRUE,
              email_verified_at = now()
        WHERE id = $1`,
      [userId]
    );
    await client.query('COMMIT');
    recordSecurityEvent({ userId, type: 'email_verify_confirm', req });
    return res.json({ ok: true });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[email/verify/confirm] error:', err.message);
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  } finally {
    client.release();
  }
});

// ---------- Security events feed ----------
//
// Last 50 events for the caller, newest first. `user_id` is filtered to
// the caller so users only ever see their own events; `login_failed`
// rows from unknown-email attempts (user_id IS NULL) are excluded.
app.get('/api/security/events', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, type, ip, user_agent, created_at
         FROM security_events
        WHERE user_id = $1
        ORDER BY created_at DESC
        LIMIT 50`,
      [req.user.id]
    );
    return res.json({
      events: result.rows.map((r) => ({
        id: r.id,
        type: r.type,
        ip: r.ip,
        user_agent: r.user_agent,
        created_at: r.created_at.toISOString(),
      })),
    });
  } catch (err) {
    console.error('[security/events] error:', err.message);
    return res.status(500).json({ error: 'Something went wrong.' });
  }
});

// ---------- Notes CRUD ----------

function validateNoteBody(body) {
  if (typeof body !== 'string') {
    return { error: 'Note body is required.' };
  }
  const trimmed = body.trim();
  if (trimmed.length < 1) {
    return { error: 'Note cannot be empty.' };
  }
  if (trimmed.length > 5000) {
    return { error: 'Note is too long (max 5000 characters).' };
  }
  return { value: trimmed };
}

app.get('/api/notes', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, body, created_at, updated_at
         FROM notes
        WHERE user_id = $1
        ORDER BY created_at DESC`,
      [req.user.id]
    );
    return res.json({
      notes: result.rows.map((r) => ({
        id: r.id,
        body: r.body,
        created_at: r.created_at.toISOString(),
        updated_at: r.updated_at.toISOString(),
      })),
    });
  } catch (err) {
    console.error('[notes GET] error:', err.message);
    return res.status(500).json({ error: 'Something went wrong.' });
  }
});

app.post('/api/notes', requireAuth, async (req, res) => {
  const v = validateNoteBody(req.body && req.body.body);
  if (v.error) {
    return res.status(400).json({ error: v.error });
  }
  try {
    const result = await pool.query(
      `INSERT INTO notes (user_id, body) VALUES ($1, $2)
       RETURNING id, body, created_at, updated_at`,
      [req.user.id, v.value]
    );
    const r = result.rows[0];
    return res.status(200).json({
      id: r.id,
      body: r.body,
      created_at: r.created_at.toISOString(),
      updated_at: r.updated_at.toISOString(),
    });
  } catch (err) {
    console.error('[notes POST] error:', err.message);
    return res.status(500).json({ error: 'Something went wrong.' });
  }
});

app.patch('/api/notes/:id', requireAuth, async (req, res) => {
  const id = Number.parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: 'Invalid note id.' });
  }
  const v = validateNoteBody(req.body && req.body.body);
  if (v.error) {
    return res.status(400).json({ error: v.error });
  }
  try {
    const result = await pool.query(
      `UPDATE notes
          SET body = $1, updated_at = now()
        WHERE id = $2 AND user_id = $3
        RETURNING id, body, created_at, updated_at`,
      [v.value, id, req.user.id]
    );
    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Note not found.' });
    }
    const r = result.rows[0];
    return res.json({
      id: r.id,
      body: r.body,
      created_at: r.created_at.toISOString(),
      updated_at: r.updated_at.toISOString(),
    });
  } catch (err) {
    console.error('[notes PATCH] error:', err.message);
    return res.status(500).json({ error: 'Something went wrong.' });
  }
});

app.delete('/api/notes/:id', requireAuth, async (req, res) => {
  const id = Number.parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: 'Invalid note id.' });
  }
  try {
    const result = await pool.query(
      'DELETE FROM notes WHERE id = $1 AND user_id = $2',
      [id, req.user.id]
    );
    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Note not found.' });
    }
    return res.status(204).end();
  } catch (err) {
    console.error('[notes DELETE] error:', err.message);
    return res.status(500).json({ error: 'Something went wrong.' });
  }
});

// ---------- Admin: stats ----------

app.get('/api/admin/stats', requireAuth, requireAdmin, async (req, res) => {
  try {
    const totals = await pool.query(
      `SELECT
         (SELECT COUNT(*)::int FROM users) AS total_users,
         (SELECT COUNT(*)::int FROM notes) AS total_notes`
    );

    // 14-day series with generate_series so days with zero events are present.
    // The 13-day window ends today (inclusive), giving 14 rows.
    const signups = await pool.query(
      `WITH days AS (
         SELECT generate_series(
           (now() - interval '13 days')::date,
           now()::date,
           interval '1 day'
         )::date AS day
       )
       SELECT days.day,
              coalesce(sum(case when u.created_at::date = days.day then 1 end), 0)::int AS count
         FROM days
         LEFT JOIN users u ON u.created_at::date = days.day
        GROUP BY days.day
        ORDER BY days.day`
    );

    const notesSeries = await pool.query(
      `WITH days AS (
         SELECT generate_series(
           (now() - interval '13 days')::date,
           now()::date,
           interval '1 day'
         )::date AS day
       )
       SELECT days.day,
              coalesce(sum(case when n.created_at::date = days.day then 1 end), 0)::int AS count
         FROM days
         LEFT JOIN notes n ON n.created_at::date = days.day
        GROUP BY days.day
        ORDER BY days.day`
    );

    const toDay = (row) => {
      // pg returns DATE columns as JS Date objects at local midnight. Format
      // as YYYY-MM-DD without timezone drift.
      const d = row.day;
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, '0');
      const day = String(d.getDate()).padStart(2, '0');
      return { date: `${y}-${m}-${day}`, count: row.count };
    };

    return res.json({
      totalUsers: totals.rows[0].total_users,
      totalNotes: totals.rows[0].total_notes,
      signupsByDay: signups.rows.map(toDay),
      notesByDay: notesSeries.rows.map(toDay),
    });
  } catch (err) {
    console.error('[admin stats] error:', err.message);
    return res.status(500).json({ error: 'Something went wrong.' });
  }
});

// ---------- Boot ----------
migrate()
  .then(() => {
    app.listen(config.port, () => {
      console.log(`[server] listening on http://localhost:${config.port} (${config.nodeEnv})`);
    });
  })
  .catch((err) => {
    console.error('[migrate] startup failed:', err.message);
    process.exit(1);
  });
