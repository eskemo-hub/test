# Task state

## Done
- Built a basic static landing site for the `test` repo (single page, no build tooling) — `index.html` + `styles.css` on `dev` branch. @Dev.
- Provisioned new `test-auth-db` postgres database via EasyCoder API (status: live). @PM.
- Built Node/Express backend with register/login/logout/me endpoints against `test-auth-db`, plus login + register + dashboard HTML pages wired to the API. Existing landing page preserved (now served from `public/`) with nav that flips between "Sign in" and "Dashboard / Sign out". Smoke-tested locally: register, /api/me, duplicate-email 409, bad-password 401 (generic), validation 400s, logout 204, post-logout /api/me 401. @Dev.
- Committed root commit `8f09233` on `dev`: server.js, config.js, db.js, db/migrate.js, db/schema.sql, public/{index.html,login.html,register.html,dashboard.html,app.js,styles.css}, package.json, package-lock.json, README.md, .gitignore, .agents/{TASKS.md,spec.md,stack.md}. 18 files. @Dev.
- Wired runtime state to persistent volume. Commit `1381de4` on `dev`: `config.js` exposes `dataDir = process.env.APP_DATA_DIR || path.join(__dirname, '.data')`, creates it with `fs.mkdirSync(..., {recursive:true})` on module load; `README.md` documents `APP_DATA_DIR`, the runtime-state contract, no-secrets-in-/data, and the 1 GB shared quota. No other files touched. @Dev.
- Republished via `POST /v1/workspaces/publish` with `persist: true` — bundle version 3. `GET /v1/apps/test` reports `runtime: node`, `command: npm start`, `port: 3000`, `dataPersistent: true`, `dataBytes: 0`. Live smoke test against `https://test.app.easycoder.dev`: `GET /` → 200 HTML (4501 B), `GET /dashboard.html` → 200 HTML (1644 B), `GET /api/me` (no cookie) → 401, `POST /api/login` (dummy creds) → 401. Auth API is up. @Dev.
- Built dashboard v2 on `dev` (uncommitted). Scope covered: (1) account panel — avatar initials, member-since, last-sign-in (relative + absolute), change-password form, sign-out-everywhere button; (2) personal notes CRUD — new `notes` table + GET/POST/PATCH/DELETE; (3) admin stats — `is_admin` role, `ADMIN_EMAILS` env allowlist, `/api/admin/stats` with totals + 14-day series, inline SVG line charts. Cookie payload changed to `${userId}.${epoch}` so `sign-out-everywhere` invalidates all of the user's devices. @Dev.

## In progress
- Verifying dashboard v2 locally (start server, hit the new endpoints), committing the diff to `dev`, and signaling PM to publish. @Dev.

## Next
- @PM: republish `test` via `POST /v1/workspaces/publish` after @Dev commits; live smoke test the new endpoints; confirm migration ran on the live DB.
- @Tester: end-to-end verification against `https://test.app.easycoder.dev` — register, notes CRUD, change password, sign-out-everywhere invalidates the previous cookie, admin gating (403 for non-admin), charts render without console errors.
- @Reviewer: code-review the diff on `dev` (correctness + reuse + the existing comment/style density) before any merge to `main`.
- PM closes the loop with the user once all three pass.

## Blocked
- None.