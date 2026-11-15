# Module 1 plan (approved)

Branch `module-1-auth`. CLAUDE.md and SPEC.md stay authoritative. This file lets a fresh session resume.
Approved decisions: `ejs` added; Supabase required at boot; `BUSY` uppercase; demo slug `demo-shop`; static
before the global limiter; `/login?registered=1`; Supabase client extracted from the probe.

## Files
- Modify: `src/app.js`, `src/composition.js`, `src/server.js`, `src/config/env.js`, `src/middleware/errorHandler.js`,
  `src/middleware/rateLimit.js` (option passthrough), `src/lib/errors.js` (`busy`), `src/repositories/supabaseProbe.js`
  (uses the shared client factory), `tests/helpers/testApp.js`, `tests/unit/env.test.js`, `.env.example`,
  `docs/DECISIONS.md`, `package.json` (`ejs` only).
- Create: `db/migrations/001_owners_sessions_stores.sql`, `db/verify/001_module1_checks.sql`,
  `scripts/seed-demo.js`, `public/css/app.css`, `src/lib/{cookies,password}.js`,
  `src/domain/{dbConstraints,credentialRules,storeRules}.js`,
  `src/repositories/{supabaseClient,pgErrors,requireStoreId,ownerRepository,sessionRepository,storeRepository}.js`,
  `src/services/{authService,sessionService,storeService}.js`,
  `src/middleware/{originCheck,loadSession,authRateLimits}.js`,
  `src/controllers/{authController,storeController}.js`, `src/routes/browser.js`, `src/views/*.ejs`.
- Merges: origin rules live in `originCheck.js`/`env.js`; tokens in `sessionService.js`; `requireOwner` in
  `loadSession.js`; `noStore` inline in the router; owner logic in `authService.js`; dashboard in `storeController.js`.

## Migration (001)
`owners` (unique index `owners_email_lower_key` on `lower(email)`), `sessions` (`sessions_token_hash_key`,
index on `expires_at`), `stores` (`stores_owner_id_key`, `stores_slug_key`, slug regex CHECK, reserved-slug CHECK
`stores_slug_not_reserved`, language CHECK). RLS on, no policies, anon/authenticated revoked, service_role granted.
No functions, no triggers. Rollback is commented DROPs at the bottom, never executed.

## Endpoints
GET/POST `/signup` (404 when `SIGNUP_INVITE_CODE` unset), GET/POST `/login`, POST `/logout`, GET `/dashboard`,
GET/POST `/store/new`. POST success is 303. No `next` parameter. Authenticated and auth responses are `no-store`.
Signup order: invite check (generic 403, no owners access) -> strict parse -> email pre-check (409) -> hash ->
insert (23505 on `owners_email_lower_key` also 409) -> 303 `/login?registered=1`. `is_demo` is always false.
Login failures (bad input, unknown email, wrong password) share one 401 response; unknown email verifies a dummy hash.

## Middleware order
correlationId, helmet, trust proxy, json, urlencoded (10kb), requestLogger, static, global limiter, health, internal,
browser routes (per route: noStore, originCheck, loadSession, limiters, requireOwner, controller), notFound,
errorHandler. Guards are per route so unmatched paths keep their 404.
Failed-login limiter key: IP + SHA-256(email), counts only 401. Per-IP login and signup limiters key on IP only.

## Scrypt
N=2^15, r=8, p=1, 64-byte key, 16-byte salt, `maxmem` 64 MiB. Queue: 2 running, depth 20, 5 s wait, FIFO, then 503
`BUSY` with `Retry-After`. Dummy hash computed once during async startup, same parameters, same queue.

## Environment
Required: `NODE_ENV`, `BASE_URL`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`. Optional: `SIGNUP_INVITE_CODE` (16+),
`ALLOWED_ORIGINS` (bare origins). Seed-only: `DEMO_OWNER_EMAIL`, `DEMO_OWNER_PASSWORD`.
Cookie name and Secure derive from the `BASE_URL` protocol, never from `NODE_ENV`.

## Commits
0 plan | 1 migration + verify | 2 libs + domain | 3 repositories, services, env | 4 middleware, error rendering, ejs |
5 routes, controllers, views, css | 6 seed, docs. After each: `npm test`, append a progress line below (the line is
committed with the next commit; the last goes in a final docs commit).

## Progress
- Commit 1 (migration + verify): npm test green, 54 tests. SQL not executed (developer applies it).
- Commit 2 (libs + domain): npm test green. Password, queue, cookies, rules covered by unit tests.
- Commit 3 (repositories, services, env): npm test green, 119 tests. Supabase now required at boot; client factory extracted from the probe.
- Commit 4 (middleware, error rendering, ejs): npm test green, 136 tests. ejs ^7.0.2 added; npm audit: 0 vulnerabilities. Error pages are HTML only when the client prefers text/html (JSON for /api, /internal, /health).
- Commit 5 (routes, controllers, views): npm test green, 170 tests. Added src/controllers/formErrors.js (shared form helper, not in the original file list). Origin check runs before session lookup.
- Commit 6 (seed, env, decisions): npm test green, 180 tests; also green under Node v22.23.5 (npx -y node@22 --test); npm run build ok. Remaining: developer applies migration 001, runs db/verify, manual checks, then records the migration date in docs/DECISIONS.md.
