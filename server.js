// Express app: serves the static frontend from public/ and exposes the auth
// API under /api/*.

'use strict';

const path = require('path');
const crypto = require('crypto');
const express = require('express');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcrypt');
const { marked } = require('marked');
const sanitizeHtml = require('sanitize-html');
const Stripe = require('stripe');

const config = require('./config');
const pool = require('./db');
const migrate = require('./db/migrate');

const app = express();
const SESSION_COOKIE = 'session';

// ---------- Stripe client ----------
//
// Initialised lazily on the first request so absence of STRIPE_SECRET_KEY
// (the dev default) doesn't blow up the boot path. `config.stripeSecretKey`
// is checked by every handler so the same binary can run with or without
// real Stripe creds.
let _stripe = null;
function getStripe() {
  if (_stripe !== null) return _stripe;
  if (!config.stripeSecretKey) {
    _stripe = false;
    return _stripe;
  }
  _stripe = new Stripe(config.stripeSecretKey, { apiVersion: '2024-11-20.acacia' });
  return _stripe;
}

// ---------- Middleware ----------
//
// The Stripe webhook needs the *raw* request body to verify the
// signature. `express.json()` always parses first, so we capture the raw
// buffer via the standard `verify` hook and read it back on the webhook
// route. Every other route continues to see a parsed `req.body`.
// Install it *only* on the webhook route — installing it globally would
// break JSON parsing for every other request.
app.use(
  express.json({
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  })
);
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

// ---------- Markdown rendering ----------
//
// `body_md` is rendered with `marked` and then sanitised so we never hand
// raw user HTML to the browser. The allowlist is permissive enough to
// support a real blog post (headings, lists, code, blockquotes, links,
// images) but strips `<script>`, event handlers, `javascript:` URLs, and
// `<style>` injections. Images from the post body use plain absolute URLs
// — there's no upload pipeline in this demo, so a relative `src` would
// 404 anyway.
function renderMarkdown(md) {
  const rawHtml = marked.parse(md || '', { mangle: false, headerIds: false });
  return sanitizeHtml(rawHtml, {
    allowedTags: [
      'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
      'p', 'a', 'ul', 'ol', 'li', 'blockquote',
      'code', 'pre', 'em', 'strong', 'hr', 'br',
      'img', 'table', 'thead', 'tbody', 'tr', 'th', 'td',
    ],
    allowedAttributes: {
      a: ['href', 'name', 'target', 'rel'],
      img: ['src', 'alt', 'title'],
      code: ['class'],
      pre: ['class'],
      th: ['align'],
      td: ['align'],
    },
    allowedSchemes: ['http', 'https', 'mailto'],
    transformTags: {
      a: (tagName, attribs) => {
        // Force external links to open in a new tab; keep hash-anchors
        // alone.
        const href = attribs.href || '';
        if (/^https?:\/\//.test(href)) {
          return { tagName: 'a', attribs: { href, rel: 'noopener noreferrer', target: '_blank' } };
        }
        return { tagName: 'a', attribs };
      },
    },
  });
}

// Coerce PostgreSQL BIGINT/timestamps into plain JSON-serialisable values.
// We never expose `password_hash` or `token_hash` so that's not a worry.
function serializePost(row) {
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    excerpt: row.excerpt,
    tier: row.tier,
    published: row.published === true,
    published_at: row.published_at ? row.published_at.toISOString() : null,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}

