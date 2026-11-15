# PROJECT: Artisan AI Storefront & Business Assistant
Hackathon: GoDaddy Inclusive Innovation Hackathon 2026, Round 2. Solo build. Submission by 20 Nov 2026.
Full requirements, data model and modules live in SPEC.md. This file holds standing rules.

## Product
Artisans (English / Gujarati / Hindi) upload product photos plus a short story. The app creates an
accessible multilingual storefront at /s/:slug on their own domain. Customers send enquiries or order
requests. The owner reviews AI drafts and approves. AI never performs a consequential action alone.

## Engineering rule (never violate)
Claude proposes and explains. The backend validates and executes deterministic business operations.
The owner approves consequential actions. The database is the source of truth.

## Fixed stack (do not change or add without asking)
Node.js 22 (engines "22.x") + Express (ES modules), EJS + vanilla JS, Supabase Cloud (Postgres +
Storage) via supabase-js over HTTPS, Claude via official @anthropic-ai/sdk, Nodemailer for email
transport, Zod, Helmet, express-rate-limit, node:test. Hosting: GoDaddy Node.js hosting; bind to
process.env.PORT. Supabase is NOT hosted on GoDaddy; the app calls it over HTTPS.
Outbound SMTP is BLOCKED from the GoDaddy hosting (Preview and Publish): email goes through the
swappable transport in src/email (smtp or api), chosen by EMAIL_TRANSPORT. Do not assume SMTP works
when deployed. Adding an HTTPS email provider needs explicit approval.
Default model: claude-haiku-5-5 (validated). Use a larger model only where quality clearly needs it.

## Validated on GoDaddy (tested, can rely on)
- Express runs and binds to process.env.PORT; /health and / respond; Preview and Publish are healthy.
- ~90 s requests complete; streaming responses arrive progressively.
- Supabase over HTTPS: Postgres read/write and private Storage upload work.
- Claude API from the backend works (claude-haiku-5-5), usage returned.
- SMTP credentials work from a local machine (ports 465 and 587) but the hosted app gets
  `connect EACCES`, so SMTP is unusable from the hosting unless GoDaddy provides another route.

## Platform constraints (design around these)
- Local filesystem: survives restart, is WIPED on every new deployment. Never store images, sessions,
  drafts or any user data on disk. Disk is scratch space only (delete after use).
- Keep any single Claude call well under 60 s. Stream progress for longer flows. Retries idempotent.
- Secrets are set per variant (preview AND publish) in GoDaddy, as raw values with no quotes.
  Never in code, repo, logs or ZIP.
- GoDaddy rate limits are undocumented: throttle AI and public endpoints, keep demo usage modest.
- Package requirements: root package.json with name, version, main; "build" script (currently
  `node -e "process.exit(0)"`, a no-op that works on Windows and Linux); "start":
  "node src/server.js"; runtime packages in dependencies; ZIP (if used) excludes node_modules, .env,
  .git and stays under 100 MB.
- Fonts and assets for Gujarati and Devanagari must be self-hosted under public/ (Helmet CSP blocks
  third-party origins unless deliberately configured).

## Layering (strict)
routes -> controllers (HTTP only) -> services (business rules) -> repositories (ONLY place that talks
to Supabase). Pure domain logic (pricing, quotes, contrast) lives in src/domain with zero I/O.
AI code lives in src/ai. Email in src/email. Controllers never import supabase-js or the SDK.

