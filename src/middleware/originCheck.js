import { forbidden } from '../lib/errors.js';

const STATE_CHANGING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const SAME_ORIGIN = 'same-origin';

/**
 * CSRF defence for state-changing requests. The Origin header must exactly match one of the configured
 * origins (BASE_URL plus ALLOWED_ORIGINS, resolved at startup). If Origin is absent, `Sec-Fetch-Site` must be
 * exactly `same-origin`. Forwarded headers and the Host header are never consulted.
 * @param {string[]} allowedOrigins Bare origins from validated config.
 * @returns {import('express').RequestHandler}
 */
export function originCheck(allowedOrigins) {
  const allowed = new Set(allowedOrigins);
  return (req, _res, next) => {
    if (!STATE_CHANGING_METHODS.has(req.method)) return next();
    const origin = req.get('origin');
    const trusted = origin === undefined ? req.get('sec-fetch-site') === SAME_ORIGIN : allowed.has(origin);
    return next(trusted ? undefined : forbidden('The request origin is not allowed'));
  };
}
