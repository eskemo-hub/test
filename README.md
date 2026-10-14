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
| `STRIPE_SECRET_KEY` | Optional. Stripe API key. Without it `/api/checkout` returns the dev-grant URL and the webhook returns 503. |
| `STRIPE_WEBHOOK_SECRET` | Optional. Webhook signing secret. |
| `STRIPE_PRICE_ID` | Optional. Recurring price id used by `/api/checkout`. |
| `PUBLIC_ORIGIN` | Optional. Used to build Stripe Checkout success/cancel URLs. |

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
| POST   | `/api/register`               | `{ email, password }`                 | `200 { id, email, is_admin, verifyLink? }` (sets cookie)    |
| POST   | `/api/login`                  | `{ email, password }`                 | `200 { id, email, is_admin }` (sets cookie)                 |
| POST   | `/api/logout`                 | —                                     | `204` (clears cookie)                                       |
| GET    | `/api/me`                     | —                                     | `200 { id, email, is_admin, created_at, last_sign_in_at, email_verified, email_verified_at }` |
| GET    | `/api/healthz`                | —                                     | `200 { ok: true, dataDir }` (liveness + persistence probe)  |
| POST   | `/api/change-password`        | `{ currentPassword, newPassword }`    | `200 { ok: true }` (cookie stays; user must sign in again on other devices) |
| POST   | `/api/sign-out-everywhere`    | —                                     | `204` (clears cookie; bumps `session_epoch`)                |
| POST   | `/api/password/reset/request` | `{ email }`                           | `200 { ok: true, link? }` — link is dev-only                |
| POST   | `/api/password/reset/confirm` | `{ token, newPassword }`              | `200 { ok: true }` (bumps `session_epoch`; clears cookie)    |
| POST   | `/api/email/verify/request`   | —                                     | `200 { ok: true, link? }` — link is dev-only; 429 if a token was issued for this user in the last 60 s |
| POST   | `/api/email/verify/confirm`   | `{ token }`                           | `200 { ok: true }` or `400` if expired / used               |
| GET    | `/api/security/events`        | —                                     | `200 { events: [{ id, type, ip, user_agent, created_at }] }` (last 50 for the caller) |
| GET    | `/api/notes`                  | —                                     | `200 { notes: [{ id, body, created_at, updated_at }] }`     |
| POST   | `/api/notes`                  | `{ body }`                            | `200 { id, body, created_at, updated_at }`                  |
| PATCH  | `/api/notes/:id`              | `{ body }`                            | `200 { id, body, created_at, updated_at }` or `404`         |
| DELETE | `/api/notes/:id`              | —                                     | `204` or `404`                                              |
| GET    | `/api/admin/stats`            | —                                     | `200 { totalUsers, totalNotes, signupsByDay, notesByDay }`  |
| GET    | `/api/posts`                  | —                                     | `200 { posts: [...] }` — visible posts (see Newsletter section); admin sees drafts |
| GET    | `/api/posts/:slug`            | —                                     | `200 { …, body_html }` for unlocked posts; `{locked: true, tier: 'paid', excerpt}` for paid posts to non-subscribers; 404 for missing |
| POST   | `/api/email-capture`          | `{ email }`                           | `200 { ok: true }` — dedupes by lower(email), 5/min/IP, 429 over |
| POST   | `/api/checkout`               | —                                     | `200 { url }` — Stripe Checkout URL when keys are set, else `/dev/grant-subscription.html?tier=paid&user_id=…&token=…`. 10/min/user, 429 over. 409 if already Pro. |
| POST   | `/api/dev/grant-subscription` | `{ user_id, token, tier }`            | `200 { ok: true, tier: 'paid' }`. 403 in production. Bumps `session_epoch`. |
| POST   | `/api/stripe/webhook`         | (raw Stripe event w/ signature)       | `200 { received: true }` on verified events; 400 on bad signature |
| GET    | `/api/admin/posts`            | —                                     | `200 { posts: [...] }` admin-only; drafts included; `body_md` and `body_html` |
| POST   | `/api/admin/posts`            | `{ slug, title, excerpt, body_md, tier }` | `200 { …, body_html }` or 409 on duplicate slug |
| PATCH  | `/api/admin/posts/:id`        | partial fields                        | `200` or 404 / 409 |
| POST   | `/api/admin/posts/:id/publish`| `{ published: boolean }`              | `200` or 404 |
| DELETE | `/api/admin/posts/:id`        | —                                     | `204` or 404 |

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

## Account recovery & security

Three small features on top of the auth surface, all additive — the cookie
format, `/api/me` shape, and the existing routes are unchanged.

- **Password reset.** Forgot-password → `/forgot.html` posts the email to
  `POST /api/password/reset/request`. The response is always `{ok: true}`
  (same shape for unknown emails) so the endpoint cannot be used to
  enumerate accounts. In dev the link is also returned in JSON
  (`link: "/reset.html?token=…"`); in production it is logged to stdout
  so an SMTP layer can pick it up later. `/reset.html` reads `?token=`
  and posts the new password to `POST /api/password/reset/confirm`,
  which deletes the token row, hashes the new password, and bumps
  `session_epoch` so any active cookie dies. Tokens are 32 random bytes
  hex-encoded; we store only `SHA-256(token)` in `password_reset_tokens`
  and TTL them at 1 hour.
