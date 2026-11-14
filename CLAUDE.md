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
Node.js + Express (ES modules), EJS + vanilla JS, Supabase Cloud (Postgres + Storage) via supabase-js
over HTTPS, Claude via official @anthropic-ai/sdk, Nodemailer to Titan SMTP, Zod, Helmet,
express-rate-limit, node:test. Hosting: GoDaddy Node.js hosting; bind to process.env.PORT.
Supabase is NOT hosted on GoDaddy; the app calls it over HTTPS.
Default model: claude-haiku-5-5 (validated). Use a larger model only where quality clearly needs it.

## Validated on GoDaddy preview (tested, can rely on)
- Express runs and binds to process.env.PORT; /health responds.
- ~90 s requests complete; streaming responses arrive progressively.
- Supabase over HTTPS: Postgres read/write and private Storage upload work.
- Claude API from the backend works (claude-haiku-5-5), usage returned.

## Platform constraints (design around these)
- Local filesystem: survives restart, is WIPED on every new deployment. Never store images, sessions,
  drafts or any user data on disk. Disk is scratch space only (delete after use).
- Keep any single Claude call well under 60 s. Stream progress for longer flows. Retries idempotent.
- Secrets are set per variant (preview AND publish) in GoDaddy. Never in code, repo, logs or ZIP.
- GoDaddy rate limits are undocumented: throttle AI and public endpoints, keep demo usage modest.
- NOT yet validated: Titan SMTP (smtpout.secureserver.net, full address as username, NOT
  smtp.titan.email), and behaviour on the publish variant. Do not assume either works.
- Package requirements: root package.json with name, version, main; "build": "echo build";
  "start": "node src/server.js"; runtime packages in dependencies; ZIP excludes node_modules, .env,
  .git and stays under 100 MB. Confirm the supported Node version before setting "engines".
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
db/migrations/*.sql | db/seed | tests/{unit,integration,security,ai-evals} | docs/

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

## Code quality
Small pure functions; no function over ~40 lines; no deep nesting; descriptive names; JSDoc on exports;
no dead code; no commented-out code; no magic numbers (named constants); async/await with explicit
error handling; timeouts on every outbound call (Supabase, Claude, SMTP).

## Never do without explicit approval
- Run gddy deploy / publish / purchase / DNS commands. The developer runs all hosting commands.
- Buy anything or touch billing.
- Add or change dependencies.
- Edit CLAUDE.md or SPEC.md.
- Run destructive Supabase operations (drop, truncate, bulk delete).
- Run bulk or looping Claude calls. AI evals use small inputs; credits are limited.
- Prefix test rows in Supabase clearly (e.g. slug "test-...") so they can be cleaned up.

## Working agreement
- Plan before code. Ask questions instead of guessing.
- Tests first. A task is DONE only when: tests pass, `npm test` is green, new env vars are in
  .env.example, docs/DECISIONS.md updated, and it runs on the GoDaddy preview.
- Smallest diff that solves the problem. No drive-by refactors. No new dependencies without approval.
- Report what you verified and what you could not. Never claim something works without running it.
- At the end of every task output: files changed | tests added | how to run | known gaps.

## Status
Done: GoDaddy preview deploy, Supabase (DB + Storage), Claude API call.
Next: SPEC.md modules in order. Pending: Titan SMTP, publish-variant smoke test, domain, hosting plan.