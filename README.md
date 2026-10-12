# test

A small Node/Express app for the `test` repo: a static landing page plus a
real, Postgres-backed register / login / logout flow with a protected
dashboard.

## Stack

- **Backend** — Node.js, Express 4, `pg`, `bcrypt`, `cookie-parser`
- **Database** — Postgres (provisioned as `test-auth-db`)
- **Frontend** — plain HTML, CSS, and a small `app.js` (no build step)

## Layout

```
public/        Static files served by Express (index.html, login.html, register.html, dashboard.html, styles.css, app.js)
server.js      Express app + auth API
db.js          Shared pg pool
config.js      Env-driven config with a dev fallback
db/schema.sql  CREATE TABLE IF NOT EXISTS users (...)
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

`config.js` reads two env vars and falls back to dev defaults so it boots in
this workspace without any extra files:

| Variable       | Purpose                                          |
| -------------- | ------------------------------------------------ |
| `DATABASE_URL` | Postgres connection string.                      |
| `COOKIE_SECRET`| Secret used to sign the session cookie.          |
| `PORT`         | Port to listen on (default `3000`).              |
| `NODE_ENV`     | Set to `production` to mark the cookie `secure`. |

To use your own database locally without touching the committed fallback,
copy `.env.example` (or just create `.env`) and export the values before
running `npm start`. The committed dev values stay in `config.js` for the
EasyCoder workspace; they are not loaded from `.env` automatically.

## API

| Method | Path           | Body                       | Success                          |
| ------ | -------------- | -------------------------- | -------------------------------- |
| POST   | `/api/register`| `{ email, password }`      | `200 { id, email }` (sets cookie)|
| POST   | `/api/login`   | `{ email, password }`      | `200 { id, email }` (sets cookie)|
| POST   | `/api/logout`  | —                          | `204` (clears cookie)            |
| GET    | `/api/me`      | —                          | `200 { id, email }` or `401`     |

- `register` validates email shape and `password.length >= 8`, lowercases the
  email, bcrypt-hashes (cost 10), and inserts. Returns `409` on duplicate
  email.
- `login` returns a generic `401 Invalid email or password.` on any failure
  so it does not disclose which email is registered. It also runs a bcrypt
  compare against a dummy hash on missing users to keep timing similar.
- The session cookie is signed, `httpOnly`, `sameSite=lax`, and marked
  `secure` when `NODE_ENV=production`.

## Publishing

This repo publishes to **https://test.app.easycoder.dev**. Hit
**"Push to preview"** in the EasyCoder workspace to update it. The published
container sets its own `DATABASE_URL` and `COOKIE_SECRET` — the dev fallbacks
in `config.js` are only used when those env vars are absent, which is the
case for local development inside this workspace.