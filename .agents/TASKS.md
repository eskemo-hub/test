# Task state

## Done
- Built a basic static landing site for the `test` repo (single page, no build tooling) — `index.html` + `styles.css` on `dev` branch. @Dev.
- Provisioned new `test-auth-db` postgres database via EasyCoder API (status: live). @PM.
- Built Node/Express backend with register/login/logout/me endpoints against `test-auth-db`, plus login + register + dashboard HTML pages wired to the API. Existing landing page preserved (now served from `public/`) with nav that flips between "Sign in" and "Dashboard / Sign out". Smoke-tested locally: register, /api/me, duplicate-email 409, bad-password 401 (generic), validation 400s, logout 204, post-logout /api/me 401. @Dev.

## Next
- @PM: publish to https://test.app.easycoder.dev once the build looks good.

## Blocked
- _none_