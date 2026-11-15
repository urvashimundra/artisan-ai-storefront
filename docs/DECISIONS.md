# Decisions

Records choices made while building, including assumptions. CLAUDE.md and SPEC.md remain the source of truth.

## Module 0: Foundation

1. **Node engine `>=26`.** Set from the local Node major (26.13.0). **Unconfirmed against GoDaddy**; confirm the
   supported Node version before deploying and adjust `engines`.
2. **Express 5, Zod 4, Helmet 8, express-rate-limit 8, Nodemailer 10, supabase-js 2, @anthropic-ai/sdk 1** (latest
   at install time). Only packages from the fixed stack were added. Express 5 forwards rejected async handlers to
   the error handler, so controllers need no try/catch wrappers.
3. **Env groups.** `pickPresent` treats blank/whitespace values as unset. A group is "started" if any member is set
   (including `CLAUDE_MODEL`, even though it has a default). Env errors list variable names only, never values;
   Zod issue messages are discarded. `NODE_ENV` is restricted to development | test | production.
4. **No `LOG_LEVEL` variable** (not in the specified env list). Logger level is `silent` when `NODE_ENV=test`,
   otherwise `info`. Add a variable later if needed.
5. **Middleware order** follows the brief. `trust proxy` is set before the limiter so the limiter keys on the client
   IP from `X-Forwarded-For`. The default hop count is 1 (**confirm against GoDaddy's proxy chain**: too low keys all
   clients to the proxy IP; too high lets clients spoof their IP).
6. **Global rate limit 120 requests/minute per IP** (in-memory). `/health` is included. GoDaddy limits are
   undocumented, so this is a conservative placeholder. The in-memory store resets on restart and is per instance.
7. **Error response** is `{ error: { code, message, correlationId } }`. Validation errors additionally carry
   `details: [{ path, code }]` (field paths and Zod issue codes only, never values) so clients can fix input.
   `AppError.details` is for logs only. Body-parser errors map to 400 `INVALID_JSON` and 413 `PAYLOAD_TOO_LARGE`.
8. **Logger redaction** is key-based (password, token, authorization, api key, secret, cookie, phone, mobile,
   customer message, and the exact keys `message` and `body`) plus value scrubbing of phone-like digit runs and
   `Bearer` tokens in strings. Request logs omit query strings, bodies and client IPs. Unexpected 500s log the
   error name, code, scrubbed message and stack (server-side only).
9. **Money.** `toPaise` accepts a number or string, converts via decimal-string parsing and BigInt (no float
   arithmetic), and rejects anything outside `^\d+(\.\d{1,2})?$` or above `MAX_SAFE_INTEGER` paise. Exponent forms
   such as `1e3` are rejected. `formatInr` uses Indian digit grouping implemented by hand (no dependency on ICU
   data) and always prints two decimals. Both throw `AppError('INVALID_AMOUNT', 400)`.
10. **Diagnostics layering.** Probes live in `src/repositories` (Supabase), `src/ai` (Claude) and `src/email` (SMTP),
    are injected into `src/services/diagnosticsService.js`, and are wired in `src/composition.js`. Timeouts:
    Supabase 8 s, SMTP 10 s, Claude 15 s, each enforced twice (client option plus `withTimeout`).
11. **Diagnostics results** contain only name, ok, duration and a safe `reason` (error `code` or class name matching
    `[A-Za-z0-9_]{1,40}`, else `Error`). Provider messages and bodies are never returned. The endpoint answers
    HTTP 200 with `ok: false` when a check fails (not 503) so platform error pages cannot hide the body.
    Unconfigured groups report `not_configured`.
12. **Diagnostics access.** Order: 404 if token unset -> rate limit (5/min) -> token check (401) -> run. Rate limiting
    precedes the token check so guessing is throttled. Token comparison hashes both values with SHA-256 and uses
    `timingSafeEqual`. Query is `.strict()`; `?checks=` accepts a comma list of `supabase`, `smtp-verify`, `claude`.
13. **SMTP transport.** `secure` only for port 465; other ports require STARTTLS (`requireTLS`). The transport is
    created per call and closed afterwards. `sendTest` is reachable only from `scripts/smoke.js --send-test`.
14. **Smoke script** is run as `node --env-file=.env scripts/smoke.js [--send-test]`. It needs the three required
    boot variables plus whichever groups you want checked. No npm script alias was added (brief fixed the scripts).
