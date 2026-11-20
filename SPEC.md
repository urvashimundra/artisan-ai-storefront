# SPEC.md — The Artisan Story

**Product:** Artisan AI Storefront & Business Assistant  
**Repository:** `artisan-ai-storefront`  
**Runtime:** Node.js 22.x, Express 5, EJS and vanilla JavaScript  
**Data platform:** Supabase Cloud (PostgreSQL and private Storage)  
**AI provider:** Anthropic Claude  
**Hosting:** GoDaddy Node.js hosting  
**Primary market:** India; currency: INR  
**Supported languages:** English (`en`), Gujarati (`gu`) and Hindi (`hi`)

This document describes the implemented application in the current repository. It is a **current-state specification**, not a build sequence or a list of future modules. The source code, SQL migrations and tests define exact implementation details. `CLAUDE.md` contains the standing engineering constraints and working agreement; this file describes product behavior, architecture and data flows.

---

## 1. Product purpose

The Artisan Story helps independent artisans create and operate a multilingual online storefront without needing to build or maintain a website themselves.

An artisan can create a store, describe their craft, upload product photographs, use AI to prepare product content, manage product information, and share a public storefront. Customers can discover products, contact the seller through the storefront, chat with an AI assistant grounded in the seller's information, and place order requests.

The application supports the operational steps around an order, including stock reservation, UPI payment instructions, payment-reference submission and seller-side payment confirmation.

### 1.1 Users and roles

**Store owner**
- Creates an account and one store.
- Configures store identity, story, language, contact channels and appearance.
- Creates, edits, translates, approves, publishes and removes products.
- Maintains shop information and bulk-discount knowledge used by the assistant.
- Reviews customer conversations and enquiries.
- Manages orders and manually verifies payment references.
- Receives relevant email notifications when email delivery is configured.

**Customer / visitor**
- Visits a public store and its product pages.
- Switches between supported languages where translations are available.
- Contacts the seller using the available contact options.
- Starts or continues a store conversation with the customer assistant.
- Places an order request for an eligible product.
- Views order status through a private, unguessable link.
- Submits a UPI transaction reference and may cancel an eligible order.

There are no customer accounts. Store owners authenticate through the application's server-side session system.

### 1.2 Product principles

1. The store owner remains the authority for business information and consequential decisions.
2. AI output is untrusted until validated and, where required, reviewed or approved.
3. Product prices, order totals, stock changes and payment status are controlled by deterministic application and database logic—not by the language model.
4. Customer-facing answers should be grounded in the store's published products and owner-provided knowledge.
5. Store data is isolated by store scope.
6. The storefront must remain usable on mobile devices and in the supported scripts and languages.

---

## 2. Implemented capabilities

### 2.1 Owner account and store onboarding

- Owner signup is open (no invite code) and protected by the signup rate limit.
- Owners log in with email and password.
- Passwords are hashed using Node.js `crypto.scrypt`; plaintext passwords are never stored.
- Sessions use random bearer tokens. Only token hashes are stored in Supabase.
- The session cookie is HttpOnly, SameSite=Lax and Path=/; HTTPS deployments use Secure and the `__Host-` prefix.
- An owner has one store, enforced by the database.
- Store onboarding captures the store's name, public slug/address, default language and store information.
- Onboarding includes seller contact details and a workflow for preparing and approving store-language content.
- The owner dashboard is the entry point to products, store settings, shop knowledge, conversations/enquiries and orders.

### 2.2 Store profile and presentation

Owners can manage the information used by the public storefront, including:
- Store name, slug and story.
- Tagline.
- Default language and supported store translations.
- Accent/theme selection.
- WhatsApp contact number and whether the WhatsApp action is enabled.
- Instagram handle.
- UPI ID used to present payment instructions.
- Enquiry-notification preference.
- Store contact information.

The public storefront is served at `/s/:slug`. Public product pages are served at `/s/:slug/p/:productId`.

The storefront includes:
- A store introduction and maker story.
- Published product listings.
- Product detail pages and product imagery.
- Language-aware store and product content.
- Store contact actions where configured.
- Responsive layouts and self-hosted Gujarati and Devanagari fonts.
- SEO-oriented public routes, `robots.txt` and `sitemap.xml`.