- **Email verification.** New accounts default to `users.email_verified =
  FALSE`. The registration response includes a `verifyLink` (dev only) or
  the link is logged (prod). `/verify.html` reads `?token=` and posts to
  `POST /api/email/verify/confirm`; on success `users.email_verified` is
  flipped to `TRUE` and `email_verified_at` is set. Tokens are 24 h, single
  use (`used_at IS NULL` filter), and `POST /api/email/verify/request`
  rate-limits to one fresh link per 60 s per user.
- **Security / audit log.** Every state-changing auth action inserts a row
  into `security_events` with the user id (nullable for `login_failed`
  against an unknown email), event type, IP, and user-agent. Types:
  `register`, `login`, `login_failed`, `logout`, `sign_out_everywhere`,
  `change_password`, `password_reset_request`, `password_reset_confirm`,
  `email_verify_request`, `email_verify_confirm`. `GET /api/security/events`
  returns the last 50 rows for the caller, newest first. The dashboard
  renders them in a dedicated "Security" panel; audit logging never
  breaks a user flow (a failed INSERT is logged and swallowed).

## Newsletter / blog

A paywalled newsletter on top of the same auth surface. The post format
is **markdown** — `body_md` is rendered with `marked` and sanitised with
`sanitize-html` server-side, so the API never hands raw HTML to the
browser. Each post is `free` (always readable) or `paid` (excerpt-only
unless the caller has an active `user_subscriptions` row).

### Schema

- `posts (id, slug UNIQUE, title, excerpt, body_md, tier CHECK ('free','paid'), published, published_at, created_at, updated_at)` — drafted and unpublished posts are hidden from non-admins; admins always see them.
- `user_subscriptions (user_id PK, tier, status, stripe_customer_id, stripe_subscription_id, current_period_end, updated_at)` — one row per paying user. Absence of a row means "Free".
- `email_subscribers (id, email, created_at)` — unique on `lower(email)` for the landing-form dedupe.

### Public flow

- `GET /api/posts` — anon / non-subscribers see free posts full and paid posts excerpt-only (no `body_html`); active subscribers and admins see full body for everything they can list; admins also see drafts.
- `GET /api/posts/:slug` — same logic with a 404 for unknown / unpublished (non-admin) slugs. Locked paid posts return `{locked: true, tier: 'paid', excerpt}` with no body.
- `POST /api/email-capture` — dedupes by `lower(email)` and rate-limits 5 requests/min/IP; > 5/min → 429.
- `POST /api/checkout` — returns `{url}`. With `STRIPE_SECRET_KEY` set, this is a real Stripe Checkout Session URL; otherwise it is the dev-grant URL `/dev/grant-subscription.html?tier=paid&user_id=…&token=…` which uses the dev path below. 10 calls/min/user, then 429.
- `POST /api/stripe/webhook` — verifies the signature via `Stripe.webhooks.constructEvent` on the **raw** body. Handles `checkout.session.completed` / `customer.subscription.updated` / `customer.subscription.deleted`; everything else is `200 {received: true}` so Stripe doesn't retry.

### Dev-grant flow (no Stripe needed)

`POST /api/dev/grant-subscription` returns 403 when `NODE_ENV=production`.
In dev it flips the caller's `user_subscriptions` to `{tier:'paid',
status:'active', current_period_end: now+30d}`, bumps `session_epoch`
(so the next `/api/me` returns the new badge), and records a
`dev_grant_subscription` row in `security_events`. The grant URL the
client opens includes a one-shot token tied to the user id; without a
matching token the endpoint returns 400. End-to-end: register →
`/pricing.html` → "Subscribe to Pro" → grant page → dashboard shows
"Pro · active" and locked posts unlock.

### Admin

- `GET /api/admin/posts` — list every post (drafts included) with `body_md` and `body_html`.
- `POST /api/admin/posts`, `PATCH /api/admin/posts/:id`, `DELETE /api/admin/posts/:id`, `POST /api/admin/posts/:id/publish` — full CRUD, admin-only (403 otherwise).

The dashboard admin section renders the editor + table; new rows can be
created, edited (form re-seeds from `body_md` losslessly), published /
unpublished, and deleted. The markdown source is sanitised before any
rendered HTML reaches the browser — a `<script>alert(1)</script>` in a
post body becomes the literal text after parsing.

### Stripe setup (env vars, none required in dev)

| Variable | Purpose |
| --- | --- |
| `STRIPE_SECRET_KEY` | API key used by `Stripe(…)`. If absent, `/api/checkout` returns the dev-grant URL. |
| `STRIPE_WEBHOOK_SECRET` | Signing secret for `constructEvent`. The webhook returns 503 if absent. |
| `STRIPE_PRICE_ID` | The recurring price id for the Pro subscription; the Checkout session is built with `mode: 'subscription'` against it. |
| `PUBLIC_ORIGIN` | Used to build the success / cancel URLs on Checkout (e.g. `https://test.app.easycoder.dev`). Defaults to `''` which falls through to a same-origin URL. |

Point Stripe at `POST /api/stripe/webhook` and the three subscribed
events above will keep `user_subscriptions` in sync.

## Publishing

This repo publishes to **https://test.app.easycoder.dev**. Hit
**"Push to preview"** in the EasyCoder workspace to update it. The published
container sets its own `DATABASE_URL` and `COOKIE_SECRET` — the dev fallbacks
in `config.js` are only used when those env vars are absent, which is the
case for local development inside this workspace.
