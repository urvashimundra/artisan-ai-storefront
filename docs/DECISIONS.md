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

Full plan: `docs/MODULE1_PLAN.md`. **Migration 001 (`db/migrations/001_owners_sessions_stores.sql`): applied and verified 15 November 2026.**
The migration was applied in the Supabase SQL editor, and all nine verification blocks in `db/verify/001_module1_checks.sql` passed.

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
37. **Logger UUID exemption.** The phone-number scrub matched digit runs inside UUIDs, so about 14% of request log lines
    had a corrupted `correlationId` (it surfaced as a flaky `app.test.js` test). Any string value that is entirely a
    UUID (8-4-4-4-12 hex, case-insensitive) is now exempt from phone scrubbing, in every field and not keyed on field
    names, so client-supplied `X-Request-Id` values that are not UUIDs are still scrubbed. The phone regex is unchanged.
    Known limitation: a UUID embedded in longer text can still be redacted. Tests also gained `waitForLog`, because the
    request logger emits on `finish`, which can run after the client has the response.
38. **Helmet Referrer-Policy and same-origin CSRF.** The browser signup flow exposed a compatibility issue: Helmet's default `Referrer-Policy: no-referrer` caused same-origin browser POST requests in the tested environment to arrive with `Origin: null`. The existing CSRF middleware correctly rejects a literal `Origin: null`. Helmet now explicitly uses `strict-origin-when-cross-origin`. CSRF validation was not weakened. Automated tests cover the response header, acceptance of a same-origin request with its real Origin, rejection of literal `Origin: null`, and rejection of a mismatched Origin. The updated suite passed: 191 tests, successful build, and 191 tests under Node v22.23.5.

39. **Module 1 local browser verification.** On 15 November 2026, the owner flow was manually exercised in the local browser: signup page loaded; invalid invite code, invalid email and invalid password were rejected; successful signup created the account and redirected to login; login succeeded; store creation saved the store name, slug, default language and story; the dashboard displayed the saved store details; refresh preserved the authenticated session; logout succeeded; and a subsequent attempt to open the protected dashboard redirected to login. This records local browser verification only, not GoDaddy Preview or Published verification, and is not a claim of exhaustive security testing.

40. **Client IPs are now logged (reverses the IP part of decision 8).** Request log lines carry `ip` (`req.ip`, resolved
    with `trust proxy`) and `xffHops` (the NUMBER of X-Forwarded-For entries, 0 if absent; the raw header is never
    logged). Why: to verify on GoDaddy how many proxy hops really sit in front of the app, so `TRUST_PROXY` and the
    per-IP rate limits can be set correctly, and to investigate abuse. A client IP is personal data; it is kept in
    server logs only and used for those two purposes. The logger no longer scrubs a string that is entirely a valid IP
    (`node:net` `isIP`, including IPv4-mapped IPv6), because the phone regex was corrupting values like
    103.21.244.10. The phone regex is unchanged, so phone numbers in other fields or in free text are still redacted.

41. **Audit fixes (branch fix-audit-1).**
    - Diagnostics: the SMTP failure `detail` field (`safeDetail`, `describeSmtpFailure`, `redactFirstLine`) is removed;
      failures return only the existing `reason`. This supersedes the `safeDetail` addition described in the Module 0
      diagnostics decision. `DIAGNOSTICS_TOKEN` handling is unchanged.
    - Config: `SUPABASE_URL` must be `https:`. `BASE_URL` must be `https:`, except `http://localhost` and
      `http://127.0.0.1` for local development; other schemes (including `data:`) are rejected. `NODE_ENV` no longer
      fails boot: any string is accepted and unknown values become `production` (only the logger level reads it).
    - Sessions: a successful login deletes the session row for the request's existing cookie token (if any) before the
      new session is issued. A failed login leaves the existing session untouched.


