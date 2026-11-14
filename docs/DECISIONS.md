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