// ---------- Rate limit (in-memory) ----------
//
// Bounded sliding-window counter, keyed by an arbitrary string (e.g. ip
// or user id). The map is pruned on every hit so it can't grow forever.
// For a single-process demo this is enough; a real app would back this
// with Redis.
function rateLimit({ key, max, windowMs }) {
  const now = Date.now();
  const cutoff = now - windowMs;
  const entry = _rlState.get(key);
  if (!entry) {
    _rlState.set(key, { hits: [now] });
    return { allowed: true, remaining: max - 1, resetMs: windowMs };
  }
  // Drop expired hits.
  while (entry.hits.length && entry.hits[0] < cutoff) entry.hits.shift();
  if (entry.hits.length >= max) {
    const resetMs = Math.max(0, windowMs - (now - entry.hits[0]));
    return { allowed: false, remaining: 0, resetMs };
  }
  entry.hits.push(now);
  return { allowed: true, remaining: max - entry.hits.length, resetMs: windowMs };
}
const _rlState = new Map();
setInterval(() => {
  // Periodic prune so a key that fell silent doesn't leak memory.
  const now = Date.now();
  for (const [k, v] of _rlState) {
    while (v.hits.length && v.hits[0] < now - 60 * 60 * 1000) v.hits.shift();
    if (v.hits.length === 0) _rlState.delete(k);
  }
}, 5 * 60 * 1000).unref();

// Pull a real `user_id` from the cookie or `null` when the request is
// anonymous / the cookie is stale. Distinct from `requireAuth` because
// /api/posts is allowed for everyone.
async function optionalAuth(req, res) {
  try {
    return await loadAuthUser(req, res);
  } catch (err) {
    return null;
  }
}

