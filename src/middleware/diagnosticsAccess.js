import { createHash, timingSafeEqual } from 'node:crypto';
import { notFound, unauthorized } from '../lib/errors.js';

export const DIAGNOSTICS_HEADER = 'x-diagnostics-token';

const digest = (value) => createHash('sha256').update(value).digest();

/**
 * Compares secrets in constant time by hashing both to equal-length digests first.
 * @param {string} supplied
 * @param {string} expected
 * @returns {boolean}
 */
export function tokensMatch(supplied, expected) {
  return timingSafeEqual(digest(supplied), digest(expected));
}

/**
 * Hides the diagnostics route entirely (404) when no token is configured.
 * @param {string | undefined} configuredToken
 * @returns {import('express').RequestHandler}
 */
export function requireDiagnosticsEnabled(configuredToken) {
  return (_req, _res, next) => (configuredToken ? next() : next(notFound('Route not found')));
}

/**
 * Requires the x-diagnostics-token header to match the configured token.
 * @param {string} configuredToken
 * @returns {import('express').RequestHandler}
 */
export function requireDiagnosticsToken(configuredToken) {
  return (req, _res, next) => {
    const supplied = req.get(DIAGNOSTICS_HEADER);
    const accepted = typeof supplied === 'string' && tokensMatch(supplied, configuredToken);
    next(accepted ? undefined : unauthorized('Invalid or missing diagnostics token'));
  };
}