42. **Module 2a: AI budget guard (database + service only; no Claude calls yet).**
    - Money unit is integer micro-USD. Pricing constants live in `src/domain/aiCost.js` (claude-haiku-5-5, verified
      15 Nov 2026: standard 0.10 in / 0.50 out USD per million tokens up to 100,000 input tokens; above that the WHOLE
      request is billed 0.50 / 2.50). RE-VERIFY BEFORE THE DEMO. Arithmetic is BigInt, ceil per side; the reservation
      estimate adds a 130% safety margin (integer math, rounded up). Actuals come only from API `usage` counts.
    - Env: `AI_DAILY_BUDGET_USD`, `AI_DEMO_DAILY_BUDGET_USD`, `AI_GLOBAL_DAILY_BUDGET_USD` are optional (defaults 1.00 /
      0.50 / 5.00), parsed from decimal strings (max 6 decimals), and independent of the ai group. This changes the old
      behaviour where `AI_DAILY_BUDGET_USD` was required once any ai variable was set; `config.ai` no longer has
      `dailyBudgetUsd`, budgets are in `config.aiBudget` (micro-USD). Zero is allowed (disables AI for that class).
    - Migration 002 (`db/migrations/002_ai_budget.sql`), verify `db/verify/002_ai_budget_checks.sql`, manual smoke test
      `db/test/002_budget_smoke.sql`. The budget day is computed in the database (Asia/Kolkata). Lock order everywhere:
      global day row, then owner day row, then reservation row; reserve always locks today's global row first, so
      reservations serialize and cannot deadlock. The stale sweep locks the reservation row only AFTER its global and
      owner rows, to keep that order (a plain lock-first sweep could deadlock with settle).
    - Expired reservations are charged as spent. Settling above the reserved amount records the full actual as spent
      (overshoot is not capped), so a day can end slightly over its limit; later reserves then refuse.
    - Service fails closed: any repository error is `AI_BUDGET_UNAVAILABLE` (503), including the database reason
      `invalid`. An estimate above the owner's whole limit is refused as `AI_BUDGET_EXHAUSTED` before the database call.
      A failed settle leaves the reservation to expire and be charged at the reserved amount (safe direction).
      Reservation TTL is 180 s. The owner-facing message never says which cap was hit.
    - The smoke test ends in a rolled-back sub-transaction (sentinel SQLSTATE AB001), so success displays as a normal
      single result row. Not yet run. Migration 002 applied and verified: 15 November 2026.

43. **Migration 003: reserve_ai_budget sweep order (cross-date deadlock fix).**
    - Scenario: around midnight Asia/Kolkata, `reserve_ai_budget` locks TODAY's global row first, then sweeps expired
      reservations in `ORDER BY usage_date, id` (ascending), locking each stale reservation's global row. Transaction A
      (running just after midnight) holds the new day's global lock and then wants yesterday's; transaction B (running
      just before midnight, or a settle/release path) can hold yesterday's global lock and then want the new day's. The
      two acquire the same pair of date locks in opposite orders, so Postgres can abort one with a deadlock error.
    - Fix: the sweep now uses `ORDER BY usage_date DESC, id`. The current date's lock is always taken first, and older
      dates are then taken newest to oldest, so every `reserve_ai_budget` transaction takes date locks in one consistent
      descending order and two reserves can no longer wait on each other in a cycle. Nothing else in the function changed.
    - Why a new migration: migration 002 is already applied to Supabase and recorded, so editing it would not change the
      deployed function and would make the repo disagree with the database. 003 re-creates the function with
      `CREATE OR REPLACE` (same signature, return type, pinned `search_path`) and re-asserts REVOKE from PUBLIC, anon,
      authenticated and GRANT to service_role only. Verify with `db/verify/003_ai_budget_sweep_order_checks.sql`.
    - Not covered: settle/release lock a single date, so they cannot form a cross-date cycle on their own. Whether
      the fix fully removes deadlocks under real concurrent load has not been tested. Migration 003 applied: verified 15 November 2026
      (developer runs it).