Only published products and approved language content intended for public display are exposed through the public storefront.

### 2.3 Product creation and management

The owner can:
- Start a product listing.
- Upload a product image.
- Generate a product-content draft using Claude and the uploaded image plus the owner's description/story.
- Review and edit product information.
- Set the product's price and stock information.
- Save the product as a draft or publish it after the required content approval.
- Edit, delete or update a product's language content.
- Generate translation drafts for the other supported languages.

The AI listing workflow can propose product title, description and image alt text. The owner controls price and stock. AI does not set or modify monetary values.

Product images are stored in private Supabase Storage. The application uses signed image URLs for authorized display rather than making the storage bucket public.

#### Product translation behavior

- Product language content is stored separately by product and language.
- Translation drafts are marked as AI-sourced and unapproved.
- The owner reviews and approves translations before they are treated as approved public content.
- The explicit update-languages workflow regenerates translations for the other supported languages.
- An already approved translation written by the owner is preserved by the translation-draft save operation.
- Other generated/unapproved translation rows may be replaced by a new generation and require approval again.
- Saving the ordinary product review form does not silently regenerate or unapprove other languages.

The database function `save_product_translation_drafts` performs the relevant write atomically and protects the product row during the operation.

### 2.4 Shop knowledge and bulk-discount rules

The owner can maintain shop knowledge used to ground customer-assistant responses. The knowledge area supports:
- Saving the shop's written information/notes.
- Saving structured bulk-discount rules.
- Asking Claude to identify or extract bulk-discount rules from the saved shop notes.
- Reviewing and saving extracted rules.

The extraction workflow is not a pricing authority. The assistant may use owner-provided rules as context, but final order totals and monetary calculations remain application-controlled.

### 2.5 Customer conversations and AI assistant

The public storefront supports persistent customer conversations.

A customer can start a conversation from a store or product page, provide the required contact details and send messages. Conversations and messages are persisted in Supabase and appear in the owner's conversation inbox.

When the AI configuration is available:
- The conversation agent can use validated tools and store-scoped information.
- It can ground responses in published product data and owner-maintained shop knowledge.
- It checks customer text and treats customer-supplied content as untrusted.
- It can identify missing or conflicting information and escalate rather than inventing an answer.
- It does not control order/payment state or perform consequential database operations on behalf of the owner.
- AI usage for the conversation feature is separately constrained by database-backed usage controls.

When AI is unavailable or not configured, conversation persistence and the seller inbox remain application capabilities; the AI response capability is conditional on the AI configuration.

The owner can:
- View the conversation inbox.
- Open a conversation and inspect its message history.
- Reply as the seller.
- Mark a conversation handled.
- Delete a conversation where permitted.

Conversation lifecycle, message limits, idempotency, usage reservations and retention are enforced in application and database logic.

### 2.6 Legacy enquiries and seller inbox

The application retains enquiry routes and inbox compatibility. The owner can list, open, reply to, mark handled and delete enquiries through the owner interface. Conversation-backed customer chat is the primary persistent chat workflow; enquiry-related routes remain part of the current application.

### 2.7 Orders and stock reservation

Customers can place an order request from an eligible product page.

The order flow includes:
1. Customer opens the product's buy/checkout page.
2. Customer submits the order details and quantity.
3. The backend validates the request and computes monetary values.
4. A PostgreSQL function creates the order and reserves the required stock atomically.
5. The customer receives a private order-status URL.
6. The order remains subject to the configured reservation/expiry rules (the current customer payment reservation window is 10 minutes).
7. The customer can submit a UPI transaction reference (UTR).
8. The owner reviews the order and marks payment as received or not received.
9. The owner can cancel an eligible order; cancellation and expiry restore reserved stock as defined by the database workflow.

Order operations are scoped to the store and use database functions to protect consistency under concurrent requests.

The current schema and migrations define order states, payment attempts, reservation expiry and cancellation reasons. The application includes handling for exhausted UTR attempts.

### 2.8 UPI payment workflow

The store can display UPI payment instructions using the owner's configured UPI ID. The application also supports a QR representation and copyable UPI details where available in the interface.