15. **Graceful shutdown** (`src/lib/shutdown.js`): stop accepting, close idle connections, force exit 1 after
    `SHUTDOWN_TIMEOUT_MS` (10 s, timer unref'd). Idempotent across repeated signals.
16. **Health version** is read from package.json once per app creation.
17. **Deploy ZIP script** is listed under SPEC Module 0 but not in this brief; not built here (see known gaps).
18. **SMTP failure detail.** On GoDaddy Preview `smtp-verify` failed with `ESOCKET` in ~29 ms while the same
    credentials pass locally, so `reason` alone is not enough. The SMTP probe now attaches `safeDetail` to the thrown
    error and the diagnostics service returns it as `detail`: `code`, `errno`, `syscall`, `address`, `port`, `secure`
    (true only for port 465) and `message`. `message` is the first line only, capped at 200 chars, with the configured
    user and password (plain, base64 and the base64 AUTH PLAIN blob) replaced by `[redacted]`. String fields must match
    `[A-Za-z0-9_.:-]{1,255}` or are omitted. Other probes still return only `reason`. This relaxes decision 11 for
    SMTP only; the endpoint stays token-gated and rate limited. Redaction is exact-match, so remove this detail once
    the Preview issue is diagnosed.
19. **Root health route.** The GoDaddy platform probes `GET /`, which previously hit the JSON 404 and marked Preview
    "Unhealthy" (Publish disabled). `GET /` now returns 200 `{ "name": "The Artisan Story", "status": "ok" }` via
    route -> controller (`rootController`), no external calls, behind the standard middleware. The global limiter
    (120 requests/min per client IP) is unchanged; see the task report for the shared-IP caveat.

## Module 1: Owner access and store setup

Full plan: `docs/MODULE1_PLAN.md`. **Migration 001 (`db/migrations/001_owners_sessions_stores.sql`): NOT yet applied.**
The developer applies it in the Supabase SQL editor, runs `db/verify/001_module1_checks.sql`, and records the date here.

20. **Password hash is one encoded string, not a salt column.** `owners.password_hash` holds
    `scrypt$N$r$p$saltB64$hashB64` (SPEC section 4 also says "encoded scrypt string including salt", so there is no
    separate salt column). Parameters travel with the hash so they can be raised later; old hashes still verify.
    Parameters: N=2^15, r=8, p=1, 64-byte key, 16-byte random salt per user. `maxmem` is 64 MiB: scrypt needs about
    `128 * N * r` = 32 MiB, which equals Node's default limit exactly (so the default fails), so it is set to twice
    the requirement. Parsing rejects malformed strings, non-canonical base64, N not a power of two or above 2^20,
    r above 32, p above 16, and odd salt or key lengths. Verification uses `timingSafeEqual` after equal-length checks.
    Passwords are NFKC-normalized, then limited to 12 to 128 characters AFTER normalization (a raw cap of 1024 first
    bounds the normalization work). Time one hash at the real parameters with:
    `node -e "const c=require('node:crypto');const t=process.hrtime.bigint();c.scrypt('x','0123456789abcdef',64,{N:32768,r:8,p:1,maxmem:67108864},e=>{if(e)throw e;console.log((Number(process.hrtime.bigint()-t)/1e6).toFixed(1),'ms')})"`
    (about 120 ms on the development laptop; measure on the host before the demo).
21. **Bounded scrypt queue** (`src/lib/password.js`): 2 running, queue depth 20, 5 s maximum wait, FIFO. When slots and
    queue are full, or a queued job waits too long, the request fails with 503 `BUSY` and `Retry-After: 5`
    (HTML page or JSON). Hashing is never skipped or shortened. A slot is released when hashing throws. BUSY does not
    count as a failed login. Worst-case scrypt memory is 2 x 64 MiB `maxmem` = 128 MiB ceiling (about 2 x 32 MiB
    actually used). Not measured on GoDaddy.
22. **Dummy hash** is computed once at startup, with the real parameters and through the same queue, by the async
    `createPasswordService`. `buildDependencies` is async and `server.js` awaits it before `listen`. Unknown-email logins
    verify against that stored string. Malformed login input (bad email format) returns the same 401 without hashing;
    that path does not depend on whether an account exists.
23. **Sessions.** 32 random bytes, base64url; only the SHA-256 (hex) is stored. Absolute 7 day expiry, no sliding
    renewal. New token on every login, which also deletes that owner's expired sessions. An expired row found during
    lookup is deleted. Expired rows of owners who never return stay until the owner logs in (no cleanup job).
24. **Cookie security derives from `BASE_URL`, never `NODE_ENV`** (GoDaddy sets NODE_ENV itself): an https `BASE_URL`
    gives `__Host-session` with Secure; anything else gives plain `session` (local http only). Always HttpOnly,
    SameSite=Lax, Path=/, Max-Age 7 days, never a Domain attribute. `NODE_ENV` is now only used for the logger level.
25. **Origin check** applies to every POST, PUT, PATCH and DELETE on the browser routes, against the `BASE_URL` origin
    plus `ALLOWED_ORIGINS` (validated at boot as bare origins). No Origin means `Sec-Fetch-Site: same-origin` is
    required. Forwarded headers and Host are never used. The guard is per route (not router-wide) so unmatched paths
    keep their 404, and it runs before the session lookup so cross-site requests cost no database call. It does not
    cover `/internal` (token protected, GET only); future `/api` routes must add the same check.
26. **Signup.** Order: invite code (SHA-256 digests, `timingSafeEqual`), then strict parse, then email pre-check, then
    insert. A wrong invite code is one generic 403 and never touches `owners`. **Disclosure:** "email already
    registered" (409) is reachable only after a valid invite code; this is a deliberate, documented disclosure. The
    race between pre-check and insert is closed by mapping Postgres 23505 on `owners_email_lower_key` to the same 409.
    With no `SIGNUP_INVITE_CODE`, the signup routes are not mounted (normal 404).
27. **Constraint detection.** supabase-js returns `{ code, message, details }`. A unique violation is `code '23505'`
    with the constraint or index name quoted in `message` (`... unique constraint "owners_email_lower_key"`). Only
    `message` is read; `details` holds the offending values (for example the email) and is never read or logged.
    Names live in `src/domain/dbConstraints.js`. **This error shape is an assumption until exercised against the real
    project.** An unrecognized 23505 becomes a generic 500.
28. **Rate limits are in-memory** (express-rate-limit default store): per process, reset on restart, not shared across
    instances. Failed login: 5 per 15 min per IP + SHA-256(email), counting only 401 responses. Per-IP login: 30 per
    15 min. Signup: 10 per hour per IP. No limiter is keyed on email alone, so nobody can lock out the demo account.
    Client IP depends on `TRUST_PROXY` being right for GoDaddy (see decision 5); IPv6 clients are grouped by subnet.
29. **Error rendering.** The central handler renders HTML only when the client prefers `text/html` and the path is
    not `/api`, `/internal` or `/health`; otherwise JSON. This keeps every Module 0 JSON response unchanged while
    browsers get pages. Both formats carry the correlation id and the same generic messages. If the view fails to
    render, the handler falls back to JSON. A browser-only path rule (the first plan) was rejected because it would
    have changed Module 0 behaviour for `/`, `/health` and unknown routes.
30. **Static files** (`public/`) are served before the global limiter so CSS requests do not use the 120/min budget.
    Helmet's default CSP is unchanged; the app uses one external stylesheet and no inline script or style.
31. **Tenancy.** Owners and sessions are keyed by owner id; the store is always found by the session's owner id.
    `store_id` is never read from a request. Store-scoped tables added later must take `storeId` first and call
    `requireStoreId`; a source-scan test fails for any new repository that does not.
32. **Migration details.** Beyond the brief: `owners` email length and lowercase CHECKs (so equality lookups on the
    lowercased email are safe), name and story length CHECKs, `stores_slug_not_reserved` (a unit test compares its list
    with `RESERVED_SLUGS`), an index on `sessions.owner_id`. No functions or triggers. `stores.updated_at` has no
    update path yet; the repository will set it when updating is added.
33. **Seed script** (`scripts/seed-demo.js`): never runs on import; reads `DEMO_OWNER_*` itself (not part of boot env);
    validates with the signup policy; uses the normal hashing and store services; creates `demo-shop`; never changes an
    existing demo owner's password; aborts without writes if the email belongs to a non-demo owner; prints no
    credentials. `isDemo: true` is passed only by this script; signup hard-codes false and no controller references it.
34. **Supabase client.** The probe's private `buildClient` moved unchanged to `src/repositories/supabaseClient.js`
    (no session persistence, 8 s timeout). The probe and all repositories use it.
35. **Dependencies.** Added `ejs` (^7.0.2, latest stable). `npm audit`: 0 vulnerabilities at install time.
36. **Known limits (SPEC):** no email verification, no password reset, in-memory limits, no session cleanup job.