44. **Module 2b, Phase 1: database, pure rules and AI contract (no routes, repositories or Claude calls yet).**
    - Migration 004 (`db/migrations/004_products.sql`), verify `db/verify/004_product_checks.sql`, smoke test
      `db/test/004_product_smoke.sql` (rolled back through sentinel AB001, like 002). Migration 004 applied: verified 15 November 2026
      (developer runs migration, verify, then smoke). Migrations 002 and 003 are untouched.
    - Tables: `products`, `product_translations`, `ai_drafts`. RLS on, no policies, browser roles revoked, service_role only.
      Beyond the brief: `products` has UNIQUE `(id, store_id)` and `product_translations` references that pair, so a
      translation can never carry a different store than its product (the smoke test proves it). `price_paise` is capped
      at 100,000,000 (Rs 1,000,000) in the database as well as in Zod. `products_published_requires_price_check` makes a
      published product without a price impossible. An approved translation must have title, description and alt text
      (`product_translations_approved_complete_check`); a draft translation may be empty while the owner types.
      Length limits count code points (`char_length`; the Zod side uses `codePointLength`), not UTF-16 units.
    - `ai_drafts.target_id` has no foreign key (it points at products, enquiries or orders by `kind`). Drafts survive
      their product being deleted on purpose: they are the audit record of AI spend. They cascade away with the store.
    - Exactly two functions, both `search_path = public, pg_temp`, invoker rights, execute for service_role only, ownership
      checked by `WHERE id = p_product_id AND store_id = p_store_id FOR UPDATE`. A mismatch returns `not_found`, which the
      app maps to 404, never 403.
      `save_ai_listing(p_store_id uuid, p_product_id uuid, p_translations jsonb, p_model text, p_tokens_in int, p_tokens_out int, p_cost bigint)`
      and `save_product_review(p_store_id uuid, p_product_id uuid, p_price_paise bigint, p_translations jsonb, p_approved_langs text[], p_publish boolean)`.
    - Reasons added to the brief's list: `not_draft` (save_ai_listing on a published product; regeneration is drafts only)
      and `invalid` (malformed arguments, as in migration 002). Never reached by normal input because Zod runs first.
    - `save_product_review` runs every gate BEFORE any write, so a refusal changes nothing. Order: invalid, not_found,
      price_required, default_language_not_approved. A published product can never lose its price (`price_required`).
      Source becomes `owner` only when title, description or alt text differs from the stored text; approval flags are set
      exactly from `p_approved_langs` (unlisted languages become unapproved). Saving an already published product does not
      re-run the default-language gate (only an explicit publish does); the owner may un-approve a language on a live
      product. Revisit in Module 3 if the storefront must always show an approved default language.
    - Pure rules: `src/domain/productRules.js` (story, price, translations, review form, request schemas; all `.strict()`),
      `src/domain/imageUpload.js` (4 MB limit, magic bytes, path builder). Story is NFKC-normalised with controls removed
      (newlines kept); titles, descriptions and AI text are NOT NFKC-normalised because that can alter Indic text, and
      zero-width joiners are kept. Price: blank means none, otherwise `toPaise` then Rs 1 to Rs 1,000,000.
    - Image detection also rejects truncated files: JPEG must end with the EOI marker, PNG with the IEND chunk, WebP's RIFF
      size must equal the file length. This is a completeness check, not decoding. A valid JPEG with trailing bytes after
      EOI would be rejected with a friendly message; browser canvas output does not have any.
    - AI contract: `src/ai/schemas/listing.js` (strict Zod output; the tool JSON Schema is generated from it with
      `z.toJSONSchema(..., { io: 'input' })`, so they cannot drift), `src/ai/prompts/listingV1.js` (version `listing-v1`),
      `src/ai/scriptCheck.js`, `src/ai/listingCost.js`. The story is HTML-escaped inside `<artisan_story>` tags so it cannot
      close its own delimiter.
    - Script check: every field needs at least one character of its script and at least half of the language's letters must
      be in it (Gujarati U+0A80-U+0AFF, Devanagari U+0900-U+097F, Latin for English), so a Latin brand name passes but
      Latin text in the Gujarati slot fails. A failure sets `needs_review`. Gujarati written in Devanagari or English
      transliterated into Gujarati script cannot be detected by a script check; the owner review is the control.
    - Cost: output cap 2,500 tokens; image allowance 4,000 (1568 px square is about 3,300); prompt and tool allowance 1,500;
      story at 2 tokens per character (Indic scripts); then `aiCost.estimateMaxCostMicroUsd` with its 130% margin. A full
      1,500-character story reserves 2,730 micro-USD (about 0.0027 USD). Three languages at their maximum length could exceed 2,500
      output tokens; that case ends as invalid output, handled by the one-retry rule, and the prompt asks for short descriptions.
    - Request shape fixed for Phase 2 from the installed `@anthropic-ai/sdk` 1.8.0 typings: `thinking: { type: 'disabled' }`
      and `tool_choice: { type: 'tool', name: 'propose_listing', disable_parallel_tool_use: true }` (forced tool use is not
      permitted together with extended thinking, so thinking is disabled; it also saves output tokens). Image block is
      `{ type: 'image', source: { type: 'base64', media_type, data } }`. **Not yet verified against claude-haiku-5-5**: the
      manual `scripts/smoke-listing.js` run is the first real call.
    - Planned deviations (Phase 2): normal POST, not streamed progress (a single call is capped at 30 s, the page shows an
      `aria-live` message); `ai_drafts` rows for rejected generations are not written (only a valid result is saved).
    - Hardening after SQL review: each submitted language object in `save_ai_listing` and `save_product_review` must have
      exactly `title`, `description` and `alt_text`. The three keys are checked present and string-typed, then the key
      count must be 3, so an extra or renamed key returns `{ok:false, reason:'invalid'}` before any write. Only the two
      function bodies changed; signatures, grants, constraints and transaction logic are as before. Re-run migration 004
      (idempotent `CREATE OR REPLACE`) if the first version was already applied, then verify and smoke test again.