This is **not an online payment gateway integration**:
- The application does not itself receive or settle UPI funds.
- The customer submits a UTR/payment reference after making payment outside the application.
- The seller checks the actual payment in their bank/UPI application.
- The seller records the outcome in the owner order interface.
- The application changes payment/order state only through its validated backend/database workflow.

Never describe a submitted UTR as proof of payment or claim that payment is automatically verified.

### 2.9 Email, contact form and notifications

The application includes:
- A public contact form.
- Persistent contact-message storage.
- An email outbox.
- Email templates for supported order, customer and owner notifications.
- Idempotency keys to prevent duplicate queued notifications.
- A background outbox worker that claims due messages, sends through the configured relay and records success/failure.
- Retry handling and safe error recording.
- Email delivery that is decoupled from the business transaction: a delivery failure does not roll back an already committed order or other business operation.

The current implementation uses an HTTP relay client in `src/email/relayClient.js`, not Nodemailer/SMTP transport selection. The relay is configured through `EMAIL_RELAY_URL`, whose default is a loopback address (`http://127.0.0.1:2525`). The worker can be controlled with `EMAIL_WORKER_ENABLED`.

The destination for the public contact form is configured through `CONTACT_INBOX_EMAIL`; `OWNER_NOTIFY_EMAIL` is also used as a notification/fallback address in the relevant flows.

The outbox worker and relay must be considered separate from the business operation that queued the email. A queued email is not the same as a confirmed delivery.

---

## 3. User journeys

### 3.1 Seller creates and publishes a store

1. Seller opens signup and provides an email and password.
2. Seller creates an account and logs in.
3. Seller creates a store and completes onboarding.
4. Seller configures store identity, contact information and languages.
5. Seller adds shop knowledge and discount rules as needed.
6. Seller uploads a product image and provides a product story/description.
7. Claude proposes product content.
8. Seller reviews, edits and approves the required language content.
9. Seller publishes the product.
10. Seller shares the public `/s/:slug` storefront URL.

### 3.2 Customer discovers a product and places an order

1. Customer opens the public storefront.
2. Customer opens a product detail page.
3. Customer chooses the buy action where ordering is available.
4. Customer submits the checkout form.
5. The application validates the request, calculates the total and reserves stock atomically.
6. Customer receives a private order-status link and payment instructions.
7. Customer makes payment externally using the presented UPI details.
8. Customer submits the UTR through the private order page.
9. Seller checks the payment independently and records the result.
10. The application updates the order according to the seller's decision and database rules.

### 3.3 Customer asks the assistant for help

1. Customer starts a conversation from the storefront.
2. The conversation is created and stored.
3. Customer sends a message.
4. If AI is configured and usage is available, the agent uses approved tools/context to formulate a grounded response.
5. If the agent cannot answer safely or detects a conflict, the conversation is flagged/escalated.
6. The customer and seller messages remain in the conversation history.
7. Seller reviews and responds from the owner inbox as needed.

---

## 4. Architecture

### 4.1 Runtime architecture

```text
Customer / Store owner browser
        |
        | HTTPS
        v
GoDaddy Node.js hosting (Node.js 22.x)
        |
        v
Express 5 application
  |-- EJS server-rendered views
  |-- Vanilla JavaScript and self-hosted CSS/assets
  |
  +--> Routes
         |
         v
      Controllers (HTTP request/response only)
         |
         v
      Services (application workflows and business rules)
         |
         +--> Domain modules (pure validation/calculation/rules)
         |
         +--> AI modules (Anthropic SDK, prompts, tools, schemas)
         |
         +--> Email modules (outbox worker and HTTP relay)
         |
         v
      Repositories (only application layer that accesses Supabase)
         |
         v
      Supabase Cloud
        |-- PostgreSQL
        |-- Private Storage

Anthropic Claude API <---- server-side AI modules
Email relay          <---- server-side email worker
```

### 4.2 Layer responsibilities

