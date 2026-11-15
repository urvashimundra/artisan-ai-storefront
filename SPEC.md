# SPEC.md: Artisan AI Storefront & Business Assistant

Items marked **[CONFIRM]** are open decisions or facts to verify. Standing rules are in CLAUDE.md and apply to every module.

## 1. Goal and hackathon requirements

Help an artisan go from idea to a live, accessible, multilingual shop on their own domain, with an AI assistant that drafts and the owner who approves.

- Agentic use of Claude (tool use, multi-step), with the owner approving consequential actions
- Deployed on GoDaddy Node.js hosting, served on a custom domain over HTTPS
- Titan mailbox on that domain, plus a website contact form that sends to it
- Working prototype by 20 Nov 2026, demo-ready for the finale

**Users:** artisans (owner) and their customers. Languages: English, Gujarati, Hindi. Price in INR.

## 2. Architecture

```text
Customer / Owner browser (EJS pages + vanilla JS)
   | HTTPS
   v
Express on GoDaddy Node.js hosting
   routes -> controllers -> services -> repositories -> Supabase (Postgres + private Storage)
                              |-> src/ai (Claude, tools, Zod-validated output, budget guard)
                              |-> src/email -> email_outbox -> transport (smtp | api) -> mailbox
```

Claude proposes. Services validate and execute. The owner approves. The database is the source of truth.

## 3. Validated infrastructure (Module 0 results)

| Check | Result |
|---|---|
| Express, process.env.PORT, /health | Confirmed on Preview |
| Platform health check | Probes `/`; `GET /` returns 200; Preview and Publish both show healthy |
| ~90 s request completes | Confirmed |
| Streaming over 30 s | Confirmed |
| Filesystem survives restart | Yes |
| Filesystem survives new deployment | **No** |
| Supabase Postgres read/write over HTTPS | Confirmed (Preview) |
| Supabase private Storage upload | Confirmed |
| Claude API (claude-haiku-5-5) from backend | Confirmed |
| Node version | GoDaddy states apps run on Node.js 22; `engines` is `22.x`; tests pass on 22 |
| Titan SMTP from local machine | Confirmed (ports 465 and 587) |
| Titan SMTP from GoDaddy Preview and Publish | **Blocked on both variants: `connect EACCES` (errno -13) on 465 and 587** |
| Custom domain + HTTPS | Domain and hosting purchased; connection pending **[CONFIRM]** |
| GoDaddy rate limits | Undocumented |

Consequences: all persistent data and images in Supabase; Claude calls under 60 s; secrets set per variant; self-host Gujarati and Devanagari fonts; throttle AI and public endpoints; email transport must be swappable (see Module 5).

### Environment configuration

Required to boot: `NODE_ENV`, `BASE_URL`, `PORT` (default 3000). Optional groups are all-or-nothing once any member is set. From Module 1 the Supabase group is required.

- `BASE_URL`: canonical application URL for the environment (Preview and Publish differ).
- `ALLOWED_ORIGINS`: optional comma-separated trusted origins for Origin validation, each a bare origin (scheme + host). Configure per environment. Needed if the app is reachable on more than one host (for example the default URL and the custom domain).
- `TRUST_PROXY`: integer, default 1. `DIAGNOSTICS_TOKEN`: optional, min 24 chars. Remove or rotate it on Publish when not in use.
- `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`: Supabase connection. Server-side only.
- `SIGNUP_INVITE_CODE`: min 16 chars. Required for owner signup; if unset, signup is disabled. Never exposed to browser code, logs, API responses or the repository.
- `DEMO_OWNER_EMAIL`, `DEMO_OWNER_PASSWORD`: read only by `scripts/seed-demo.js` on the developer's machine. Not required to boot the app, never committed.
- AI group (Module 2): `ANTHROPIC_API_KEY`, `CLAUDE_MODEL`, `AI_DAILY_BUDGET_USD` (per normal owner per day), `AI_DEMO_DAILY_BUDGET_USD` (demo owner, much lower), `AI_GLOBAL_DAILY_BUDGET_USD` (all owners combined). Parsed from decimal strings to integer micro-USD without floating-point arithmetic.
- Email group: `EMAIL_TRANSPORT` (`smtp` or `api`, default `smtp`), `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM`, `OWNER_NOTIFY_EMAIL`; plus API-transport settings if that fallback is adopted.