45. **Module 2b, Phase 2: product listing workflow (repositories, services, AI call, routes, pages).** No new dependencies,
    no new environment variables, Migration 004 applied and verified 15 November 2026. Nothing here has been tested as a complete live application workflow against Supabase and Anthropic.
    - **Routes** (owner only, all under the existing guard: no-store, Origin check, session, `requireOwner`, then `loadStore`,
      which resolves the store from the session's owner id): `GET /products`, `GET /products/new`, `POST /products/image`,
      `GET /products/:id/edit`, `POST /products/:id/generate`, `/save`, `/delete`. They are mounted only when `services.products`
      and `services.listings` exist, which composition builds only when the ai group is configured. A malformed id is 404.
    - **Upload.** The browser resizes (longest side 1568 px, JPEG 0.85, canvas re-encode drops EXIF and GPS, EXIF orientation
      applied first, white background for transparent PNG) and POSTs the raw bytes (`express.raw`, 4 MB, after auth and the
      limiter). The server ignores Content-Type and filename and uses the Phase 1 magic-byte check. Order: validate, upload to the
      private bucket at `{storeId}/{productId}/{uuid}.{ext}`, insert the product; any failure removes the object (best effort,
      logged), so a failed upload leaves neither. A product whose owner never clicks generate stays as an empty draft and can be
      deleted. The upload page then posts the story to `/generate` as a normal form POST (a "writing" message with
      `aria-live`; no streaming, as planned in decision 44). `product-generate.js` only disables the button.
    - **Storage.** `imageStorageRepository` takes storeId first and refuses any path outside `{storeId}/{productId}/`. It uses a
      second Supabase client with a 30 s timeout (table calls stay at 8 s). Display uses 5-minute signed URLs. Helmet's CSP now
      adds the Supabase origin to `img-src` only (derived from `SUPABASE_URL`); scripts stay `'self'`. The templates test now
      allows exactly `<script src="/js/NAME.js" defer></script>` and nothing inline.
    - **Form size.** Gujarati URL-encodes at 9 bytes per character, so a three-language form exceeds the global 10 kb form
      limit. The global form parser skips `/products*`, and the product routes parse their own forms (128 kb) after
      authentication. Login and signup keep 10 kb.
    - **Stock and story are not in `save_product_review`**, and Migration 004 was not changed. `updateDetails` writes both in one
      UPDATE (scoped by store and product, which also proves ownership) BEFORE the RPC. If the RPC then refuses (for example
      no price), the story and stock were still saved; that is the owner's own data and the form is shown again with their input.
    - **Generation claim.** One conditional UPDATE sets `ai_status = 'generating'`, `ai_started_at` and the story, only for a
      draft that is not generating or whose run started more than 180 s ago (`STALE_GENERATION_MS`, longer than the worst case of
      photo download plus two 30 s calls). Losing the race gives 409 `GENERATION_IN_PROGRESS` and spends nothing. Published
      products give 409 `NOT_DRAFT`. On failure the state becomes `failed`; when the budget refused (no AI attempted) it returns to
      `idle`. `save_ai_listing` clears it on success. A crashed request therefore blocks the product for at most 3 minutes.
    - **Budget order:** validate story, claim, download photo, then per attempt reserve, call Claude, settle. Reservation failure
      means Claude is never called. Settle uses actual usage through `actualCostMicroUsd`. If the provider answers with an error
      status the reservation is released (nothing billed). On a timeout or network error the outcome is unknown, so the
      reservation is NOT released and expires charged at its reserved amount (decision 42's conservative rule); a response with
      no usable `usage` is treated the same way, and the audit row then records the reserved estimate. A failed settle or release
      is logged with the reservation id and cost and never blocks saving the listing.
    - **Retry.** Output that fails the strict schema (including truncation at max_tokens) is retried once with a fresh
      reservation; a refusal is not retried; timeouts and provider errors are not retried. The `ai_drafts` row records the
      summed tokens and cost of all attempts. After two failures the owner sees `AI_INVALID_OUTPUT` and nothing is saved.
    - **Claude request** (`src/ai/listingGenerator.js`): `maxRetries: 0`, `timeout: 30000` plus a `withTimeout` backstop at 32 s,
      `max_tokens` 2500, `thinking: {type: 'disabled'}`, forced `propose_listing` with `disable_parallel_tool_use`, model from
      `config.ai.model`. These parameters match the installed SDK typings (1.8.0). **Not verified against claude-haiku-5-5**: the
      first live call is the real test. The tool schema has no price, stock, status, approval or store field, and a test checks it.
    - **Script check at display time.** Because `save_ai_listing` has no needs-review column, the edit page recomputes
      `checkListingScripts` for languages whose source is still `ai` and warns per language; owner-edited text is never flagged.
    - **UI.** Generated text is editable and labelled "AI draft, not yet reviewed by you" until the owner ticks "I have read this
      text and approve it" and saves (state is shown with text and border style, not colour alone). Publish is an explicit second
      button, and the page and notices report the status returned by the database, never an assumption. Delete is a two-step
      `<details>` control. The review form carries the stored story in a hidden field because `productReviewSchema` requires it.
    - **Rate limits** (in memory, keyed by owner id after authentication): uploads 30 per hour, generations 15 per hour. The
      database-backed budget remains the real spending control.
    - **Deletion** removes the row first, then the photo. If storage removal fails the delete is still reported as done, the
      orphaned object path is logged, and `photoRemoved: false` is returned. `ai_drafts` rows are kept (decision 44).
    - **Known gaps:** no live Supabase or Anthropic test; no browser test of the upload script (verified by reading and string
      tests only); no needs-review column; abandoned empty drafts are not cleaned up; list page has no photos.

46. 46. **Migration 005: generation fencing token and atomic review (branch module-2b-concurrency).** No new dependencies or environment variables; migrations 001 to 004 and the Module 2a budget code are unchanged. Migration 005 applied and verified 15 November 2026. All checks in `db/verify/005_generation_fencing_checks.sql` passed, and `db/test/005_generation_fencing_smoke.sql` returned `ALL CHECKS PASSED`.
    - **Problem.** Decision 45's claim only stopped two LIVE runs. After the 180 s stale window a second run could re-claim,
      and then the first (slow, not dead) run could still call `save_ai_listing` over the newer result, or end the newer
      run's state. The review route also wrote story and stock in a separate statement BEFORE the RPC, so it could race a
      generation and could leave partial writes when the RPC refused.
    - **Fencing token.** `products.ai_generation_id uuid NULL`. Each successful claim (the same single conditional UPDATE as
      before, issued by `claimGeneration`) stamps a fresh `randomUUID()` and returns it. The token travels through every
      attempt to `save_ai_listing` (new parameter `p_generation_id`, refused with `stale_generation` when missing, stale or
      mismatched, before any write) and to `finishGeneration`, whose UPDATE now also requires `ai_generation_id = token`.
      Success, finish and review all set the token back to NULL. Deleting the product removes the row and with it the token,
      so a late save gets `not_found`. The browser never sees the token (`toProduct` does not map it; only the claim returns it).
    - **Locking.** Both RPCs take `SELECT ... FOR UPDATE` on the product row first and read the token only after the lock is
      granted (READ COMMITTED re-reads the committed row), so they serialise with the claim UPDATE, the finish UPDATE, delete
      and each other. A token check made before the lock would be unsafe; none exists.
    - **Atomic review.** `save_product_review` now takes `p_story` and `p_stock` and does ownership, the active-generation
      check, story/stock/translation/approval/price/publish validation and every write in one transaction. `updateDetails`
      is removed from the repository. Behaviour change: a refused review (for example publish without a price) no longer
      saves the story and stock; the owner's input is still shown again in the form.
    - **Review during generation.** Refused with `{ok:false, reason:'generating'}` (HTTP 409 `GENERATION_IN_PROGRESS`, shown on
      the edit page) while `ai_status = 'generating'`. Deviation from "reject while generating", chosen deliberately: a
      generation that started more than 180 s ago is treated as abandoned, the same rule the claim and the edit page use. The
      review then proceeds and resets `ai_status` to idle and clears the token, which also fences the abandoned run out. Without
      this a crashed request would block manual editing until the owner spent budget regenerating. The 180 s is written in
      the SQL and mirrored in `STALE_GENERATION_MS` (a unit test compares them).
    - **Superseded request.** The stale run's `persist` gets `stale_generation` and throws 409 `GENERATION_SUPERSEDED`. Its
      reservation was already settled, so its cost is kept (it was spent). No `ai_drafts` row is written for it.
    - **Signature changes.** Both functions get new signatures, so migration 005 DROPS the 004 versions (otherwise an un-fenced
      `save_ai_listing` would stay callable). `db/verify/004_product_checks.sql` and `db/test/004_product_smoke.sql` describe the
      old signatures and must be run BEFORE 005 only; the 005 scripts replace them afterwards. Ordering: apply 005 and deploy the
      matching code together; code from before this change calls the dropped signatures and fails closed with a database error.
    - **Known gaps:** nothing was run against a database. The smoke test is single-session and cannot prove lock waits under two
      simultaneous connections; the lock and token logic is argued from the SQL and from the in-memory fakes, which model it.

47. **Module 3, Phase 1: storefront database changes and pure domain modules (branch module-3-storefront).** No new dependencies or environment variables. Migration 006, its verify script and its smoke test are written but NOT yet applied; the developer applies them in the Supabase SQL editor (order: `006_storefront.sql`, `db/verify/006_storefront_checks.sql`, `db/test/006_storefront_smoke.sql`). Record the date here once applied.
    - **Migration 006** adds to `stores`: `tagline` (NOT NULL, default empty, <= 120), `accent_key` (NOT NULL, default `terracotta`, six keys), `whatsapp_number` (NULL, 10 to 15 digits), `whatsapp_enabled` (NOT NULL, default false, CHECK `NOT whatsapp_enabled OR whatsapp_number IS NOT NULL`, so the opt-in cannot exist without a number), `instagram_handle` (NULL, 1 to 30 of letters, digits, dot, underscore) and `upi_id` (NULL, conservative `name@handle`, <= 100). Plus the partial index `products_store_id_published_created_idx ON products (store_id, created_at DESC, id DESC) WHERE status = 'published'`. No functions, tables, RLS or grant changes. Constraints are added inside idempotent `DO` blocks; names are exported from `dbConstraints.js` (`STOREFRONT_CONSTRAINTS`, `STOREFRONT_INDEXES`) and a unit test compares them, the accent keys, the limits and the regexes with the SQL text.
    - **Pure domain modules** in `src/domain`: `contrast` (WCAG ratio), `palette` (six accents plus page colours, tested pair by pair at 4.5:1 for text and 3:1 for the focus outline), `language` (resolver: `?lang`, cookie, `Accept-Language` with q-values, shop default; per-field fallback `pickField`, which uses a language only when approved and non-empty), `publicStrings` (23 strings in en/gu/hi; the Gujarati and Hindi are AI-written and need native proofreading), `seo` (description cut to 160 code points on grapheme boundaries, `?lang` link helper, absolute URLs, head metadata with `noindex` for empty shops), `whatsapp` (normalise to digits with country code, `wa.me` link), `shopSettings` (strict Zod form schema).
    - **UPI and WhatsApp privacy.** `upi_id` is stored for Module 4 and no public code path reads it. The WhatsApp number is only used to build the `wa.me` link destination after opt-in.
    - **Not yet verified:** nothing was run against a database. The SQL regexes (including that `$` does not match before a trailing newline) are argued from the PostgreSQL documentation and checked by the smoke test only when the developer runs it.

48. **Module 3, Phase 2: public storefront (branch module-3-phase-2).** No new dependencies or environment variables. Migration 006 must be applied before deploying this code (the stores repository now selects the new columns).
    - **Read path.** `routes/public.js` -> `publicController` (HTTP only) -> `publicShopService` (pure view-model builders plus orchestration) -> `publicShopRepository` (explicit public columns, `store_id` AND `status = 'published'` on every product query). Public code imports no owner service or session code and never parses the session cookie. Routes: `/s/:slug`, `/s/:slug/p/:productId`, `/s/:slug/p/:productId/image` (302 to a fresh signed URL, `Cache-Control: private, max-age=60`), `/robots.txt`, `/sitemap.xml`. Unknown shop, draft, other shop's product, bad id, reserved or invalid slug all return one identical generic 404 (no correlation id in the body). An uppercase slug gets a 301 to lowercase before any lookup. Products with no displayable approved translation are skipped and logged by IDs only.
    - **Documented exception to the tenancy scan.** `publicShopRepository.listSitemapEntries(limit)` is the ONLY cross-store query. It selects `id, updated_at, stores!inner(slug, updated_at)` for published products and nothing else (no owner id, email, UPI, WhatsApp number). `findShopBySlug` is the other non-store-scoped method: it resolves a validated slug to a store. Both are allowlisted BY NAME in `tests/unit/repositories.test.js` (`NON_STORE_SCOPED_ENTRY_POINTS`); every other method in the file must take `storeId` first, and `tests/unit/publicRepository.test.js` pins the select strings and the two-name list.
    - **Sitemap.** Shops with at least one published product plus those products, absolute URLs from `BASE_URL`, `lastmod` from `updated_at`, ordered by slug then product id, hard cap 5,000 URLs, memoised in a plain module variable for 10 minutes (`resetSitemapCache` exists for tests). Empty shops render `noindex` and stay out. A shop whose only published products have no displayable translation would still be listed (translations are not in the allowlist); accepted, because publishing requires the default language to be approved.
    - **Rate limits.** The public router is mounted after `express.static` and before the global 120/min limiter and any session-loading route. Its own per-IP limiters are in-memory, so they are per process and reset on restart: pages 240/min, image route 600/min (named constants in `routes/public.js`). The public router has its own error handler (friendly page in the visitor's language; status from `AppError`, else 500).
    - **Language.** `?lang` > cookie `lang` > Accept-Language (q-values) > shop default. The cookie is set only for a valid `?lang`: HttpOnly, SameSite=Lax, Path=/, one year, Secure iff `BASE_URL` is https (never from NODE_ENV). Switcher links always carry an explicit `?lang=` (including the default) so a visitor can leave a cookie-selected language; other internal links carry it only when it differs from the shop default. Shop name, tagline and story are not translated, so they carry the shop default language as their `lang`.
    - **Money.** `formatInr(paise, { omitZeroFraction })` is backward compatible; the public pages pass `true` (`₹1,25,000`, `₹125.50`). Owner pages are unchanged.
    - **Branding and accessibility.** Six accents via `theme-<key>` classes (no inline style); a test checks that every colour in `public.css` is a palette value and that each pair meets 4.5:1 (text) or 3:1 (focus outline, which sits on the page background because of its offset). Fonts use `unicode-range` and `font-display: swap`; the two woff2 files are added by the developer. The share button is `hidden` in the HTML and shown by `share.js` (about 2 KB), so browsing works without JavaScript. Two layout files (`layout.ejs`, `layout-end.ejs`) are used because the template guard forbids `<%- body %>`.
    - **WhatsApp, Instagram, UPI.** The WhatsApp number is selected only to build the `wa.me` link after opt-in; view models carry the link, never the number. UPI is stored for Module 4 and no public code path selects it. Every external link has `rel="noopener noreferrer"`.
    - **Owner settings.** `GET/POST /store/settings` behind the same guard stack as products (no-store, Origin check, session, `requireOwner`, `loadStore`). One strict Zod schema; the store is resolved from the session's owner id and updated by one `UPDATE ... WHERE id = storeId`; a `store_id` in the body is rejected (400). No new database function. The dashboard gains View your shop, Copy shop link and Shop settings.
    - **Not built (follow-ups):** page and slug caches, ETag/304, signed-URL cache, cache invalidation, asset fingerprinting, pagination beyond 48, size-budget tests, hreflang, compression, thumbnails, JSON-LD, logo upload, analytics, search.
    - **Not verified:** real browser rendering (layout, Gujarati and Hindi glyphs, 200% zoom, 320 px width), WhatsApp and Instagram link previews (crawlers must follow the image route's 302), real Supabase signed URLs and the `stores!inner` embed, the SQL itself, and the Gujarati and Hindi proofreading.

49. **Module 3 polish: translated shop text, owner links, input style, grid and photo size (branch module-3-polish).** No new dependencies or environment variables. Migration 007 is written but NOT applied; the developer applies it in the Supabase SQL editor (order: `007_store_translations.sql`, `db/verify/007_store_translations_checks.sql`, `db/test/007_store_translations_smoke.sql`) BEFORE deploying this code, because the public shop now reads `store_translations`. Record the date here once applied.
    - **Input style.** The WhatsApp field is `type="tel"`, which the shared input selector in `public/css/app.css` did not list, so it fell back to the browser default. `input[type="tel"]` is now in the selector. A test reads every input type in `shop-settings.ejs` and requires it to be in the shared selector (checkbox, hidden, submit and file are deliberately unstyled).
    - **Owner links open in a new tab.** Public pages stay identical for every visitor (no owner bar, no session read). Owner-side links to `/s/...` (dashboard, and a new "View your shop" link on Shop settings) use `target="_blank" rel="noopener noreferrer"`; "Back to dashboard" stays. There is no per-product "view" link in the owner pages today, so none was added. Tests scan owner templates for the attributes and public templates for owner links.
    - **Migration 007** adds `store_translations (store_id, language, tagline, story, source, approved, updated_at)`, primary key `(store_id, language)`, FK to `stores` with ON DELETE CASCADE, CHECKs on language, tagline <= 120, story <= 2000 (same maximum as `stores.story`) and source (`owner`/`ai`); named constants in `dbConstraints.STORE_TRANSLATION_CONSTRAINTS`; RLS on, no policies, browser roles revoked, service_role only; no functions. The default language's tagline and story stay in `stores`; the service rejects saving a row for the default language and the public read path overrides any such row with the `stores` text. `source` has no default on purpose (the app always states it).
    - **Owner flow.** Shop settings shows the default text and, per other language, an editable tagline, story and Approve checkbox. Saving one language is one upsert (`upsertMany`, `onConflict store_id,language`) with the store from the session (`req.store`); a `store_id` in the form is rejected by the strict schema. Text left unchanged keeps its source (approving an AI draft keeps `ai`); any edit makes it `owner`. These forms are parsed after authentication with the 128 kb limit (Gujarati is 9 bytes per character URL-encoded), so `/store/settings/translations` joins `/products` in skipping the global 10 kb parser.
    - **Draft translations with Claude.** One button, one call for both target languages (`POST /store/settings/translations/draft`, owner only, 10 per hour per owner, mounted only when the ai group is configured; saving by hand always works). Only the tagline and story are sent (escaped inside `<shop_tagline>` and `<shop_story>` tags and treated as data); never the shop name or any private field. Prompt `store-translation-v1` in `src/ai/prompts/translationV1.js`, strict Zod schema built per target pair in `src/ai/schemas/translation.js` (the tool JSON Schema is derived from it), model from `CLAUDE_MODEL`, `thinking` disabled, forced tool, `maxRetries 0`, 45 s call timeout plus a 2 s backstop (under 60 s), output cap 6,000 tokens. Output that fails the schema (including truncation) is retried once with a fresh reservation; a refusal is not retried; then the owner sees `AI_INVALID_OUTPUT` on the page and nothing is saved. Drafts are saved `approved=false`, `source='ai'`, and replace the owner's text for those two languages (the button's hint says so). An empty source tagline stays empty whatever the model returns. Logs carry model, prompt version, tokens and cost only. No script-of-language check is applied to these drafts (unlike product listings); the owner's review before approval is the control.
    - **Budget.** Same three-limit guard as Module 2 (reserve before the call, settle on real usage, release only when the provider answered with an error status, otherwise the reservation expires charged), now in `src/services/budgetedCall.js`, which the new service uses. `listingService.js` keeps its own copy of that protocol untouched, to avoid a drive-by refactor of working, tested code; folding it onto `budgetedCall` is a follow-up. The estimate is 1,000 prompt tokens plus 2 tokens per source character plus the full 6,000 output cap, with the 130% margin (about 0.005 USD worst case). `composition.js` builds the budget service once (`buildBudgets`) for both AI workflows.
    - **Fail-closed on default-text edits.** When the default-language tagline changes, `storeService.updateSettings` first sets `approved=false` on all of that store's translation rows and only then updates `stores`; if the first step fails, the update does not happen. The story cannot be edited anywhere in the owner UI today (it is set when the store is created); when story editing is added it must go through the same path.
    - **Public output.** `pickShopTexts` chooses tagline and story per field with the existing `pickField` rule (approved, non-empty translation for the visitor's language, else the shop default; the returned language becomes the `lang` attribute). It feeds the hero, the story section, the shop page `og:description`, and the product page "About the maker" excerpt (300 code points including the ellipsis) and its `lang`. The shop name is never translated and keeps the shop default as its `lang`. `publicShopRepository.listStoreTranslations(storeId)` selects `language, tagline, story, approved` with `approved = true`, explicit columns only; it is not called when the visitor's language is the shop default. The `source` column is never selected publicly.
    - **Grid and cap.** `.grid` is `repeat(auto-fill, minmax(min(100%, var(--card-min)), 1fr))` with `--card-min` 8 rem, 11 rem from 40 em and 13 rem from 60 em (two columns at 320 px, about three at 768 px and four at 1280 px), `min-width: 0` on grid items and cards, `overflow-wrap: anywhere` on titles, and the square image box keeps rows equal. The product photo has a 1 rem gap below it. The repository fetches 49 products (`PUBLIC_PRODUCT_FETCH_LIMIT`), the service renders `MAX_PUBLIC_PRODUCTS` (48, in `storeRules.js`) and the page shows the new string `showingFirstProducts` ("Showing the first 48 products") in en/gu/hi when more exist. The cap is counted after products without a displayable translation are skipped, so the note appears only when a 49th displayable product was fetched. The Gujarati and Hindi text is AI-written and needs proofreading like the rest.
    - **Browser photo resize.** The upload page already resized inline (1568 px, JPEG 0.85, decision 45). That code moved into `public/js/resize.js` (global `ArtisanResize`, `module.exports` behind a `typeof module` guard, pure `fitWithin`), now 1200 px on the long side, JPEG 0.82, `createImageBitmap` with `imageOrientation: 'from-image'`, white background, EXIF and GPS dropped. `product-upload.js` uses it and uploads the original file unchanged when `resize.js` is missing or any step fails (it still checks the 4 MB limit, and the server still validates type, size, content and ownership and ignores the client's Content-Type). The upload still needs JavaScript (unchanged from decision 45: the page shows a `noscript` notice). This supersedes the 1568 px / 0.85 values in decision 45 for new uploads; earlier photos stay as they are, and the reservation image allowance in `listingCost.js` stays at 4,000 tokens because those photos can be up to 1568 px.
    - **Not built (as instructed):** shop-name translation, server-side thumbnails, pagination, caches, visual redesign, deleting or migrating existing photos.
    - **Not verified:** the SQL (no execution), real Claude output quality and `claude-haiku-5-5` acceptance of the request shape (all AI tests use fakes), real browser rendering of the grid and the settings page, the canvas resize in real browsers, WhatsApp link previews, and the Gujarati and Hindi text.
    - **Follow-up changes (same branch).**
      - Story editing: Shop settings now edits the default-language story (strict schema, 1 to 2000 code points like `stores.story`, line breaks kept; required in the form). It goes through the same path as the tagline: if tagline or story changed, `unapproveAll` first, then one `UPDATE stores ... WHERE id = storeId`. `POST /store/settings` now skips the global 10 kb parser and uses the 128 kb one after authentication (a Gujarati story is about 18 kb encoded).
      - Drafts never replace approved owner text: a language whose row is `source='owner'` and `approved=true` is skipped. If every other language is protected, no budget is reserved and no AI call is made. The owner sees which language was skipped (via a validated `skipped` query value). The rows are re-read just before saving, which narrows, but cannot fully close, the window where the owner approves text during the AI call (no database function or conditional upsert was added); an unapproved owner draft and any AI draft are still replaced.
      - Public fallback: if reading `store_translations` fails, the shop and product pages render the default-language text and log a warning with `storeId` and `language` only; a failure of the shop lookup itself still returns the error page.
      - Flaky product tests: the cause was not reproduced (30 isolated runs, 15 full runs, 20 loaded full runs, 40 concurrent runs of the file, all green), so no root cause is claimed. The only time-dependent paths in that test were the real clock read by the product service, listing service, session service and the product fake; the test now injects one fixed clock into all of them. Rate limiters and the budget fake are created per test, and each test file runs in its own process, so there was no shared state to reset. No production code was changed for this.