- `src/server.js`: process startup, dependency construction and listening.
- `src/app.js`: Express application factory and middleware/router composition.
- `src/config`: environment parsing and application configuration.
- `src/routes`: route declarations and middleware ordering.
- `src/controllers`: HTTP-specific parsing, response and rendering.
- `src/services`: workflows and orchestration.
- `src/domain`: pure business rules and calculations; no network or database I/O.
- `src/repositories`: Supabase access and persistence queries/RPC calls.
- `src/ai`: Claude client integration, prompts, tools, output schemas and AI-specific safeguards.
- `src/email`: email templates/service, relay client and outbox worker.
- `src/middleware`: authentication/session loading, store loading, rate limits, Origin checks, logging and error handling.
- `src/views`: EJS templates and partials.
- `public`: static CSS, JavaScript, fonts and public assets. No private user data.
- `db/migrations`: ordered PostgreSQL schema and function migrations.
- `db/verify`: read-only migration verification scripts.
- `db/seed`: database seed material where applicable.
- `scripts`: developer and operational scripts.
- `tests`: unit, integration and security tests.
- `docs`: engineering decisions, plans and skipped-work notes.

### 4.3 Technology stack

| Concern | Implementation |
|---|---|
| Runtime | Node.js 22.x |
| HTTP framework | Express 5 (ES modules) |
| Templates | EJS |
| Browser code | Vanilla JavaScript |
| Styling | CSS, shared design tokens |
| Database | Supabase PostgreSQL |
| Object storage | Supabase Storage, private bucket |
| Database client | `@supabase/supabase-js` over HTTPS |
| AI | `@anthropic-ai/sdk` |
| Validation | Zod |
| Security headers | Helmet |
| Rate limiting | `express-rate-limit` / application rate-limit middleware |
| QR generation | `qrcode` |
| Tests | Node.js built-in `node:test` |
| Hosting | GoDaddy Node.js hosting |

No React, frontend framework, CSS framework or frontend build pipeline is part of the current stack.

---

## 5. Data and persistence

The numbered SQL migrations are the canonical definition of the database schema. This section groups the current data model by responsibility; it intentionally does not duplicate every column and constraint from the migrations.

### 5.1 Identity and stores

- `owners`: owner accounts and password hashes; includes demo-owner classification.
- `sessions`: hashed session tokens, owner association and expiry.
- `stores`: one store per owner, public slug, store profile, language and presentation/contact settings.
- `store_translations`: localized store content.

### 5.2 Products and AI-generated content

- `products`: store-scoped product records, publication state, price, stock, image reference and generation coordination data.
- `product_translations`: per-language title, description and alt text, with source and approval metadata.
- `ai_drafts`: structured AI draft records where used by the product workflows.

### 5.3 AI budget controls

- `ai_usage_daily`: owner/day AI cost accounting.
- `ai_usage_global_daily`: global/day AI cost accounting.
- `ai_reservations`: reservations and settlement/release state for AI calls.

AI monetary usage is tracked in integer micro-USD. Product/order money is tracked in integer paise. The application does not use floating-point arithmetic for currency.

### 5.4 Customer support and knowledge

- `store_knowledge`: store-provided knowledge and assistant context.
- `enquiries`: enquiry records retained by the enquiry workflow.
- `conversations`: persistent customer conversations and their lifecycle/coordination metadata.
- `conversation_messages`: ordered customer, assistant and seller messages.
- `conversation_usage`: conversation-specific usage accounting and limits.
- `contact_messages`: public contact-form submissions.

### 5.5 Orders and notifications

- `store_order_counters`: store-scoped order numbering/counters.
- `orders`: order lifecycle, customer access token data, payment and cancellation state.
- `order_items`: product/quantity/price snapshots associated with an order.
- `order_payment_attempts`: submitted payment references and attempt tracking.
- `email_outbox`: queued notification messages, idempotency and delivery/retry state.

### 5.6 Database invariants

The application and database jointly enforce these invariants:
- Store-scoped access for business records.
- One store per owner.
- Product and order relationships scoped to the same store.
- Valid language, status, amount and content constraints.
- Atomic order placement, stock reservation, cancellation/expiry and payment resolution.
- Atomic AI budget reservation and settlement.
- Atomic conversation state/message operations where implemented through PostgreSQL functions.
- Atomic enqueueing of relevant email side effects with business operations.
- Private order access through unguessable tokens; stored token hashes are used for lookup, with encrypted token material only where required to generate notification links.

