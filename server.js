// Express app: serves the static frontend from public/ and exposes the auth
// API under /api/*.

'use strict';

const path = require('path');
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
      'SELECT id, email, password_hash, created_at, last_sign_in_at, is_admin, session_epoch FROM users WHERE id = $1',
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
    return res.status(200).json({ id: user.id, email: user.email, is_admin: user.is_admin });
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
    return res.json({ id: fresh.id, email: fresh.email, is_admin: fresh.is_admin });
  } catch (err) {
    console.error('[login] error:', err.message);
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

app.post('/api/logout', (req, res) => {
  clearSessionCookie(res);
  res.status(204).end();
});

app.get('/api/me', requireAuth, (req, res) => {
  const { id, email, is_admin, created_at, last_sign_in_at } = req.user;
  return res.json({
    id,
    email,
    is_admin,
    created_at: created_at.toISOString(),
    last_sign_in_at: last_sign_in_at ? last_sign_in_at.toISOString() : null,
  });
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
    clearSessionCookie(res);
    return res.status(204).end();
  } catch (err) {
    console.error('[sign-out-everywhere] error:', err.message);
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
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