Secrets are set per GoDaddy variant (Preview and Publish separately), as raw values with no quotes, and locally in `.env`. Never commit `.env`.

## 4. Data model

Every business table carries store_id (except owners, sessions, stores and the AI budget tables, which are keyed by owner). RLS on every table with no policies for anon/authenticated; privileges revoked from those roles. The server uses the service role and scopes every query itself. Money is integer paise (shop) or integer micro-USD (AI cost).

- **owners**: id, email (unique on lower(email)), password_hash (encoded scrypt string including salt), is_demo (bool, default false), created_at
- **sessions**: id, owner_id (FK, cascade), token_hash (unique), expires_at, created_at
- **stores**: id, owner_id (**UNIQUE**, FK), slug (unique, format check), name, default_language (check en/gu/hi), story, contact_email (nullable), created_at, updated_at
- **products**: id, store_id, status (draft/published), price_paise, stock (nullable), image_path, created_at
- **product_translations**: product_id, store_id, language (en/gu/hi), title, description, alt_text, source (owner/ai), approved (bool)
- **enquiries**: id, store_id, product_id (nullable), customer_name, customer_contact, message, language, status (new/draft_ready/replied/needs_owner), created_at
- **order_requests**: id, store_id, enquiry_id, items (jsonb), total_paise, status (requested/quoted/confirmed/cancelled), created_at
- **ai_drafts**: id, store_id, kind (translation/reply/quote), target_id, content (jsonb), status (pending/approved/rejected), model, tokens_in, tokens_out, cost_micro_usd, created_at
- **ai_usage_daily**: owner_id, usage_date (India date, Asia/Kolkata), reserved_micro_usd, spent_micro_usd; primary key (owner_id, usage_date)
- **ai_usage_global_daily**: usage_date (India date, Asia/Kolkata, pk), reserved_micro_usd, spent_micro_usd
- **ai_reservations**: id, owner_id, usage_date, amount_micro_usd, status (reserved/settled/released/expired), expires_at, created_at
- **email_outbox**: id, store_id, to_address, subject, body, idempotency_key (unique), status (pending/sent/failed), attempts, last_error_code, created_at

Multi-step changes (approve draft, confirm order, reserve/settle AI budget) run as a single Postgres function. Every such function must set `search_path`, `REVOKE EXECUTE` from public, anon and authenticated, and `GRANT EXECUTE` to service_role only, because functions in the public schema are otherwise callable through Supabase's API.

## 5. Modules (build in order; each is a vertical slice with tests)

### Module 0: Foundation (code complete; deployment checks pending)
App factory, env validation, health, root route, diagnostics, smoke script. Done: Preview and Publish healthy, diagnostics run on both. Open items: domain connection, removal of the temporary SMTP `detail` field and of `DIAGNOSTICS_TOKEN` on Publish, and the email transport decision (SMTP is blocked on both variants).

### Module 1: Owner access and store setup

**Decision: simple server-side session login, not Supabase Auth.** Hackathon-grade, no new dependencies.

