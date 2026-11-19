# The Artisan Story — AI Storefront & Business Assistant

> Built for the **GoDaddy Inclusive Innovation Hackathon 2026 — Round 2**.

**The Artisan Story** helps independent artisans in India turn product photos and their stories into an accessible, multilingual online shop. Artisans can publish a storefront, manage products and shop information, respond to customer enquiries, and handle order requests. Customers can discover products, ask questions, and place orders without creating an account.

The product is designed around a simple principle: **AI can assist, but the artisan stays in control of business decisions.**

**Live site:** [theartisanstory.in](https://theartisanstory.in/)  
**Demo video:** _Add the final demo link before submission._

**Languages:** English, Gujarati (ગુજરાતી) and Hindi (हिन्दी)  
**Currency:** INR, represented internally as integer paise.

---

## Contents

- [What it does](#what-it-does)
- [How AI and business decisions work](#how-ai-and-business-decisions-work)
- [Architecture](#architecture)
- [Technology stack](#technology-stack)
- [Getting started](#getting-started)
- [Environment variables](#environment-variables)
- [Database setup](#database-setup)
- [Scripts and tests](#scripts-and-tests)
- [Deploying to GoDaddy](#deploying-to-godaddy-nodejs-hosting)
- [Route overview](#route-overview)
- [Security and privacy](#security-and-privacy)
- [Accessibility and localization](#accessibility-and-localization)
- [Project structure](#project-structure)
- [Project documentation](#project-documentation)
- [Current limitations](#current-limitations)

---

## What it does

### For artisans

- **Guided store setup:** Create a store, configure its contact and UPI details, choose languages, and add shop information.
- **Photo and story to product listing:** Upload a product photo and describe the craft. Claude can propose a title, description and image alt text. The artisan reviews and edits the content; the artisan sets the price and stock.
- **Multilingual product and store content:** Generate English, Gujarati and Hindi content drafts. AI-generated translations remain unapproved until the artisan reviews and approves them.
- **Shop knowledge:** Save FAQs, policies and other shop notes. Text files (`.txt` and `.md`) can be read in the browser and their contents added to the notes.
- **Bulk-discount rules:** Ask Claude to identify explicit discount tiers in the saved notes. The result only prefills an editable form; the artisan must review and save the rules before the assistant can use them.
- **Orders and stock:** Review orders, see customer payment references, and mark payments received or not received. Stock is reserved for the configured payment window (10 minutes in the current order workflow) and restored when an eligible order is cancelled or expires.
- **Customer conversations:** Review customer conversations, including conversations escalated by the assistant, and reply as the seller.
- **Email notifications:** Order and seller notifications are queued through a persistent outbox and delivered through the configured GoDaddy hosting mail relay.

### For customers — no account required

- A mobile-first storefront at `/s/:slug`, with a language switcher, six storefront colour themes and signed product-image URLs.
- Product detail pages with product information, images and a checkout flow.
- A private order-status page at `/o/:token`, where a customer can submit a UPI transaction reference or cancel an eligible order.
- A store-specific AI assistant that answers using the artisan's published product information, current stock and prices, and saved shop knowledge. If it cannot answer safely, it escalates the conversation instead of inventing information.
- WhatsApp and sharing actions where configured, plus a public contact form on the main site.

### UPI payment workflow

The application displays the store's UPI payment details and QR instructions. It is **not a payment gateway** and does not automatically verify bank transfers. The customer pays outside the application and submits a UTR/payment reference. The artisan independently checks the transaction and records the payment outcome in the owner dashboard.

---

## How AI and business decisions work

| Component | Responsibility |
|---|---|
| **Claude** | Proposes product content, translations and discount-rule drafts; answers customer questions using permitted, store-scoped information. |
| **Backend** | Validates inputs and model outputs, computes money and quotes, enforces limits, and performs deterministic business operations. |
| **Artisan** | Reviews and approves product content and translations, saves discount rules, and confirms payment after checking the transaction independently. |
| **Database** | Source of truth for store data, products, conversations, orders, stock and usage accounting. |

### Important safeguards

- **The model does not set money.** Product prices are entered by the artisan. Customer-facing monetary values are calculated by application code and represented to the model through server-managed placeholders. Unverified amounts or unsupported discounts cause the answer to be rejected or escalated.
- **The model does not control stock or payment state.** Order totals, stock reservation/restoration and payment resolution are performed by validated backend/database operations.
- **Grounded answers only.** Customer responses use store-scoped product and knowledge data. Conflicting or missing facts are escalated instead of silently guessed.
- **Prompt-injection resistance.** Customer messages, product text, image text and owner notes are treated as untrusted data.
- **Bounded AI spend.** Database-backed reservations and settlement enforce per-owner, demo-owner and global daily AI budgets. Customer conversation usage has separate controls.
- **Seller review remains essential.** AI-generated product and translation content is not treated as approved merely because it was generated.

Useful implementation references include `src/ai/moneyPlaceholders.js`, `src/ai/unitConflict.js`, `src/ai/scriptCheck.js`, and the budget services and SQL functions.

---

## Architecture

```text
Customer / artisan browser
        |
        | HTTPS
        v
GoDaddy Node.js hosting
        |
        v
Express 5 application
        |
        +--> Routes
        |      |
        |      v
        |   Controllers (HTTP only)
        |      |
        |      v
        |   Services (application workflows)
        |      |
        |      +--> Domain modules (pure business rules)
        |      +--> AI modules (Claude, prompts, tools, schemas)
        |      +--> Email modules (outbox worker and HTTP relay)
        |      |
        |      v
        |   Repositories (only layer that accesses Supabase)
        |      |
        |      v
        |   Supabase Cloud
        |      +--> PostgreSQL
        |      +--> Private Storage
        |
        +--> Anthropic Claude API
        |
        +--> GoDaddy hosting mail relay
```

Layering is intentional: controllers handle HTTP concerns, services coordinate workflows, domain modules contain pure logic, and repositories own Supabase access. AI integrations live under `src/ai`; email delivery lives under `src/email`.

---

## Technology stack

| Area | Technology |
|---|---|
| Runtime | Node.js 22.x, ES modules |
| Server | Express 5 |
| Views | EJS |
| Browser code | Vanilla JavaScript |
| Styling | CSS, shared design tokens |
| Database | Supabase Cloud / PostgreSQL |
| File storage | Supabase Storage, private bucket |
| Database client | `@supabase/supabase-js` over HTTPS |
| AI | Anthropic SDK / Claude |
| Validation | Zod 4 |
| Security headers | Helmet |
| Rate limiting | `express-rate-limit` and application limiters |
| UPI QR | `qrcode` |
| Tests | Node.js built-in `node:test` |

There is no React application, frontend framework, CSS framework or frontend build pipeline.

Owner authentication is implemented by the application rather than Supabase Auth: passwords use `crypto.scrypt`; random session tokens are stored as SHA-256 hashes in the database; cookies are HttpOnly and SameSite=Lax, and HTTPS uses Secure cookies with the `__Host-` prefix.

---

## Getting started

### Prerequisites

- Node.js 22.x
- A Supabase project
- An Anthropic API key for AI functionality
- Git

### Setup

```bash
git clone https://github.com/urvashimundra/artisan-ai-storefront
cd artisan-ai-storefront
npm ci
cp .env.example .env
```

1. Create a Supabase project and apply the numbered SQL migrations in order. See [Database setup](#database-setup).
2. Configure at least `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` and `BASE_URL` in `.env`.
3. Configure `ANTHROPIC_API_KEY` to enable AI features.
4. Set `SIGNUP_INVITE_CODE` if you want to enable owner signup. Without it, signup is disabled.
5. Start the application:

```bash
npm run dev
# or
npm start
```

Open `http://localhost:3000`. If signup is enabled, visit `/signup` and use the configured invite code.

### Optional demo owner

Set `DEMO_OWNER_EMAIL` and `DEMO_OWNER_PASSWORD` in `.env`, then run:

```bash
node --env-file=.env scripts/seed-demo.js
```

The seed script creates the demo owner/store idempotently. The demo owner has a lower AI budget.

### Connectivity smoke test

```bash
node --env-file=.env scripts/smoke.js
```

The smoke script checks configured Supabase and Claude connectivity. It does not send email. The email relay is provided by the hosted GoDaddy runtime; local email delivery depends on whether a compatible relay is available.

---

## Environment variables

`.env.example` documents the environment interface. Never commit `.env` or place real secrets in source control.

| Variable | Purpose |
|---|---|
| `NODE_ENV` | Runtime mode (`development`, `test` or `production`) |
| `PORT` | HTTP port; defaults to `3000`, and GoDaddy supplies the deployed value |
| `BASE_URL` | Canonical application URL; HTTPS in hosted environments |
| `TRUST_PROXY` | Number of trusted reverse-proxy hops; defaults to `1` |
| `SUPABASE_URL` | Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Server-side service-role key; never expose to the browser |
| `ANTHROPIC_API_KEY` | Enables Claude-powered features |
| `CLAUDE_MODEL` | Claude model; defaults to `claude-haiku-5-5` |
| `SIGNUP_INVITE_CODE` | Enables owner signup when configured (minimum 16 characters) |
| `ALLOWED_ORIGINS` | Additional trusted origins, comma-separated |
| `AI_DAILY_BUDGET_USD` | Normal owner daily AI budget; default `1.00` |
| `AI_DEMO_DAILY_BUDGET_USD` | Demo owner daily AI budget; default `0.50` |
| `AI_GLOBAL_DAILY_BUDGET_USD` | Global daily AI budget; default `5.00` |
| `ORDER_LINK_KEY` | Key used to protect private order-link material |
| `EMAIL_RELAY_URL` | HTTP email relay origin; defaults to `http://127.0.0.1:2525` |
| `EMAIL_WORKER_ENABLED` | Enables/disables the outbox worker; defaults to `true` |
| `CONTACT_INBOX_EMAIL` | Contact-form destination |
| `OWNER_NOTIFY_EMAIL` | Owner notification/fallback address |
| `DIAGNOSTICS_TOKEN` | Optional token for the internal diagnostics endpoint |
| `DEMO_OWNER_EMAIL` | Used only by the demo seed script |
| `DEMO_OWNER_PASSWORD` | Used only by the demo seed script |

The exact validation rules and defaults are defined in `src/config/env.js`. Configure Preview and Publish environment variables independently in GoDaddy. Use raw values without wrapping them in quotes unless the platform explicitly requires quoting.

Generate a 32-byte base64url `ORDER_LINK_KEY` with:

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
```

---

## Database setup

Database changes are numbered SQL files in `db/migrations/`. Apply them in order using the project's database deployment procedure.

| Directory | Purpose |
|---|---|
| `db/migrations/` | Numbered schema, constraint and PostgreSQL function migrations |
| `db/verify/` | Read-only checks for migration/schema expectations |
| `db/test/` | Database smoke and concurrency checks; use a non-production project |
| `db/rollback/` | Explicit rollback material for the migration(s) documented there |

The migration history covers owners and sessions, stores, AI budget accounting, products and translations, storefront settings, orders and stock reservations, email outbox/contact messages, shop knowledge/enquiries, persistent conversations, UTR-attempt handling and translation-draft persistence.

Migration `014` is a legacy-enquiry-to-conversation backfill and is documented as optional in the migration notes. Check the migration comments and matching verification scripts before applying or rolling back any migration.

Important database properties:
- Application tables use Row Level Security.
- The server uses the Supabase service-role key, which bypasses RLS; repository-level store scoping is therefore mandatory.
- The product-image Storage bucket is private; the application serves images using signed URLs.
- Privileged functions set a controlled `search_path` and restrict execution privileges as defined by the migrations.
- Multi-step operations that require atomicity use PostgreSQL functions/RPCs.

---

## Scripts and tests

| Command | Purpose |
|---|---|
| `npm start` | Start the server |
| `npm run dev` | Start with `.env` and file watching |
| `npm test` | Run the full Node test suite |
| `npm run build` | Required hosting build hook; currently a no-op |
| `node --env-file=.env scripts/smoke.js` | Check configured Supabase and Claude connectivity |
| `node --env-file=.env scripts/seed-demo.js` | Seed the demo owner/store |
| `node --env-file=.env scripts/ai-eval-grounding.js` | Run a bounded live grounding evaluation; uses real API credits |

Run the full suite with:

```bash
npm ci
npm test
```

Tests are organized under `tests/unit`, `tests/integration` and `tests/security`. Most automated tests use fakes and do not require network access, a live database or API keys. The live AI evaluation is separate and consumes provider credits.

---

## Deploying to GoDaddy Node.js hosting

1. Configure environment variables separately for Preview and Publish.
2. The hosting platform runs the build hook and `npm start`; it supplies `PORT`.
3. The server binds to `process.env.PORT`.
4. The platform health checks use `GET /` and `GET /health`.
5. Configure the custom domain and set `BASE_URL` and `ALLOWED_ORIGINS` to the deployed origin.
6. Verify the deployment using the application's health route and the project smoke/acceptance checks.
7. Keep diagnostics access disabled or remove `DIAGNOSTICS_TOKEN` from Publish unless it is intentionally required.

### Hosting considerations

- The local filesystem is not durable across deployments. Store application data, sessions, images and drafts in Supabase; use local disk only for temporary scratch data.
- Email is queued in `email_outbox` and delivered by the background worker through the configured HTTP relay. Do not assume direct outbound SMTP is available from the hosting environment.
- Keep individual Claude calls bounded by the hosting request/runtime constraints.
- GoDaddy platform rate limits are external to the application. Application-side rate limiting and conservative AI usage remain important.
- Exclude `node_modules`, `.env` and `.git` from deployment ZIPs.

---

## Route overview

| Area | Routes |
|---|---|
| Main site | `/`, `/health`, `/contact`, `/contact/sent`, `/robots.txt`, `/sitemap.xml` |
| Public storefront | `/s/:slug`, `/s/:slug/p/:productId`, `/s/:slug/p/:productId/image` |
| Customer checkout | `/s/:slug/p/:productId/buy` |
| Customer chat | `/s/:slug/chat`, `/s/:slug/c/:token`, `/s/:slug/c/:token/messages` |
| Legacy/private enquiry answer | `/s/:slug/q/:token`, `/s/:slug/q/:token/answer` |
| Customer order access | `/o/:token`, `/o/:token/utr`, `/o/:token/cancel` |
| Owner authentication | `/signup`, `/login`, `/logout` |
| Owner dashboard and store | `/dashboard`, `/store/new`, `/store/new/contact`, `/store/new/languages`, `/store/settings` |
| Products | `/products`, `/products/new`, `/products/:id/edit`, `/products/:id/generate`, `/products/:id/save`, `/products/:id/update-languages` |
| Shop knowledge | `/store/knowledge`, `/store/knowledge/rules`, `/store/knowledge/rules/find` |
| Owner orders | `/orders`, `/orders/:id`, `/orders/:id/paid`, `/orders/:id/not-received`, `/orders/:id/cancel` |
| Owner enquiries/conversations | `/enquiries`, `/enquiries/:id`, `/enquiries/:id/reply`, `/enquiries/:id/handled`, `/enquiries/:id/delete` |
| Internal | `/internal/diagnostics` (token-gated when configured) |

The route files under `src/routes/` are authoritative for HTTP methods, middleware and exact behavior.

---

## Security and privacy

- **Tenant isolation:** Store scope is resolved server-side from the authenticated session or public store slug. Never trust a store ID from a request body or model arguments.
- **Input validation:** Validate HTTP inputs, environment variables, tool arguments and model outputs at boundaries using Zod.
- **Output safety:** EJS escapes output by default. Never render user- or model-provided text as executable HTML, CSS or JavaScript.
- **Request origin:** State-changing browser routes validate request origin; SameSite cookies provide an additional layer.
- **Rate limiting:** Limits protect authentication, public actions, AI generation, chat, checkout and contact routes.
- **Private links:** Customer order and conversation links use unguessable tokens and privacy-oriented response headers.
- **Secrets:** Keep credentials in environment variables. The Supabase service-role key and Anthropic key are server-side only.
- **Logging:** Structured logs include correlation identifiers and avoid secrets, full customer messages and phone numbers.
- **Contact form:** Includes abuse controls such as a honeypot and rate limits.

---

## Accessibility and localization

The interface is designed with:
- Semantic HTML and the correct page `lang` attribute.
- Form labels and accessible validation feedback.
- Keyboard-operable controls and visible focus states.
- Alternative text for product images.
- Skip links and live regions for relevant progress/errors.
- Mobile-first layouts and support for 200% zoom.
- Six storefront themes with contrast checks in `src/domain/contrast.js`.
- Self-hosted Noto Gujarati and Devanagari fonts.

AI-generated Gujarati and Hindi content should still be reviewed by a fluent speaker before public use.

---

## Project structure

```text
src/
  server.js             process entry point
  app.js                Express application factory
  composition.js        dependency wiring
  config/               validated environment configuration
  routes/               HTTP route declarations
  controllers/          HTTP request/response handling
  services/             application workflows
  repositories/         Supabase access
  domain/               pure business rules and calculations
  ai/                   Claude client, prompts, tools and schemas
  email/                email outbox and relay
  middleware/           authentication, security and request middleware
  lib/                  shared utilities
  views/                EJS templates and partials
public/                 CSS, browser JavaScript, fonts and static assets
db/
  migrations/           numbered PostgreSQL migrations
  verify/               read-only migration checks
  test/                 database smoke/concurrency checks
  rollback/             documented rollback scripts
scripts/                 smoke, seed and evaluation scripts
tests/
  unit/
  integration/
  security/
docs/                    engineering decisions and historical plans
design/onboarding/       UI reference screens
```

---

## Project documentation

| File | Purpose |
|---|---|
| [`SPEC.md`](SPEC.md) | Current-state product, behavior, architecture and data specification |
| [`CLAUDE.md`](CLAUDE.md) | Standing engineering rules and instructions for coding agents |
| [`docs/DECISIONS.md`](docs/DECISIONS.md) | Historical decision log; entries are point-in-time records |
| [`docs/SKIPPED.md`](docs/SKIPPED.md) | UI redesign items deliberately deferred, with reasons |
| [`docs/MODULE1_PLAN.md`](docs/MODULE1_PLAN.md) | Archived implementation plan and progress record for Module 1 |

---

## Current limitations

- No customer account system, password reset or email-verification flow.
- No online payment gateway or automatic UPI/bank verification; the artisan confirms payment manually.
- One store per owner.
- Application rate limits are in-memory and per process; they reset on restart and are not shared across multiple instances.
- Email delivery depends on the hosting relay. The application records delivery attempts, but does not provide a full bounce/complaint-management system.
- Gujarati and Hindi interface text and AI-generated notices should receive native-speaker review.
- Product search has English-oriented stemming behavior.

---

## License

Private hackathon submission. All rights reserved unless the repository owner states otherwise.
