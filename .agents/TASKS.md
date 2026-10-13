# Task state

## Done
- Static landing site, auth backend, dashboard v2, persistence-via-DB-only — see git log on `dev`.
- Prod and dev both shipped to head `9cffb8d` (prod bundle v6 / dev bundle v10, `branch=dev`). Title + eyebrow read "EasyCoder — workspace demo" on prod.
- Landing copy refresh — 5 wording tweaks in `public/index.html`; landed as `e680031`.
- `/data` persistence plumbing + verification: `GET /api/healthz` returns `{ok:true,dataDir}`; README "Persistence" section; published to `https://test.app.easycoder.dev` with `dataPersistent:true`.
- Responsive pass landed as `903c0d6`: nav `flex-wrap` at ≤640px, `.chart-label` 11→13px, dashboard grid capped at 64rem on ≥1200px.
- Rebrand commit `6f90b0f` on `dev`: landing rebuilt with 10 EasyCoder-style sections; login/register/dashboard HTML title/wordmark/footer refresh (forms unchanged); brand purple accent + new section classes; `package.json`/`README.md` tagline. 7 files, +467/-63. `server.js` / `app.js` / `config.js` / `db/` / `public/api/` untouched.
- Code-review rebrand commit `6f90b0f`: PASS — no findings. Diff stayed client-facing only; no JS/API/DB touched; form input/button ids preserved.
- Code-review dashboard styling `66a172c`: PASS — no findings. Verified responsive rules from `903c0d6` intact (nav wrap @ ≤640px, chart-label 13px, dashboard cap @ ≥1200px, chart 720px cap), `.panel-eyebrow` matches landing `.eyebrow` letter-case/family without duping its pill background, `.note-card` added to reduced-motion list, no form input/button id touches.
- Smoke-check dashboard styling `66a172c`: 6/6 PASS. (a) Notes eyebrow "Personal" + h2 "Notes" in `app.js:322-324`; (b) Admin eyebrow "Workspace" + h2 "Stats" in `app.js:434-436`; (c) `.stat-tile-label` color `var(--accent)` (`styles.css:844-849`) applied to all 4 tile labels; (d) `.admin-section` accent-25 border + soft halo via `color-mix` (`styles.css:823-828`); (e) `.note-card` listed inside `@media (prefers-reduced-motion: reduce)` (`styles.css:1240-1253`); (f) dev-login round-trip: register→logout→login→/api/me→/api/notes→/dashboard.html all 200, cookie auth holds, `id="dashboard-root"` present.
- Dashboard styling refresh landed as `66a172c`: `.panel-eyebrow` above `.section-heading` on Notes + Admin sections, `.section-heading` 1.15→1.25rem + tightened letter-spacing, `.stat-tile-label` accent-tinted + weight 600, `.note-card` hover lift, `.admin-section` accent 25% border + soft halo, `.note-card` added to reduced-motion list. `public/styles.css` (+29) + `public/app.js` (+3/-1) — no form IDs / API / server / db touched.

## In progress
- After the build lands: publish `dev` → prod via the EasyCoder publish API, then @Tester runs full live verify.

## Done (this build)
- One commit on `dev` titled "Add password reset, security log, and email verification". Stage only the intended files; no `node_modules`, no `.env`. Tree clean after the commit.
- `node db/migrate.js` succeeds twice in a row (idempotency check).
- Local smoke (`PORT=3000 NODE_ENV=development node server.js`) → register a fresh user → `curl /api/me` includes `email_verified:false` and `email_verified_at:null` → request a password reset → confirm with the returned token, hit login with the new password and it works → request email verification → confirm with the returned token → `/api/me` shows `email_verified:true, email_verified_at:<iso>` → `GET /api/security/events` returns the expected row types in the expected order (most recent first). Adversarial cases: re-use of reset token 400, re-use of verify token 400 (used_at filter), bad token shape 400, unauth `/api/security/events` 401, unauth `/api/email/verify/request` 401, second `/api/email/verify/request` within 60 s 429 (rate limit).
- `forgot.html`, `reset.html`, `verify.html` all return 200 with the EasyCoder brand chrome; `login.html` has a "Forgot password?" link to `/forgot.html`; `register.html` carries the "We'll send a verification link…" line under the password field. Dashboard renders the verify banner when `email_verified:false` and the new "Security" panel from `GET /api/security/events`.

## Next
- @Reviewer diff-check (correctness + reuse + no breakage of dashboard / form IDs / responsive rules).
- After review: @Tester smoke-check the three flows on dev-rung then trigger `curl -X POST https://api.easycoder.dev/v1/workspaces/publish -H "authorization: Bearer $CODERHUB_WS_TOKEN" -d '{"repoName":"test"}'` for prod.

## Blocked
- (none — both rungs shipped, both on head `9cffb8d`)

## Observed (no action)
- "Workspace is still starting / failed to start" alerts arriving repeatedly for `https://test.app.easycoder.dev` are platform webhook artifacts: every redeploy emits a `starting` report ~6 s before the matching `live` report, and the user-facing alert is keyed to the `starting` event. Confirmed by `GET /v1/apps/test` reports log: v1–v6 all show the `starting → live` pair, `lastError: null`, and live HTTP probes return 200 with the current bundle. Not a code or runtime fault; not actionable from this workspace.

## Repo / deployment notes
- Repo slug is `test` → production URL is `https://test.app.easycoder.dev` and will stay there (the slug can't be renamed from this workspace). The "EasyCoder" branding is therefore content-only — the URL is still `test.app.easycoder.dev`.
- The site is a tiny EasyCoder workspace demo (auth + dashboard + notes + admin chart). All rebrand copy reflects that this is an EasyCoder-built sample, not EasyCoder-the-platform itself — matches the *form* of easycoder.dev (eyebrow labels, terminal mockup, "what works today" cards, 3-step "how it works", security pillars, FAQ, closing CTA) with copy about this specific app.