# EasyCoder workspace demo

A small Node/Express app for the `test` workspace: a static landing page plus a
real, Postgres-backed register / login / logout flow with a dashboard that
has an account panel, personal notes, and (for admins) a stats view. This is
one of many tiny apps shipped from [easycoder.dev](https://easycoder.dev)
workspaces — the URL is `test.app.easycoder.dev` and the branding is content.

## Stack

- **Backend** — Node.js, Express 4, `pg`, `bcrypt`, `cookie-parser`
- **Database** — Postgres (provisioned as `test-auth-db`)
- **Frontend** — plain HTML, CSS, and a small `app.js` (no build step)

## Layout

```
public/        Static files served by Express (index.html, login.html, register.html, dashboard.html, styles.css, app.js)
server.js      Express app + auth/notes/admin API
db.js          Shared pg pool
config.js      Env-driven config with a dev fallback
db/schema.sql  Idempotent CREATE / ALTER for users + notes
db/migrate.js  Applies schema.sql on startup
```

## Local setup

1. Install dependencies:
   ```bash
   npm install
   ```
2. Start the server (it runs the migration on boot):
   ```bash
   npm start
   ```
   It listens on `http://localhost:3000`.

### Environment overrides

`config.js` reads env vars and falls back to dev defaults so it boots in
this workspace without any extra files:

| Variable       | Purpose                                                |
| -------------- | ------------------------------------------------------ |
| `DATABASE_URL` | Postgres connection string.                            |
| `COOKIE_SECRET`| Secret used to sign the session cookie.                |
| `PORT`         | Port to listen on (default `3000`).                    |
| `NODE_ENV`     | Set to `production` to mark the cookie `secure`.       |
| `APP_DATA_DIR` | Directory for local runtime state (default `/data` in production, `.data/` locally). |
| `ADMIN_EMAILS` | Comma-separated list of emails to auto-promote to admin on login/register. See [Admin access](#admin-access). |

To use your own database locally without touching the committed fallback,
copy `.env.example` (or just create `.env`) and export the values before
running `npm start`. The committed dev values stay in `config.js` for the
EasyCoder workspace; they are not loaded from `.env` automatically.

## Persistence

`/data` survives redeploys, restarts, and rollbacks (the app is published
with `persist: true`). The only stateful DB today is the external managed
Postgres `test-auth-db`; nothing else in the app writes to disk. `config.js`
exposes `config.dataDir` (from `APP_DATA_DIR`, default `/data` in the
published container, `.data/` locally) and creates it on boot, so any
future local files — uploads, caches, an on-disk store — should live
under `config.dataDir` to inherit persistence for free.

A few rules for whoever fills that in:

- Do **not** write secrets into `/data` — the file system is shared
  infrastructure, not redacted configs and env vars.
- The whole folder is wiped between redeploys unless the app was
  published with `persist: true`. Confirm `GET /v1/apps/<slug>` returns
  `dataPersistent: true` before relying on it across deploys.
- The default `/data` quota is 1 GB shared across the org; over-quota
  writes fail with `EACCES`. Watch `dataBytes` on `/v1/apps/<slug>`.

## Admin access

Some users are admins. Admins can read the `/api/admin/stats` endpoint,
which powers the **Admin · Stats** section on the dashboard (total users,
total notes, 14-day signups/notes series).

Admin status is set in two ways:

1. **Allowlist (recommended).** Set the `ADMIN_EMAILS` env var to a
   comma-separated list of lowercased emails. On every successful login
   and register, users whose email is in that set are promoted to
   `is_admin = TRUE` automatically. The set is loaded once at startup;
   changes to `ADMIN_EMAILS` take effect on the next deploy.
2. **Manual SQL fallback.** Run against `test-auth-db`:
   ```sql
   UPDATE users SET is_admin = TRUE WHERE email = 'you@example.com';
   ```
   The next time that user signs in, the cookie payload reflects the
   change. (The `is_admin` flag is denormalised in the cookie response so
   the dashboard can hide the section without an extra round-trip.)

## Session epoch & "Sign out everywhere"

The session cookie payload is `${userId}.${epoch}` (still a signed cookie).
`epoch` is a per-user counter in `users.session_epoch`. Every auth-required
endpoint loads the user row and checks that the cookie's epoch matches the
row's current epoch; a mismatch invalidates the cookie and returns 401.

`POST /api/sign-out-everywhere` bumps `session_epoch` for the caller by 1
and clears the cookie. That invalidates the cookie on **every** device the
user is signed in on; the next request from any of them will be rejected
with 401, and the user has to sign in again. Use it when a device is lost
or when a session is suspected to be compromised.

## API

| Method | Path                          | Body                                  | Success                                                     |
| ------ | ----------------------------- | ------------------------------------- | ----------------------------------------------------------- |
| POST   | `/api/register`               | `{ email, password }`                 | `200 { id, email, is_admin }` (sets cookie)                 |
| POST   | `/api/login`                  | `{ email, password }`                 | `200 { id, email, is_admin }` (sets cookie)                 |
| POST   | `/api/logout`                 | —                                     | `204` (clears cookie)                                       |
| GET    | `/api/me`                     | —                                     | `200 { id, email, is_admin, created_at, last_sign_in_at }`  |
| GET    | `/api/healthz`                | —                                     | `200 { ok: true, dataDir }` (liveness + persistence probe)  |
| POST   | `/api/change-password`        | `{ currentPassword, newPassword }`    | `200 { ok: true }` (cookie stays; user must sign in again on other devices) |
| POST   | `/api/sign-out-everywhere`    | —                                     | `204` (clears cookie; bumps `session_epoch`)                |
| GET    | `/api/notes`                  | —                                     | `200 { notes: [{ id, body, created_at, updated_at }] }`     |
| POST   | `/api/notes`                  | `{ body }`                            | `200 { id, body, created_at, updated_at }`                  |
| PATCH  | `/api/notes/:id`              | `{ body }`                            | `200 { id, body, created_at, updated_at }` or `404`         |
| DELETE | `/api/notes/:id`              | —                                     | `204` or `404`                                              |
| GET    | `/api/admin/stats`            | —                                     | `200 { totalUsers, totalNotes, signupsByDay, notesByDay }`  |

### Endpoint notes

- `healthz` is unauthenticated and returns the resolved `config.dataDir`. Use
  it to confirm the published container sees `/data` after a publish:
  `curl https://test.app.easycoder.dev/api/healthz` →
  `{"ok":true,"dataDir":"/data"}`.
- `register` validates email shape and `password.length >= 8`, lowercases the
  email, bcrypt-hashes (cost 10), and inserts. Returns `409` on duplicate
  email.
- `login` returns a generic `401 Invalid email or password.` on any failure
  so it does not disclose which email is registered. It also runs a bcrypt
  compare against a dummy hash on missing users to keep timing similar.
- The session cookie is signed, `httpOnly`, `sameSite=lax`, and marked
  `secure` when `NODE_ENV=production`. Payload format: `${userId}.${epoch}`.
- `change-password` requires auth. On success the cookie is not invalidated,
  but the user should sign out everywhere if they suspect the old password
  was compromised.
- `sign-out-everywhere` requires auth. After success, all of the user's
  existing cookies become invalid.
- Notes are scoped to the caller; `PATCH`/`DELETE` return `404` for notes
  the caller does not own.
- `admin/stats` requires `is_admin = TRUE`. Returns 14 days of data,
  oldest first, with zero-filled days (via `generate_series`).

## Publishing

This repo publishes to **https://test.app.easycoder.dev**. Hit
**"Push to preview"** in the EasyCoder workspace to update it. The published
container sets its own `DATABASE_URL` and `COOKIE_SECRET` — the dev fallbacks
in `config.js` are only used when those env vars are absent, which is the
case for local development inside this workspace.