Multi-step operations that require transactionality use PostgreSQL functions/RPCs rather than multiple independent Supabase client calls.

### 5.7 Migrations

The repository currently contains migrations:

`001` owners/sessions/stores  
`002` AI budget  
`003` AI budget reservation ordering/sweep refinement  
`004` products and product translations/AI drafts  
`005` product generation fencing  
`006` storefront profile fields  
`007` store translations  
`008` orders and payment workflow  
`009` order reservation/expiry refinements  
`010` email outbox and contact form  
`011` email and order-link hardening  
`012` assistant knowledge and enquiries  
`013` persistent conversations and conversation usage  
`014` conversation backfill  
`015` UTR-attempt exhaustion and related order/email behavior  
`016` product translation draft persistence

Migration files are applied and verified operationally according to the project's deployment process. Do not infer production database state from the presence of a SQL file alone; use the team's migration record and verification results.

---

## 6. AI behavior and controls

### 6.1 AI use cases

Claude is used for:
- Product listing content generation from an image and seller-provided description/story.
- Product translation drafts.
- Store-language/onboarding translation drafts.
- Extraction of bulk-discount rules from seller-provided shop notes.
- Customer conversation responses grounded in store/product/knowledge data.

The precise prompts, tool schemas and response schemas live under `src/ai`.

### 6.2 Validation and trust boundaries

- External inputs are validated at application boundaries.
- Model outputs and tool arguments are validated with Zod schemas.
- Model-provided store identifiers are not trusted; store scope is injected by the server.
- Customer messages, seller notes, product text and text found in images are untrusted input and may contain prompt injection.
- The agent must not treat untrusted content as instructions that override system or application rules.
- Missing, unsupported or conflicting facts should result in a clarification/escalation rather than fabricated information.
- The model does not calculate or authoritatively set product prices, order totals, stock or payment status.
- AI-generated product content and translations are subject to the relevant seller review/approval workflow.

### 6.3 AI budget accounting

The product/listing AI budget uses database-backed reservations and settlement:
- Owner daily budget.
- Lower demo-owner daily budget.
- Global daily budget.
- Daily accounting uses the India business day (Asia/Kolkata) where defined by the database functions.
- The application reserves an upper-bound estimate before making a provider call.
- Provider usage is used to settle actual spend.
- Reservations are released or conservatively reconciled on failure/expiry according to the database workflow.
- Concurrent calls are coordinated in PostgreSQL rather than relying on in-memory counters.

The customer-conversation feature also has its own store-scoped/customer usage controls in `conversation_usage` and its migration-defined functions. These controls are distinct from the owner/global product-generation AI budget.

### 6.4 AI configuration

The AI feature group is enabled by configuring:
- `ANTHROPIC_API_KEY`
- `CLAUDE_MODEL` (defaults in code to `claude-haiku-5-5`)

The three owner/demo/global AI budget values have application defaults and are parsed into integer micro-USD. Exact parsing and boot behavior are defined in `src/config/env.js`.

---

## 7. Security, privacy and reliability

### 7.1 Authentication and session security

- Password hashing uses `crypto.scrypt` with per-user random salt and encoded parameters.
- Password verification uses constant-time comparison for equal-length hashes.
- Login failures use a uniform response to reduce account enumeration.
- Password hashing is protected by a bounded queue to constrain concurrent memory use.
- Session tokens are generated from cryptographically secure random bytes.
- Only SHA-256 token hashes are stored in the sessions table.
- Session cookies are HttpOnly, SameSite=Lax and Path=/; HTTPS uses Secure and the `__Host-` prefix.
- Signup is open to the public; it is rate limited and validated with a strict schema.
- Authenticated pages use no-store cache headers.

### 7.2 Tenant isolation

- The authenticated owner and store are resolved server-side.
- Store IDs are not accepted as authority from browser form bodies or model/tool arguments.
- Repository operations scope business data to the resolved store.
- Public store routes resolve the store from the URL slug.
- Order and conversation identifiers/tokens are always resolved with the appropriate store or private-token scope.