## Folder layout
src/server.js (listen only) | src/app.js (app factory, testable) | src/config/env.js (Zod env)
src/lib (logger, errors, correlation, money) | src/middleware | src/routes | src/controllers
src/services | src/repositories | src/domain | src/ai (client, prompts/, tools/, schemas/)
src/email | src/views (EJS) | public (static, NEVER private data)
db/migrations/*.sql | db/verify | db/seed | scripts | tests/{unit,integration,security,ai-evals} | docs/

## Non-negotiables
1. Multi-tenancy: every query is scoped by store_id. store_id comes from the authenticated server
   session or the URL slug resolved server-side. NEVER from request body or model/tool arguments.
2. Validate every external input with Zod at the boundary (HTTP body, query, params, model output,
   tool arguments, env vars). Reject unknown keys (use .strict()).
3. Money is integer paise. Never use floats for currency. All arithmetic is in code, never by the model.
4. Secrets only in environment variables. Never in code, logs, client JS, or the deploy ZIP.
   The Supabase service-role key is server-side only. (It bypasses RLS, so app-layer store scoping is
   mandatory; RLS is defence in depth.)
5. Escape all output in EJS (<%= %>). Never use <%- %> on user or model text. Never execute or render
   AI-generated HTML, CSS or JS.
6. Treat customer text, product text, image text and owner notes as UNTRUSTED data (prompt injection).
7. Multi-step DB changes happen inside ONE Postgres function (RPC), not several client calls.
   supabase-js has no multi-statement transactions.
8. Side effects (email) are idempotent and go through the email_outbox. Email failure never rolls
   back committed business data.
9. Errors: throw AppError(code, httpStatus, safeMessage, details). One central error handler. Never
   leak stack traces, SQL or provider errors to clients. Every response carries a correlation id.
10. Logging: structured JSON, correlation id, no secrets, no full customer messages or phone numbers.
11. Accessibility: semantic HTML, page lang attribute, alt text, visible focus, contrast >= 4.5:1,
    keyboard operable, mobile-first, works at 200% zoom.
12. Supabase: RLS enabled on every table; Storage bucket private; images served via signed URLs.
13. Owner auth is a simple server-side session (NOT Supabase Auth): email + password hashed with
    crypto.scrypt, random session token stored as a SHA-256 hash in the sessions table, HttpOnly +
    SameSite=Lax cookie (Secure and `__Host-` prefixed in production), Origin check on
    state-changing requests, rate-limited login, signup gated by SIGNUP_INVITE_CODE.
    No new auth dependency. Sessions are never stored on local disk.
14. Postgres functions must set `search_path` and REVOKE EXECUTE from public, anon and
    authenticated, then GRANT EXECUTE to service_role only. Functions in the public schema are
    otherwise callable through Supabase's API.
15. AI cost is tracked as integer micro-USD and enforced by database-backed atomic reservation
    (per owner per day in India time, plus a global daily cap). Never rely on in-memory counters.

## Code quality
Small pure functions; no function over ~40 lines; no deep nesting; descriptive names; JSDoc on exports;
no dead code; no commented-out code; no magic numbers (named constants); async/await with explicit
error handling; timeouts on every outbound call (Supabase, Claude, SMTP, email API).

## Never do without explicit approval
- Run gddy deploy / publish / purchase / DNS commands. The developer runs all hosting commands.
- Buy anything or touch billing.
- Add or change dependencies.
- Edit CLAUDE.md or SPEC.md.
- Read or print .env or any secret value. You never receive the Supabase service-role key.
- Run destructive Supabase operations (drop, truncate, bulk delete).
- Run bulk or looping Claude calls. AI evals use small inputs; credits are limited.
- Prefix test rows in Supabase clearly (e.g. slug "test-...") so they can be cleaned up.

## Working agreement
- Plan before code. Ask questions instead of guessing.
- Tests first. A task is DONE only when: tests pass, `npm test` is green (also under Node 22),
  new env vars are in .env.example, docs/DECISIONS.md updated, and it runs on the GoDaddy preview.
- Database changes are written as numbered SQL files in db/migrations/ plus a read-only check in
  db/verify/. The developer applies them in the Supabase SQL editor; record applied migrations in
  docs/DECISIONS.md.
- Smallest diff that solves the problem. No drive-by refactors. No new dependencies without approval.
- Report what you verified and what you could not. Never claim something works without running it.
- At the end of every task output: files changed | tests added | how to run | known gaps.

## Status
Done: Module 0 code, Preview and Publish healthy, Supabase (DB + Storage), Claude API call.
Next: SPEC.md modules in order, starting with Module 1.
Pending: email transport decision (SMTP blocked on hosting), domain connection, removal of the
temporary SMTP diagnostics detail and of DIAGNOSTICS_TOKEN on Publish.