# Task state

## Done
- Static landing site, auth backend, dashboard v2, persistence-via-DB-only — see git log on `dev`.
- Landing copy refresh — 5 wording tweaks in `public/index.html`; landed as `e680031`.
- `/data` persistence plumbing + verification: `GET /api/healthz` returns `{ok:true,dataDir}`; README "Persistence" section; published to `https://test.app.easycoder.dev` with `dataPersistent:true`.
- Responsive pass landed as `903c0d6`: nav `flex-wrap` at ≤640px, `.chart-label` 11→13px, dashboard grid capped at 64rem on ≥1200px.
- Rebrand commit `6f90b0f` on `dev`: landing rebuilt with 10 EasyCoder-style sections; login/register/dashboard HTML title/wordmark/footer refresh (forms unchanged); brand purple accent + new section classes; `package.json`/`README.md` tagline. 7 files, +467/-63. `server.js` / `app.js` / `config.js` / `db/` / `public/api/` untouched.
- Code-review rebrand commit `6f90b0f`: PASS — no findings. Diff stayed client-facing only; no JS/API/DB touched; form input/button ids preserved.
- Code-review dashboard styling `66a172c`: PASS — no findings. Verified responsive rules from `903c0d6` intact (nav wrap @ ≤640px, chart-label 13px, dashboard cap @ ≥1200px, chart 720px cap), `.panel-eyebrow` matches landing `.eyebrow` letter-case/family without duping its pill background, `.note-card` added to reduced-motion list, no form input/button id touches.
- Smoke-check dashboard styling `66a172c`: 6/6 PASS. (a) Notes eyebrow "Personal" + h2 "Notes" in `app.js:322-324`; (b) Admin eyebrow "Workspace" + h2 "Stats" in `app.js:434-436`; (c) `.stat-tile-label` color `var(--accent)` (`styles.css:844-849`) applied to all 4 tile labels; (d) `.admin-section` accent-25 border + soft halo via `color-mix` (`styles.css:823-828`); (e) `.note-card` listed inside `@media (prefers-reduced-motion: reduce)` (`styles.css:1240-1253`); (f) dev-login round-trip: register→logout→login→/api/me→/api/notes→/dashboard.html all 200, cookie auth holds, `id="dashboard-root"` present.
- Dashboard styling refresh landed as `66a172c`: `.panel-eyebrow` above `.section-heading` on Notes + Admin sections, `.section-heading` 1.15→1.25rem + tightened letter-spacing, `.stat-tile-label` accent-tinted + weight 600, `.note-card` hover lift, `.admin-section` accent 25% border + soft halo, `.note-card` added to reduced-motion list. `public/styles.css` (+29) + `public/app.js` (+3/-1) — no form IDs / API / server / db touched.

## In progress
- @PM: publish `dev` → production via the EasyCoder API (commit `66a172c` + the un-publishable rebrand `6f90b0f` still both need to ship — production currently serves the pre-rebrand bundle).

## Next
- @Tester: full live verify of `https://test.app.easycoder.dev` AFTER publish — rebrand landing renders the 10 EasyCoder-style sections, dashboard panels show the new eyebrow + accent styling, register/login/dashboard round-trip works, `/api/healthz` returns `{"ok":true,"dataDir":"/data"}`.

## Blocked
- @PM: publish to production (`https://test.app.easycoder.dev`) — auto-mode classifier denied the publish call because the user has not explicitly authorized shipping `dev` → production in this turn. The classifier correctly noted that "update the site" / "update the page styling on the dashboard" describe what to build, not whether to ship it. **Waiting on explicit user confirmation before publishing.**

## Repo / deployment notes
- Repo slug is `test` → production URL is `https://test.app.easycoder.dev` and will stay there (the slug can't be renamed from this workspace). The "EasyCoder" branding is therefore content-only — the URL is still `test.app.easycoder.dev`.
- The site is a tiny EasyCoder workspace demo (auth + dashboard + notes + admin chart). All rebrand copy reflects that this is an EasyCoder-built sample, not EasyCoder-the-platform itself — matches the *form* of easycoder.dev (eyebrow labels, terminal mockup, "what works today" cards, 3-step "how it works", security pillars, FAQ, closing CTA) with copy about this specific app.