### 7.3 Request and output security

- Zod validates external request data and model outputs.
- State-changing browser routes use Origin validation.
- Rate limits apply to relevant authentication, public, AI, order, contact and diagnostics routes.
- Helmet supplies security headers and a Content Security Policy.
- EJS output is escaped; user/model text is not rendered as executable HTML.
- No AI-generated HTML, CSS or JavaScript is executed.
- Private order pages use no-store/noindex and restrictive referrer behavior.
- Signed URLs are used for private product images.

### 7.4 Database security

- Row Level Security is enabled on application tables.
- Application access uses the server-side Supabase service-role credential.
- The service-role key bypasses RLS, so repository-level store scoping is mandatory; RLS and database grants provide additional defense.
- Privileged PostgreSQL functions set a controlled `search_path` and have execution privileges restricted to the service role as defined in the migrations.
- Secrets are environment configuration only and must never appear in source control, browser code or logs.

### 7.5 Logging and errors

- Logs are structured and include correlation identifiers.
- Sensitive values, customer message bodies and phone numbers are redacted/omitted.
- Client error responses expose safe codes/messages and correlation IDs, not stack traces, SQL or provider internals.
- Email/provider failures are recorded safely and do not undo committed business operations.

### 7.6 Accessibility and localization

The interface is designed around:
- Semantic HTML and correct page language attributes.
- Labels and accessible form errors.
- Keyboard-operable controls and visible focus.
- Alternative text for product imagery.
- Responsive, mobile-first layouts.
- Self-hosted Noto Gujarati and Devanagari font assets.
- Contrast checks using the project's domain contrast utilities.
- Layout usability at enlarged zoom levels.

Automated checks are complemented by manual review of actual rendered pages and translations.

### 7.7 Operational constraints

- Persistent application data and images belong in Supabase, not the GoDaddy local filesystem.
- The local filesystem may be used only as temporary scratch space; deployments can replace it.
- The server binds to `process.env.PORT`.
- Outbound calls use bounded timeouts.
- Claude calls should remain within the hosting platform's request constraints.
- Rate limits are currently in-memory and per process; they reset on restart and are not a distributed limiter.
- GoDaddy platform rate limits and runtime behavior are external constraints and should be monitored.

---

## 8. HTTP surface

The following route map reflects the current route declarations. Exact middleware order, validation and response behavior are defined in `src/routes/`.

### 8.1 Public site and storefront

| Method | Path | Purpose |
|---|---|---|
| GET | `/` | Root/platform health response |
| GET | `/health` | Application health/version response |
| GET | `/contact` | Contact form |
| POST | `/contact` | Submit contact message |
| GET | `/contact/sent` | Contact submission confirmation |
| GET | `/robots.txt` | Robots policy |
| GET | `/sitemap.xml` | Public storefront sitemap |
| GET | `/s/:slug` | Public storefront |
| GET | `/s/:slug/p/:productId` | Public product detail |
| GET | `/s/:slug/p/:productId/image` | Private product image delivery |
| GET | `/s/:slug/p/:productId/buy` | Customer checkout |
| POST | `/s/:slug/p/:productId/buy` | Place order request |

### 8.2 Customer chat and private enquiry routes

| Method | Path | Purpose |
|---|---|---|
| GET | `/s/:slug/chat` | Start a customer conversation |
| POST | `/s/:slug/chat` | Create a conversation |
| GET | `/s/:slug/c/:token` | Private conversation page |
| GET | `/s/:slug/c/:token/messages` | Poll conversation messages |
| POST | `/s/:slug/c/:token/messages` | Send a customer message |
| GET | `/s/:slug/q/:token` | Legacy/private enquiry page |
| POST | `/s/:slug/q/:token/answer` | Trigger the enquiry-answer workflow |

Conversation and enquiry tokens are unguessable private links. Their routes use privacy headers; state-changing routes also apply same-origin checks and rate limits.

### 8.3 Customer order access

| Method | Path | Purpose |
|---|---|---|
| GET | `/o/:token` | Private order status page |
| POST | `/o/:token/utr` | Submit payment reference |
| GET | `/o/:token/cancel` | Cancellation confirmation page |
| POST | `/o/:token/cancel` | Customer cancellation |

