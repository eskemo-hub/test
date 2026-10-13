# Spec — `test`

## Brief

A small Node/Express + Postgres demo with a static landing page and a
real auth flow: register, login, logout, a protected dashboard, personal
notes, and admin-only stats. No build step.

## Goals

- [x] Static landing page (`public/index.html` + `public/styles.css`).
- [x] Auth backend: register / login / logout / me against managed `test-auth-db`.
- [x] Login + register + dashboard HTML pages wired to the API.
- [x] Dashboard v2: account panel (avatar, member-since, last-sign-in,
      change-password, sign-out-everywhere), personal notes CRUD, admin
      stats section with 14-day line charts.
- [x] Cookie format `${userId}.${epoch}` for "Sign out everywhere" support.

## Constraints

- Keep deploys additive; never break what ships.
- Secrets stay out of the repo — document the env var name, not the value.
- No build step / no charting library — inline SVG only.

## Decisions log

Newest first.

- _2026-10-13_ — Dashboard v2: extended `users` (`last_sign_in_at`,
  `is_admin`, `session_epoch`), added `notes` table, added admin/notes/
  change-password/sign-out-everywhere endpoints, rewrote `dashboard.html`
  / `app.js` / `styles.css`, added `ADMIN_EMAILS` allowlist. Cookie
  payload changed from `${userId}` to `${userId}.${epoch}`. Charts are
  inline SVG (no library), use the existing `--accent` token for the line
  and `--border` for axes.
- _2026-10-12_ — Wired `APP_DATA_DIR` for future local runtime state.
- _earlier_ — Initial scaffold: static landing + auth backend.
