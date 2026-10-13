# Task state

## Done
- Static landing site, auth backend, dashboard v2, persistence-via-DB-only — see git log on `dev`.
- Landing copy refresh on `dev` — 5 wording tweaks in `public/index.html` (hero `h1` + sub, feature 1 `p`, feature 3 `h3`, CTA banner `p`); user wanted a visible diff to watch in the agent view.
- `/data` persistence plumbing: `config.js` already wires `APP_DATA_DIR` → `config.dataDir` and `mkdirSync` creates it on boot (commit `1381de4 Expose APP_DATA_DIR for future local runtime state`). The app has no file-based DB, no upload dir, no local cache — its only DB is the external managed `test-auth-db`, so there was nothing to migrate. Persistence is on at `https://test.app.easycoder.dev` (`dataPersistent:true`).
- Persistence verification + README: added `GET /api/healthz` returning `{ ok:true, dataDir }` (no auth, no DB call — just `config.dataDir`) so we can confirm the published container resolves `/data` without a redeploy cycle, and renamed/retitled the README's existing "Runtime state" section to "Persistence" with tightened wording on `/data` surviving redeploys/restarts/rollbacks and the rule that future local files (uploads, caches) should live under `config.dataDir`. Smoke-tested locally with `APP_DATA_DIR=/tmp/test-data-dir-smoke` → `200 {"ok":true,"dataDir":"/tmp/test-data-dir-smoke"}`; published to `https://test.app.easycoder.dev` (bundleVersion 5, `dataPersistent:true`) and confirmed `GET /api/healthz` → `200 {"ok":true,"dataDir":"/data"}`.

## In progress
- Responsive pass on dashboard + landing for different screen sizes. @Dev.
  - Header nav on `public/index.html` has 5 items (`About / Features / Contact / Sign in-or-Dashboard / Sign out`) at `gap:1.25rem`; on phones ≤ ~420px wide the row overflows or wraps awkwardly. Current `@media (max-width:480px)` only shrinks font to 0.9rem — does not actually fit. Fix: add a nav-wraps-to-second-line (or hamburger) breakpoint, probably around `max-width:640px`.
  - Admin inline-SVG charts (`public/app.js` `renderLineChart`, viewBox `0 0 640 220` + `.chart-label { font-size:11px }` in `public/styles.css`): on a phone the SVG scales to ~280-320px wide and the embedded `<text>` renders at ~5-6px, so y-tick and x-axis MM-DD labels become illegible. Fix: bump `.chart-label` font-size (12-13px in viewBox units), and/or set a `min-width`/`aspect-ratio` floor on `.chart` so it does not collapse below readability.
  - Dashboard 2-col grid (`public/styles.css` `.dashboard-grid` `min-width:768px`): on 768-1024px tablets the 1fr|2fr split gives profile ~220-310px, which is workable; on ≥1280px the notes column gets too wide for reading (no max-width). Add a `max-width` to the dashboard grid container or columns.

## Next
- @Reviewer: code-review the responsive diff on `dev` (correctness + reuse + comment density).
- @Tester: re-verify `https://test.app.easycoder.dev` after Dev lands the fixes — header nav fits at 320/414/768/1024/1440 widths, charts are readable on a 320px viewport, dashboard reads cleanly at 1024+ without lines too long.

## Blocked
- None.