### 8.4 Owner browser routes

| Method | Path | Purpose |
|---|---|---|
| GET / POST | `/signup` | Owner registration |
| GET / POST | `/login` | Owner login |
| POST | `/logout` | Owner logout |
| GET | `/dashboard` | Owner dashboard |
| GET / POST | `/store/new` | Create store |
| GET / POST | `/store/new/contact` | Onboarding contact details |
| GET / POST | `/store/new/languages` | Prepare language content |
| POST | `/store/new/languages/approve` | Approve onboarding language content |
| GET / POST | `/store/settings` | Store settings |
| POST | `/store/settings/translations` | Save store translation |
| POST | `/store/settings/translations/draft` | Generate store translation draft |
| GET | `/products` | Product list |
| GET | `/products/new` | New product flow |
| POST | `/products/image` | Upload product image |
| GET | `/products/:id/edit` | Edit/review product |
| POST | `/products/:id/generate` | Generate AI listing |
| POST | `/products/:id/save` | Save product review |
| GET / POST | `/products/:id/update-languages` | Review/generate product translations |
| POST | `/products/:id/delete` | Delete product |
| GET / POST | `/store/knowledge` | Shop knowledge |
| POST | `/store/knowledge/rules` | Save bulk-discount rules |
| POST | `/store/knowledge/rules/find` | Extract bulk-discount rules with Claude |
| GET | `/orders` | Owner order list |
| GET | `/orders/:id` | Owner order detail |
| POST | `/orders/:id/paid` | Mark payment received |
| POST | `/orders/:id/not-received` | Mark payment not received |
| GET / POST | `/orders/:id/cancel` | Owner cancellation workflow |
| GET | `/enquiries` | Owner enquiry/conversation inbox |
| GET | `/enquiries/:id` | Enquiry/conversation detail |
| POST | `/enquiries/:id/reply` | Seller reply |
| POST | `/enquiries/:id/handled` | Mark handled |
| POST | `/enquiries/:id/delete` | Delete enquiry/conversation |

The diagnostics endpoint is internal and token-gated when configured: `GET /internal/diagnostics`.

---

## 9. Environment configuration

`src/config/env.js` is the source of truth for environment variable names, defaults, validation and optional groups. The following list describes the current configuration interface.

| Variable | Purpose |
|---|---|
| `NODE_ENV` | Runtime mode; unknown values are normalized to production behavior |
| `PORT` | HTTP port; defaults to 3000 and hosting supplies the deployed port |
| `BASE_URL` | Canonical application URL; HTTPS required outside local development |
| `TRUST_PROXY` | Express proxy trust hop count; defaults to 1 |
| `DIAGNOSTICS_TOKEN` | Optional diagnostics access token; minimum length enforced |
| `SUPABASE_URL` | Supabase project URL; required and HTTPS |
| `SUPABASE_SERVICE_ROLE_KEY` | Server-side Supabase service-role key; required |
| `ALLOWED_ORIGINS` | Optional comma-separated list of additional trusted bare origins |
| `ANTHROPIC_API_KEY` | Enables the AI configuration group |
| `CLAUDE_MODEL` | Claude model; defaults to `claude-haiku-5-5` |
| `AI_DAILY_BUDGET_USD` | Normal owner daily AI budget; default `$1.00` |
| `AI_DEMO_DAILY_BUDGET_USD` | Demo owner daily AI budget; default `$0.50` |
| `AI_GLOBAL_DAILY_BUDGET_USD` | Global daily AI budget; default `$5.00` |
| `EMAIL_RELAY_URL` | Loopback HTTP relay origin; defaults to `http://127.0.0.1:2525` |
| `CONTACT_INBOX_EMAIL` | Destination for public contact-form messages |
| `OWNER_NOTIFY_EMAIL` | Owner notification/fallback and relay-related address |
| `ORDER_LINK_KEY` | Key used by the order-link encryption utility; optional at schema level |
| `EMAIL_WORKER_ENABLED` | Enables/disables the email outbox worker; defaults to `true` |

