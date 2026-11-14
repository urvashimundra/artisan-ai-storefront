# SPEC.md: Artisan AI Storefront & Business Assistant

Items marked **[CONFIRM]** are open decisions. Standing rules are in CLAUDE.md and apply to every module.

## 1. Goal and hackathon requirements
Help an artisan go from idea to a live, accessible, multilingual shop on their own domain, with an AI
assistant that drafts and the owner who approves.
- Agentic use of Claude (tool use, multi-step), with the owner approving consequential actions
- Deployed on GoDaddy Node.js hosting, served on a custom domain over HTTPS
- Titan mailbox on that domain, plus a website contact form that sends to it
- Working prototype by 20 Nov 2026, demo-ready for the finale

**Users:** artisans (owner) and their customers. Languages: English, Gujarati, Hindi. Price in INR.

## 2. Architecture
```
Customer / Owner browser (EJS pages + vanilla JS)
   | HTTPS
   v
Express on GoDaddy Node.js hosting
   routes -> controllers -> services -> repositories -> Supabase (Postgres + private Storage)
                               |-> src/ai (Claude, tools, Zod-validated output)
                               |-> src/email -> email_outbox -> Nodemailer -> Titan SMTP
```
Claude proposes. Services validate and execute. The owner approves. The database is the source of truth.

## 3. Validated infrastructure (Module 0 results, GoDaddy preview)
| Check | Result |
|---|---|
| Express, process.env.PORT, /health | Confirmed |
| ~90 s request completes | Confirmed |
| Streaming over 30 s | Confirmed |
| Filesystem survives restart | Yes |
| Filesystem survives new deployment | **No** |
| Supabase Postgres read/write over HTTPS | Confirmed |
| Supabase private Storage upload | Confirmed |
| Claude API (claude-haiku-5-5) from backend | Confirmed |
| Titan SMTP | **Not yet tested** |
| Publish variant (secrets set separately) | **Not yet tested** |
| GoDaddy rate limits | Undocumented |

Consequences: all persistent data and images in Supabase; Claude calls under 60 s; secrets set per variant;
self-host Gujarati and Devanagari fonts; throttle AI and public endpoints.

## 4. Data model (draft) [CONFIRM]
Every table carries store_id (except owners, sessions and stores). RLS on. Money as integer paise.
- **owners**: id, email (unique), password_hash, password_salt, created_at
- **sessions**: id, owner_id, token_hash (unique), expires_at, created_at
- **stores**: id, slug (unique), name, default_language, story, contact_email, owner_id, created_at
- **products**: id, store_id, status (draft/published), price_paise, stock (nullable), image_path, created_at
- **product_translations**: product_id, store_id, language (en/gu/hi), title, description, alt_text,
  source (owner/ai), approved (bool)
- **enquiries**: id, store_id, product_id (nullable), customer_name, customer_contact, message,
  language, status (new/draft_ready/replied/needs_owner), created_at
- **order_requests**: id, store_id, enquiry_id, items (jsonb), total_paise, status
  (requested/quoted/confirmed/cancelled), created_at
- **ai_drafts**: id, store_id, kind (translation/reply/quote), target_id, content (jsonb), status
  (pending/approved/rejected), model, tokens_in, tokens_out, created_at
- **email_outbox**: id, store_id, to_address, subject, body, idempotency_key (unique), status
  (pending/sent/failed), attempts, created_at

Multi-step changes (approve draft, confirm order) run as a single Postgres RPC function.

## 5. Modules (build in order; each is a vertical slice with tests)

### Module 0: Foundation (DONE)
App factory, env validation, health, deploy ZIP script, connectivity tests.

### Module 1: Owner access and store setup
**Decision: simple server-side session login, not Supabase Auth.** Hackathon-grade, no new dependencies.
- Owner signs up and logs in with email + password. Passwords hashed with `crypto.scrypt` (node:crypto,
  per-user random salt, constant-time compare). No plaintext, no password in logs.
- On login the server creates a random 32-byte token, stores only its SHA-256 hash in the `sessions`
  table (with owner_id, expiry), and sets it as a cookie: HttpOnly, Secure, SameSite=Lax, fixed expiry.
  Sessions live in Supabase, never on local disk (the filesystem is wiped on deploy).
- Middleware resolves the cookie to owner_id and then store_id server-side. store_id is never taken from
  the request body or model arguments.