// Decide whether the caller has an *active* Pro subscription. The
// `user_subscriptions` row is the source of truth; "active" and
// "trialing" both unlock the paywall.
function subscriptionIsActive(row) {
  if (!row) return false;
  if (row.status !== 'active' && row.status !== 'trialing') return false;
  if (row.current_period_end && row.current_period_end.getTime() < Date.now()) {
    return false;
  }
  return true;
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

app.get('/api/me', requireAuth, async (req, res) => {
  const {
    id, email, is_admin, created_at, last_sign_in_at,
    email_verified, email_verified_at,
  } = req.user;
  // Subscription is a per-user row. We always read it on `/api/me` so the
  // dashboard can show a single "Pro · active" or "Free" badge without an
  // extra round-trip after page load.
  let subscription = null;
  try {
    const sub = await pool.query(
      `SELECT tier, status, current_period_end
         FROM user_subscriptions WHERE user_id = $1`,
      [id]
    );
    const row = sub.rows[0];
    if (row) {
      subscription = {
        tier: row.tier,
        status: row.status,
        current_period_end: row.current_period_end
          ? row.current_period_end.toISOString()
          : null,
        active: subscriptionIsActive(row),
      };
    }
  } catch (err) {
    console.error('[me] subscription lookup failed:', err.message);
  }
  return res.json({
    id,
    email,
    is_admin,
    created_at: created_at.toISOString(),
    last_sign_in_at: last_sign_in_at ? last_sign_in_at.toISOString() : null,
    email_verified: email_verified === true,
    email_verified_at: email_verified_at ? email_verified_at.toISOString() : null,
    subscription,
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

// ---------- Posts: list (public) ----------
//
// Returns posts sorted newest-first. Anonymous users see only published
// free posts; signed-in non-subscribers additionally see published paid
// posts (excerpt-only, gated by `body_html` being null). Subscribers and
// admins see the full body for everything they can list. Admins also see
// drafts. We return a flat array rather than splitting "free" / "paid"
// so the client can render one stream.
app.get('/api/posts', async (req, res) => {
  const user = await optionalAuth(req, res);
  const isAdmin = user && user.is_admin === true;
  const subRes = user
    ? await pool.query(
        `SELECT tier, status, current_period_end
           FROM user_subscriptions WHERE user_id = $1`,
        [user.id]
      )
    : { rows: [] };
  const isSubscriber = subscriptionIsActive(subRes.rows[0]);

  try {
    // Visibility clauses:
    //   - published: anything with published = TRUE
    //   - drafts: only admins see unpublished rows
    // The `(published OR is_admin)` shape lets the planner do one
    // index scan on (tier, published_at DESC).
    const result = await pool.query(
      `SELECT id, slug, title, excerpt, body_md, tier, published,
              published_at, created_at, updated_at
         FROM posts
        WHERE published = TRUE
           OR $1::BOOLEAN = TRUE
        ORDER BY published_at DESC NULLS LAST, created_at DESC`,
      [isAdmin]
    );

    // For paid posts seen by non-subscribers, drop the body.
    const posts = result.rows.map((row) => {
      const base = serializePost(row);
      const canRead = row.tier === 'free' || isSubscriber || isAdmin;
      if (canRead) {
        base.body_html = renderMarkdown(row.body_md);
      } else if (row.tier === 'paid') {
        base.locked = true;
      }
      return base;
    });
    return res.json({ posts });
  } catch (err) {
    console.error('[posts GET] error:', err.message);
    return res.status(500).json({ error: 'Something went wrong.' });
  }
});

// ---------- Posts: single (public) ----------
//
// `slug` is a free-text unique key. Unknown slug → 404. Paid post to a
// non-subscriber → `{locked: true, tier: 'paid', excerpt}` with no
// `body_html`. Subscriber / admin → `body_html` rendered from markdown.
app.get('/api/posts/:slug', async (req, res) => {
  const slug = String(req.params.slug || '').trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{0,80}$/.test(slug)) {
    return res.status(400).json({ error: 'Invalid slug.' });
  }
  const user = await optionalAuth(req, res);
  const isAdmin = user && user.is_admin === true;

  try {
    const result = await pool.query(
      `SELECT id, slug, title, excerpt, body_md, tier, published,
              published_at, created_at, updated_at
         FROM posts WHERE slug = $1`,
      [slug]
    );
    const row = result.rows[0];
    if (!row) {
      return res.status(404).json({ error: 'Post not found.' });
    }
    if (!row.published && !isAdmin) {
      return res.status(404).json({ error: 'Post not found.' });
    }

    let subActive = false;
    if (user) {
      const subRes = await pool.query(
        `SELECT tier, status, current_period_end
           FROM user_subscriptions WHERE user_id = $1`,
        [user.id]
      );
      subActive = subscriptionIsActive(subRes.rows[0]);
    }

    const base = serializePost(row);
    if (row.tier === 'paid' && !subActive && !isAdmin) {
      base.locked = true;
    } else {
      base.body_html = renderMarkdown(row.body_md);
    }
    return res.json(base);
  } catch (err) {
    console.error('[posts GET slug] error:', err.message);
    return res.status(500).json({ error: 'Something went wrong.' });
  }
});

// ---------- Posts: admin CRUD ----------
//
// All four routes require `is_admin = TRUE`. The dashboard posts section
// writes through these. We return the full row (with rendered body) so
// the admin doesn't have to re-fetch. The list endpoint returns
// `body_md` (not the sanitised HTML) so the admin's edit-form can
// round-trip the markdown without losing formatting.

// GET /api/admin/posts — full list including drafts, with body_md. Used by
// the dashboard admin section on first paint.
app.get('/api/admin/posts', requireAuth, requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, slug, title, excerpt, body_md, tier, published,
              published_at, created_at, updated_at
         FROM posts
        ORDER BY created_at DESC`
    );
    return res.json({
      posts: result.rows.map((r) => ({
        ...serializePost(r),
        body_md: r.body_md,
        body_html: renderMarkdown(r.body_md),
      })),
    });
  } catch (err) {
    console.error('[admin posts GET] error:', err.message);
    return res.status(500).json({ error: 'Something went wrong.' });
  }
});

function validatePostInput(body) {
  const out = {};
  if (typeof body.slug !== 'string') return { error: 'Slug is required.' };
  const slug = body.slug.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{0,80}$/.test(slug)) {
    return { error: 'Slug must be lowercase letters, digits, and dashes (1-81 chars).' };
  }
  if (typeof body.title !== 'string' || body.title.trim().length === 0) {
    return { error: 'Title is required.' };
  }
  if (body.title.length > 200) {
    return { error: 'Title is too long (max 200 chars).' };
  }
  if (typeof body.excerpt !== 'string' || body.excerpt.trim().length === 0) {
    return { error: 'Excerpt is required.' };
  }
  if (body.excerpt.length > 500) {
    return { error: 'Excerpt is too long (max 500 chars).' };
  }
  if (typeof body.body_md !== 'string' || body.body_md.length === 0) {
    return { error: 'Body is required.' };
  }
  if (body.body_md.length > 100000) {
    return { error: 'Body is too long (max 100k chars).' };
  }
  if (body.tier !== 'free' && body.tier !== 'paid') {
    return { error: 'Tier must be "free" or "paid".' };
  }
  out.slug = slug;
  out.title = body.title.trim();
  out.excerpt = body.excerpt.trim();
  out.body_md = body.body_md;
  out.tier = body.tier;
  return { value: out };
}

app.post('/api/admin/posts', requireAuth, requireAdmin, async (req, res) => {
  const v = validatePostInput(req.body || {});
  if (v.error) return res.status(400).json({ error: v.error });

  try {
    const result = await pool.query(
      `INSERT INTO posts (slug, title, excerpt, body_md, tier)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, slug, title, excerpt, body_md, tier, published,
                 published_at, created_at, updated_at`,
      [v.value.slug, v.value.title, v.value.excerpt, v.value.body_md, v.value.tier]
    );
    const row = result.rows[0];
    const base = serializePost(row);
    base.body_html = renderMarkdown(row.body_md);
    return res.status(200).json(base);
  } catch (err) {
    if (err && err.code === '23505') {
      return res.status(409).json({ error: 'A post with that slug already exists.' });
    }
    console.error('[admin posts POST] error:', err.message);
    return res.status(500).json({ error: 'Something went wrong.' });
  }
});

app.patch('/api/admin/posts/:id', requireAuth, requireAdmin, async (req, res) => {
  const id = Number.parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: 'Invalid post id.' });
  }
  // Partial update — only fields that were sent are touched. The validator
  // re-applies per-field type/shape checks.
  const partial = req.body || {};
  const sets = [];
  const params = [];
  function push(field, value) {
    params.push(value);
    sets.push(`${field} = $${params.length}`);
  }
  if ('title' in partial) {
    if (typeof partial.title !== 'string' || partial.title.trim().length === 0) {
      return res.status(400).json({ error: 'Title is required.' });
    }
    if (partial.title.length > 200) {
      return res.status(400).json({ error: 'Title is too long.' });
    }
    push('title', partial.title.trim());
  }
  if ('excerpt' in partial) {
    if (typeof partial.excerpt !== 'string' || partial.excerpt.trim().length === 0) {
      return res.status(400).json({ error: 'Excerpt is required.' });
    }
    if (partial.excerpt.length > 500) {
      return res.status(400).json({ error: 'Excerpt is too long.' });
    }
    push('excerpt', partial.excerpt.trim());
  }
  if ('body_md' in partial) {
    if (typeof partial.body_md !== 'string' || partial.body_md.length === 0) {
      return res.status(400).json({ error: 'Body is required.' });
    }
    if (partial.body_md.length > 100000) {
      return res.status(400).json({ error: 'Body is too long.' });
    }
    push('body_md', partial.body_md);
  }
  if ('tier' in partial) {
    if (partial.tier !== 'free' && partial.tier !== 'paid') {
      return res.status(400).json({ error: 'Tier must be "free" or "paid".' });
    }
    push('tier', partial.tier);
  }
  if ('slug' in partial) {
    if (typeof partial.slug !== 'string') {
      return res.status(400).json({ error: 'Slug is required.' });
    }
    const slug = partial.slug.trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9-]{0,80}$/.test(slug)) {
      return res.status(400).json({ error: 'Slug must be lowercase letters, digits, and dashes.' });
    }
    push('slug', slug);
  }
  if (sets.length === 0) {
    return res.status(400).json({ error: 'Nothing to update.' });
  }
  sets.push('updated_at = now()');
  params.push(id);
  try {
    const result = await pool.query(
      `UPDATE posts SET ${sets.join(', ')}
        WHERE id = $${params.length}
       RETURNING id, slug, title, excerpt, body_md, tier, published,
                 published_at, created_at, updated_at`,
      params
    );
    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Post not found.' });
    }
    const row = result.rows[0];
    const base = serializePost(row);
    base.body_html = renderMarkdown(row.body_md);
    return res.json(base);
  } catch (err) {
    if (err && err.code === '23505') {
      return res.status(409).json({ error: 'Slug is already in use.' });
    }
    console.error('[admin posts PATCH] error:', err.message);
    return res.status(500).json({ error: 'Something went wrong.' });
  }
});

// Publish toggle. Body: `{ published: boolean }`. PATCH to match the
// /api/admin/posts/:id partial-update verb and let the wire stay PATCH-only
// for "state-toggle on this resource" semantics.
app.patch('/api/admin/posts/:id/publish', requireAuth, requireAdmin, async (req, res) => {
  const id = Number.parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: 'Invalid post id.' });
  }
  if (typeof req.body !== 'object' || req.body === null) {
    return res.status(400).json({ error: 'Missing body.' });
  }
  const want = req.body.published;
  if (want !== true && want !== false) {
    return res.status(400).json({ error: '`published` must be a boolean.' });
  }
  try {
    const result = await pool.query(
      `UPDATE posts
          SET published = $1,
              published_at = CASE WHEN $1 AND published_at IS NULL THEN now() ELSE published_at END,
              updated_at = now()
        WHERE id = $2
       RETURNING id, slug, title, excerpt, body_md, tier, published,
                 published_at, created_at, updated_at`,
      [want, id]
    );
    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Post not found.' });
    }
    const row = result.rows[0];
    const base = serializePost(row);
    base.body_html = renderMarkdown(row.body_md);
    return res.json(base);
  } catch (err) {
    console.error('[admin posts publish] error:', err.message);
    return res.status(500).json({ error: 'Something went wrong.' });
  }
});

app.delete('/api/admin/posts/:id', requireAuth, requireAdmin, async (req, res) => {
  const id = Number.parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: 'Invalid post id.' });
  }
  try {
    const result = await pool.query('DELETE FROM posts WHERE id = $1', [id]);
    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Post not found.' });
    }
    return res.status(204).end();
  } catch (err) {
    console.error('[admin posts DELETE] error:', err.message);
    return res.status(500).json({ error: 'Something went wrong.' });
  }
});

// ---------- Checkout ----------
//
// Returns a `{url}` the client opens. When STRIPE_SECRET_KEY is set, we
// mint a real Stripe Checkout Session; without keys, we hand back our
// dev-grant path so the paywall is demoable end-to-end. The dev path is
// itself a POST (see /api/dev/grant-subscription), so we expose it as a
// URL with a query string the client recognises — see wireCheckoutButton.
app.post('/api/checkout', requireAuth, async (req, res) => {
  // 10 calls per minute per user is plenty for "click, see error, click
  // again" and stops a runaway loop from spamming Stripe.
  const rl = rateLimit({ key: `checkout:${req.user.id}`, max: 10, windowMs: 60_000 });
  if (!rl.allowed) {
    return res.status(429).json({ error: 'Please wait before retrying checkout.' });
  }

  // Don't open a checkout for a user who's already subscribed.
  try {
    const cur = await pool.query(
      `SELECT 1 FROM user_subscriptions
        WHERE user_id = $1 AND status IN ('active','trialing')
          AND (current_period_end IS NULL OR current_period_end > now())`,
      [req.user.id]
    );
    if (cur.rowCount > 0) {
      return res.status(409).json({ error: 'You already have an active Pro subscription.' });
    }
  } catch (err) {
    console.error('[checkout] sub check failed:', err.message);
  }

  const stripeClient = getStripe();
  if (stripeClient) {
    try {
      const session = await stripeClient.checkout.sessions.create({
        mode: 'subscription',
        payment_method_types: ['card'],
        line_items: [{ price: config.stripePriceId, quantity: 1 }],
        success_url: `${config.publicOrigin}/dashboard.html?upgrade=ok`,
        cancel_url: `${config.publicOrigin}/pricing.html`,
        client_reference_id: String(req.user.id),
        customer_email: req.user.email,
        metadata: { user_id: String(req.user.id) },
      });
      return res.json({ url: session.url });
    } catch (err) {
      console.error('[checkout] stripe error:', err.message);
      // Fall through to the dev path so the demo flow still works.
    }
  }
  // Dev path. We expose the request token in the URL so a click-through
  // can be tested in DevTools without losing the user id. The token is
  // only good for this single user — `POST /api/dev/grant-subscription`
  // re-checks that the cookie belongs to `?user_id=`.
  const token = crypto.randomBytes(16).toString('hex');
  const url = `/dev/grant-subscription.html?tier=paid&user_id=${req.user.id}&token=${token}`;
  // We also remember the token in-memory keyed by user id so a malformed
  // request without it can be rejected. Lightweight dev guard.
  _grantTokens.set(`${req.user.id}:${token}`, Date.now() + 5 * 60 * 1000);
  return res.json({ url, devGrant: true });
});

// One-shot grant-token map for the dev-grant flow.
const _grantTokens = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [k, exp] of _grantTokens) {
    if (exp < now) _grantTokens.delete(k);
  }
}, 60_000).unref();

// ---------- Dev grant (NON-PRODUCTION) ----------
//
// Gated to NODE_ENV !== 'production' so accidentally clicking it on a
// real deployment can never flip a user to Pro. Re-checks the token
// from the URL against `_grantTokens`. Bumps session_epoch so any cached
// /api/me state on the client picks up the new tier on next load.
app.post('/api/dev/grant-subscription', requireAuth, async (req, res) => {
  if (config.nodeEnv === 'production') {
    return res.status(403).json({ error: 'Disabled in production.' });
  }
  const userIdParam = Number.parseInt(
    (req.body && req.body.user_id) || (req.query && req.query.user_id) || 0,
    10
  );
  if (!Number.isInteger(userIdParam) || userIdParam !== req.user.id) {
    return res.status(403).json({ error: 'user_id mismatch.' });
  }
  const tier = ((req.body && req.body.tier) || (req.query && req.query.tier) || '').trim();
  if (tier !== 'paid') {
    return res.status(400).json({ error: 'Only "paid" is supported.' });
  }
  const token = (req.body && req.body.token) || (req.query && req.query.token) || '';
  const key = `${userIdParam}:${token}`;
  const exp = _grantTokens.get(key);
  if (!exp || exp < Date.now()) {
    return res.status(400).json({ error: 'Invalid or expired grant token.' });
  }
  _grantTokens.delete(key);

  try {
    const periodEnd = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    await pool.query(
      `INSERT INTO user_subscriptions
         (user_id, tier, status, current_period_end, updated_at)
       VALUES ($1, 'paid', 'active', $2, now())
       ON CONFLICT (user_id) DO UPDATE
         SET tier = 'paid',
             status = 'active',
             current_period_end = EXCLUDED.current_period_end,
             updated_at = now()`,
      [req.user.id, periodEnd]
    );
    await pool.query(
      'UPDATE users SET session_epoch = session_epoch + 1 WHERE id = $1',
      [req.user.id]
    );
    recordSecurityEvent({ userId: req.user.id, type: 'dev_grant_subscription', req });
    clearSessionCookie(res);
    return res.json({ ok: true, tier: 'paid', status: 'active' });
  } catch (err) {
    console.error('[dev grant] error:', err.message);
    return res.status(500).json({ error: 'Something went wrong.' });
  }
});

// ---------- Stripe webhook ----------
//
// Single endpoint — `events.constructEvent` verifies the signature using
// the raw body attached by `rawBodyForStripe`. We only react to three
// event types today; anything else is acknowledged with 200 so Stripe
// doesn't retry. Each branch upserts `user_subscriptions` keyed on
// `user_id` (resolved from the customer id or directly off the session).
app.post('/api/stripe/webhook', async (req, res) => {
  const stripeClient = getStripe();
  if (!stripeClient) {
    return res.status(503).json({ error: 'Stripe is not configured.' });
  }
  if (!config.stripeWebhookSecret) {
    return res.status(503).json({ error: 'Webhook secret is not configured.' });
  }
  if (!req.rawBody) {
    return res.status(400).json({ error: 'Missing raw body.' });
  }
  let event;
  try {
    event = stripeClient.webhooks.constructEvent(
      req.rawBody,
      req.headers['stripe-signature'],
      config.stripeWebhookSecret
    );
  } catch (err) {
    console.error('[stripe webhook] signature failed:', err.message);
    return res.status(400).json({ error: 'Invalid signature.' });
  }

  try {
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      const userId = Number.parseInt(session.metadata && session.metadata.user_id, 10);
      if (Number.isInteger(userId) && userId > 0) {
        await pool.query(
          `INSERT INTO user_subscriptions
             (user_id, tier, status, stripe_customer_id, stripe_subscription_id,
              current_period_end, updated_at)
           VALUES ($1, 'paid', 'active', $2, $3, $4, now())
           ON CONFLICT (user_id) DO UPDATE
             SET tier = 'paid',
                 status = 'active',
                 stripe_customer_id = EXCLUDED.stripe_customer_id,
                 stripe_subscription_id = EXCLUDED.stripe_subscription_id,
                 current_period_end = EXCLUDED.current_period_end,
                 updated_at = now()`,
          [
            userId,
            typeof session.customer === 'string' ? session.customer : null,
            typeof session.subscription === 'string' ? session.subscription : null,
            new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
          ]
        );
      }
    } else if (event.type === 'customer.subscription.updated') {
      const sub = event.data.object;
      const customerId = typeof sub.customer === 'string' ? sub.customer : null;
      if (customerId) {
        const periodEnd = sub.current_period_end
          ? new Date(sub.current_period_end * 1000)
          : null;
        await pool.query(
          `UPDATE user_subscriptions
              SET status = $1,
                  current_period_end = $2,
                  updated_at = now()
            WHERE stripe_customer_id = $3`,
          [sub.status, periodEnd, customerId]
        );
      }
    } else if (event.type === 'customer.subscription.deleted') {
      const sub = event.data.object;
      const customerId = typeof sub.customer === 'string' ? sub.customer : null;
      if (customerId) {
        await pool.query(
          `UPDATE user_subscriptions
              SET status = 'canceled', updated_at = now()
            WHERE stripe_customer_id = $1`,
          [customerId]
        );
      }
    }
    return res.json({ received: true });
  } catch (err) {
    console.error('[stripe webhook] handler error:', err.message);
    return res.status(500).json({ error: 'Webhook handler failed.' });
  }
});

// ---------- Email capture (landing newsletter) ----------
//
// Public endpoint, deduped via the unique lowercase-email index. Rate
// limit: 5/min/IP. On duplicate we treat it as success ("already on the
// list") so a user retrying doesn't think they failed.
app.post('/api/email-capture', async (req, res) => {
  const { email } = req.body || {};
  if (!isValidEmail(email)) {
    return res.status(400).json({ error: 'Please enter a valid email address.' });
  }
  const ip = req.ip || 'unknown';
  const rl = rateLimit({ key: `emailcap:${ip}`, max: 5, windowMs: 60_000 });
  if (!rl.allowed) {
    return res.status(429).json({ error: 'Too many requests. Please try again in a minute.' });
  }

  const normalized = email.trim().toLowerCase();
  try {
    await pool.query(
      `INSERT INTO email_subscribers (email) VALUES ($1)
       ON CONFLICT (lower(email)) DO NOTHING`,
      [normalized]
    );
    if (config.nodeEnv !== 'production') {
      console.log(`[newsletter] subscribed: ${normalized}`);
    }
    return res.json({ ok: true });
  } catch (err) {
    console.error('[email-capture] error:', err.message);
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