- **Passwords:** `crypto.scrypt` with a per-user random salt, stored as one encoded string (`scrypt$N$r$p$salt$hash`) so parameters can be raised later. Constant-time compare. For an unknown email a dummy hash is verified so timing and response match a wrong password. No plaintext, never logged.
- **Signup:** requires `SIGNUP_INVITE_CODE` (compared in constant time). No unrestricted public signup. A duplicate email is reported only after a valid invite code.
- **Login:** uniform failure message. Failed-login rate limit keyed by IP and email together (so an attacker cannot lock out the demo account by failing logins from elsewhere), plus a looser per-IP limit; signup limited per IP.
- **Sessions:** 32 random bytes; only the SHA-256 is stored in `sessions` with an absolute expiry. New token on every login. Cookie HttpOnly, SameSite=Lax, Path=/; Secure and `__Host-` prefixed in production. Logout deletes the row. Expired sessions are rejected and cleaned up. Never on local disk.
- **Tenancy:** middleware resolves cookie to owner_id and then to the owner's store server-side. store_id is never taken from the request body, query or model arguments.
- **CSRF:** SameSite plus Origin check on every state-changing request against `BASE_URL` and `ALLOWED_ORIGINS`; if Origin is absent, require `Sec-Fetch-Site: same-origin`.
- **Store:** one store per owner (database constraint). Fields: name, slug, default language, story.
- **Demo owner:** `scripts/seed-demo.js`, run by the developer, idempotent, reads `DEMO_OWNER_EMAIL` and `DEMO_OWNER_PASSWORD`, goes through the same hashing and store services as normal owners, sets `is_demo`. Credentials never committed. The demo owner has the same authentication and authorization as any owner, and a much lower AI budget (Module 2).
- **Pages:** signup, login, create store, dashboard (shows the owner's store). Escaped EJS, lang attribute, labelled fields, keyboard operable, mobile-first, `Cache-Control: no-store` on authenticated pages.

**Acceptance:** an owner signs up with a valid invite code, logs in, creates a store that appears on their dashboard, and logs out. The seeded demo owner can log in and sees its store. Cross-tenant access is rejected (security test). Cookie flags, expiry, Origin checks and rate limits are covered by tests. An invalid invite code creates no owner. The public page at `/s/:slug` is Module 3.

**Out of scope:** AI budget logic, Claude calls, password reset, email verification, roles, multiple stores.

**Known limits** (record in docs/DECISIONS.md): no email verification, no password reset, in-memory rate limits reset on restart and are per instance.

### Module 2: Photo + story to product listing

Owner uploads a photo and a short story. Claude (vision) proposes title, description, alt text and translations into the other two languages. Output is Zod-validated. Owner edits and approves each language. Price is entered by the owner; the AI never sets or changes money.

- Image validation (type, size) before upload; original in private Storage; scratch files deleted.
- Streamed progress; single Claude call under 60 s.

**AI budget (hard requirement, concurrency-safe, database-backed):**
- Three limits: per normal owner per day (`AI_DAILY_BUDGET_USD`), per demo owner per day (`AI_DEMO_DAILY_BUDGET_USD`), and a global daily cap (`AI_GLOBAL_DAILY_BUDGET_USD`) that protects total credit. The budget day is the India date (Asia/Kolkata), so limits reset at midnight IST. The database computes the date itself, as `(now() at time zone 'Asia/Kolkata')::date`, inside the budget functions; the app never passes a date, which avoids clock skew between the app and the database.
- Before each Claude call, `reserve_ai_budget` atomically checks all three limits and records a reservation sized to the worst-case cost (estimated input plus max output tokens, using price constants in `src/domain`, verified against current Anthropic pricing). If any limit would be exceeded, the call is refused with a clear owner-facing message and nothing is sent to Claude.
- After the response, `settle_ai_budget` converts the reservation to actual spend from provider usage. On a provider error with no usage, `release_ai_budget` frees it.
- Reservations expire (TTL longer than the longest allowed call, for example 5 minutes). An expired reservation is charged as spent, since the call may have reached the provider (decided: conservative, protects credits).
- Concurrent requests cannot exceed a limit: row locks taken in a fixed order inside one Postgres function.
- Usage is tracked per owner per day across all of the owner's stores, never in memory.

**Acceptance:** photo + story in, editable multilingual draft out; approval publishes the product. AI requests cannot exceed a configured limit, including under concurrent requests.

### Module 3: Public storefront /s/:slug
Server-rendered EJS, language switcher, correct lang attribute, alt text, keyboard operable, mobile-first, WCAG contrast >= 4.5:1, works at 200% zoom. Signed image URLs. All output escaped. Self-hosted fonts for Gujarati and Devanagari.

**Acceptance:** published products visible in the chosen language; accessibility checks pass.

### Module 4: Enquiries, order requests and AI drafts
Customers send an enquiry or order request from the storefront. The server stores it (store_id from slug), then Claude drafts a reply or quote using tools that read product data from the database, under the same AI budget guard. Prices and totals are computed in src/domain, never by the model. Customer text is untrusted (prompt-injection tests). The owner reviews the draft in a dashboard and approves, edits or rejects. Approval writes an email_outbox row; delivery is idempotent and its failure never rolls back the approval.

**Acceptance:** enquiry in, grounded draft out, owner approves, customer email queued and sent through the configured transport.

### Module 5: Site contact form and email transport
Hackathon requirement. A contact form on the main site posts to `/api/contact`, stores the message, and delivers it to the domain mailbox through the outbox. Rate-limited, validated, spam-resistant.

**Constraint:** outbound SMTP is blocked from the hosted app on both Preview and Publish (`EACCES` on 465 and 587), so SMTP cannot be relied on unless GoDaddy or the organizers provide a supported route. The transport is therefore swappable behind one interface in `src/email`: `smtp` (smtpout.secureserver.net, full address as username, password as platform secret) and `api` (HTTPS email service, only if the organizers confirm it is acceptable; adding it needs approval as it is outside the fixed stack). The outbox, templates and tests do not change when the transport changes. Decision date: 16 Nov.

**Acceptance:** a submission arrives in the configured domain mailbox.

### Module 6: Launch (developer-run, not Claude Code)
1. Done: domain `theartisanstory.in`, Node.js Economy (1 month) and Titan Pro Light (1 month) purchased; mailbox created. In-store credit expires 23 Nov 2026.
2. Snapshot DNS (MX, SPF/TXT, Titan records), connect the domain to the published app, confirm HTTPS, compare DNS afterwards, send a test email to the mailbox.
3. Set every secret on the Publish variant (including `BASE_URL`, `ALLOWED_ORIGINS`), publish, re-run the smoke test, remove or rotate `DIAGNOSTICS_TOKEN`.
4. End-to-end test on the live domain with the demo owner, before 20 Nov.

## 6. AI design

- src/ai/prompts/ versioned prompts; src/ai/tools/ read-only data lookups; src/ai/schemas/ Zod outputs.
- Tools never accept store_id from the model. The server injects it.
- Model output is validated; invalid output is retried once, then escalated to the owner. A retry reserves budget again.
- If information is missing the draft says so and flags needs_owner. No invented prices, stock or dates.
- Log model, tokens, cost and correlation id per call. No full customer text in logs.
- ai-evals use a small fixed set of cases to protect credits.
- Budget enforcement is database-backed and atomic (Module 2). In-memory counters are never the control.

## 7. Testing

- node:test. Unit (domain: pricing, quotes, AI cost, contrast), integration (services + repositories), security (tenancy, injection, XSS, rate limits, Origin), ai-evals (small set).
- `npm test` green before any deployment, and under Node 22 (`npx -y node@22 --test`).
- Smoke script: `/health`, Supabase read/write, one Claude call, SMTP or API transport.
- Run on Preview, then on Publish.
- Include tests for: invite code, demo account access, uniform login failures, Origin validation, per-owner and global AI budget, concurrent reservations, reservation expiry and settlement.
- SQL verification files (db/verify/) are run by the developer after each migration.

## 8. Out of scope

Online payments, shipping and logistics, accounts for customers, analytics, social integrations, password reset, email verification, multiple stores per owner, languages beyond en/gu/hi.

## 9. Timeline

| Date | Focus |
|---|---|
| 15 Nov | Module 1; DNS snapshot |
| 16 Nov | Connect domain; Module 2 incl. budget functions; email transport decision after the call |
| 17 Nov | Finish Module 2; Module 3 |
| 18 Nov | Module 4; Module 5 with the chosen transport |
| 19 Nov | Publish-variant tests, end-to-end test on the live domain, fixes |
| 20 Nov | Polish, demo script, recorded backup demo, submit |

If time runs short, cut polish and extra translations before cutting tenancy, approval rules or the budget guard. In Module 2, simplify reconciliation before simplifying the reservation itself.