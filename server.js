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

// Reads the signed session cookie and returns the user id, or null if absent
// or tampered. The cookie value is the user id as a signed string, so any
// parse failure means the cookie is not trustworthy.
function getSessionUserId(req) {
  const raw = req.signedCookies[SESSION_COOKIE];
  if (!raw) return null;
  const id = Number.parseInt(raw, 10);
  if (!Number.isInteger(id) || id <= 0) return null;
  return id;
}

function setSessionCookie(res, userId) {
  res.cookie(SESSION_COOKIE, String(userId), {
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
    const result = await pool.query(
      'INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id, email',
      [normalizedEmail, hash]
    );
    const user = result.rows[0];
    setSessionCookie(res, user.id);
    return res.status(200).json({ id: user.id, email: user.email });
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
      'SELECT id, email, password_hash FROM users WHERE email = $1',
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

    setSessionCookie(res, row.id);
    return res.json({ id: row.id, email: row.email });
  } catch (err) {
    console.error('[login] error:', err.message);
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

app.post('/api/logout', (req, res) => {
  clearSessionCookie(res);
  res.status(204).end();
});

app.get('/api/me', async (req, res) => {
  const userId = getSessionUserId(req);
  if (!userId) {
    return res.status(401).json({ error: 'Not signed in.' });
  }
  try {
    const result = await pool.query('SELECT id, email FROM users WHERE id = $1', [userId]);
    const row = result.rows[0];
    if (!row) {
      // Cookie pointed at a user that no longer exists; clear it.
      clearSessionCookie(res);
      return res.status(401).json({ error: 'Not signed in.' });
    }
    return res.json({ id: row.id, email: row.email });
  } catch (err) {
    console.error('[me] error:', err.message);
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