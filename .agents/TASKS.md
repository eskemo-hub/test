# Task state

## Done
- Static landing site, auth backend, dashboard v2, persistence-via-DB-only — see git log on `dev`.
- Landing copy refresh — 5 wording tweaks in `public/index.html` (hero `h1` + sub, feature 1 `p`, feature 3 `h3`, CTA banner `p`); landed as `e680031` "Landing copy: hero + features + CTA wording refresh" so it stays a clean, reviewable change separate from the responsive diff.
- `/data` persistence plumbing: `config.js` already wires `APP_DATA_DIR` → `config.dataDir` and `mkdirSync` creates it on boot (commit `1381de4 Expose APP_DATA_DIR for future local runtime state`). The app has no file-based DB, no upload dir, no local cache — its only DB is the external managed `test-auth-db`, so there was nothing to migrate. Persistence is on at `https://test.app.easycoder.dev` (`dataPersistent:true`).
- Persistence verification + README: added `GET /api/healthz` returning `{ ok:true, dataDir }` (no auth, no DB call — just `config.dataDir`) so we can confirm the published container resolves `/data` without a redeploy cycle, and renamed/retitled the README's existing "Runtime state" section to "Persistence" with tightened wording on `/data` surviving redeploys/restarts/rollbacks and the rule that future local files (uploads, caches) should live under `config.dataDir`. Smoke-tested locally with `APP_DATA_DIR=/tmp/test-data-dir-smoke` → `200 {"ok":true,"dataDir":"/tmp/test-data-dir-smoke"}`; published to `https://test.app.easycoder.dev` (bundleVersion 5, `dataPersistent:true`) and confirmed `GET /api/healthz` → `200 {"ok":true,"dataDir":"/data"}`.
- Responsive pass landed on `dev` as `903c0d6`: nav `flex-wrap` at ≤640px (5-item nav now wraps instead of overflowing), `.chart-label` font 11→13px with `.chart max-width:720px / margin-inline:auto` (legible on phones, capped on wide desktops), dashboard grid capped at 64rem on ≥1200px via `@media (min-width:1200px)` (notes column no longer runs >700px wide on 1280p+). Two commits total: `e680031` landing copy, then `903c0d6` responsive CSS. Responsive commit touches `public/styles.css` only (+24/-3); `app.js` untouched.

## In progress
- None.

## Next
- @Reviewer: code-review the responsive diff on `dev` (commit `903c0d6`) — correctness of the two new media queries, comment density matches surrounding CSS, no `app.js` touched.
- @Tester: re-verify `https://test.app.easycoder.dev` after Dev lands the fixes — header nav fits at 320/414/768/1024/1440 widths, charts are readable on a 320px viewport, dashboard reads cleanly at 1024+ without lines too long.

## Blocked
- None.