- Logout deletes the session row. Expired sessions are rejected and cleaned up.
- CSRF: SameSite cookie plus an Origin/Host check on every state-changing request.
- Login and signup are rate-limited (express-rate-limit) with generic error messages that do not reveal
  whether an email exists.
- The owner then creates a store: name, slug, default language, story.
- Acceptance: owner signs up, logs in, creates a store reachable at /s/:slug, and logs out. Cross-tenant
  access attempts are rejected (security test). Session cookie flags and expiry covered by tests.
- Known limits (document in docs/DECISIONS.md): no email verification, no password reset, single device
  logic only. Acceptable for the prototype.

### Module 2: Photo + story to product listing
Owner uploads a photo and a short story. Claude (vision) proposes title, description, alt text and
translations into the other two languages. Output is Zod-validated. Owner edits and approves each
language. Price is entered by the owner; the AI never sets or changes money.
- Image validation (type, size) before upload; original in private Storage; scratch files deleted.
- Streamed progress; single Claude call under 60 s.
- Acceptance: photo + story in, editable multilingual draft out; approval publishes the product.

### Module 3: Public storefront /s/:slug
Server-rendered EJS, language switcher, correct lang attribute, alt text, keyboard operable, mobile-first,
WCAG contrast >= 4.5:1, works at 200% zoom. Signed image URLs. All output escaped.
- Acceptance: published products visible in the chosen language; accessibility checks pass.

### Module 4: Enquiries, order requests and AI drafts
Customers send an enquiry or order request from the storefront. The server stores it (store_id from slug),
then Claude drafts a reply or quote using tools that read product data from the database. Prices and totals
are computed in src/domain, never by the model. Customer text is untrusted (prompt-injection tests).
The owner reviews the draft in a dashboard and approves, edits or rejects. Approval triggers an
email_outbox row; delivery is idempotent and its failure never rolls back the approval.
- Acceptance: enquiry in, grounded draft out, owner approves, customer email queued and sent.

### Module 5: Site contact form and Titan SMTP
Hackathon requirement. A contact form on the main site posts to /api/contact, stores the message, and
sends it to the domain mailbox through the outbox. SMTP host smtpout.secureserver.net, username is the
full address, password only as a platform secret. Rate-limited, validated, spam-resistant.
- Acceptance: a submission arrives in hello@yourdomain.

### Module 6: Launch (developer-run, not Claude Code)
1. Buy domain, Node.js Economy (1 month) and Titan Pro Light (1 month) together on godaddy.com.
   **In-store credit expires 23 Nov 2026. Target 17-18 Nov.** Check the cart total shows $0 first.
2. Point DNS at the app, confirm HTTPS.
3. Create the mailbox with the CLI and test inbound email.
4. Set every secret on the publish variant, publish, re-run the smoke test.
5. End-to-end test on the live domain before 20 Nov.

## 6. AI design
- src/ai/prompts/ versioned prompts; src/ai/tools/ read-only data lookups; src/ai/schemas/ Zod outputs.
- Tools never accept store_id from the model. The server injects it.
- Model output is validated; invalid output is retried once, then escalated to the owner.
- If information is missing the draft says so and flags needs_owner. No invented prices, stock or dates.
- Log model, tokens and correlation id per call to ai_drafts. No full customer text in logs.
- ai-evals use a small fixed set of cases to protect credits.

## 7. Testing
- node:test. Unit (domain: pricing, quotes, contrast), integration (services + repositories),
  security (tenancy, injection, XSS, rate limits), ai-evals (small set).
- `npm test` green before any deployment. Smoke script: /health, Supabase read/write, one Claude call,
  SMTP once available. Run on preview, then on publish.

## 8. Out of scope [CONFIRM]
Online payments, shipping and logistics, accounts for customers, analytics, social integrations,
languages beyond en/gu/hi.

## 9. Timeline (today is 14 Nov)
| Dates | Focus |
|---|---|
| 14-15 Nov | Module 1 and the start of Module 2 |
| 15-16 Nov | Finish Module 2, Module 3 |
| 16-17 Nov | Module 4 |
| 17-18 Nov | Module 6 purchases, DNS, HTTPS, mailbox, Module 5 and SMTP test |
| 18-19 Nov | Publish-variant smoke test, end-to-end test, fixes |
| 19-20 Nov | Polish, demo script, recorded backup demo, submit |