Supabase configuration is required to start the application. The AI group is optional, but if one of its group members is configured, the required AI group is validated as a whole. Budget variables are independent of AI enablement and have defaults.

Never copy real secret values into this document, `.env.example`, logs, issues or source control. Configure Preview and Publish environments independently.

---

## 10. Testing and quality assurance

The project uses Node's built-in `node:test` runner.

### 10.1 Test layers

- **Unit tests:** domain calculations, validation, formatting, AI cost, prompt/input guards, template behavior and utility modules.
- **Integration tests:** routes, controllers, services, repositories and application workflows using test harnesses/fakes.
- **Security tests:** authentication, session cookies, Origin checks, tenant isolation, secret exposure, safe templates and diagnostics access.
- **Migration-focused tests:** structural assertions for migration SQL and database function contracts.
- **AI-focused tests/evaluations:** bounded cases for output validation, grounding, conflict handling and prompt-injection resistance.

### 10.2 Commands

```bash
npm ci
npm test
npm start
```

Local development:

```bash
npm run dev
```

The package declares Node.js `22.x`. Run tests with the same major runtime used for deployment.

### 10.3 Deployment verification

The application is deployed and the owner has confirmed that the current application is passing tests and working as expected in its deployed environment.

Operational verification should continue to cover:
- Application health and canonical URL.
- Supabase connectivity and persistence.
- Private image upload and signed image display.
- Claude calls and budget behavior when AI is enabled.
- Contact form and email relay/outbox delivery.
- Seller onboarding and product publishing.
- Customer conversation and seller reply.
- Checkout, stock reservation, UTR submission and seller payment resolution.
- Mobile and multilingual rendering.

A repository test, a SQL migration file, a successful deployment and a real end-to-end business workflow are different kinds of evidence; report each accurately.

---

## 11. Current scope boundaries

The following are not represented as implemented capabilities in this specification unless separately added to the source code and tests:

- Customer login/accounts.
- Automated UPI/bank payment verification or payment-gateway settlement.
- Shipping-carrier integration and logistics management.
- Multiple stores per owner.
- Languages beyond English, Gujarati and Hindi.
- Password reset and email verification.
- A separate analytics/BI product.
- Social-network publishing/integrations.
- AI authority to set prices, alter stock, confirm payments or execute other consequential business actions without backend validation.

The application may evolve. Update this section whenever a capability is implemented, deliberately removed or formally brought into scope.

---

## 12. Repository change and maintenance rules

1. Update this document when product behavior, architecture, data ownership, routes, environment configuration or operational workflows change.
2. Keep `CLAUDE.md` focused on standing engineering rules and the developer/agent working agreement. Do not use it as a duplicate feature specification.
3. Keep `docs/DECISIONS.md` as a dated decision/history log, not as the current product specification.
4. Keep migrations numbered and append-only. Do not rewrite an already-applied migration to represent a later schema.
5. Add or update tests with behavior changes.
6. Update `.env.example` when environment variables change, without including real secrets.
7. Document operational assumptions and known limitations explicitly.
8. Do not claim a feature is complete solely because a route, template, migration or test fixture exists; verify the complete workflow.
9. Preserve the current working implementation when doing UI work. UI changes must not silently alter form names, actions, methods, CSRF fields, server-side variables or business behavior.
10. Prefer small, scoped changes over broad refactors, especially near a submission or deployment deadline.

---

## 13. Source-of-truth map

| Topic | Canonical location |
|---|---|
| Standing engineering rules and agent instructions | `CLAUDE.md` |
| Current product and system specification | `SPEC.md` |
| Historical implementation decisions | `docs/DECISIONS.md` |
| Deliberately skipped work | `docs/SKIPPED.md` |
| Route definitions | `src/routes/` |
| Business workflows | `src/services/` |
| Pure business rules | `src/domain/` |
| Supabase access | `src/repositories/` |
| AI prompts, tools and schemas | `src/ai/` |
| Email relay and outbox | `src/email/` |
| Database schema and transactional functions | `db/migrations/` |
| Migration verification | `db/verify/` |
| Automated tests | `tests/` |
| Environment contract | `src/config/env.js` and `.env.example` |
