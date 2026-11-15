import { createHash } from 'node:crypto';
import { ipKeyGenerator } from 'express-rate-limit';
import { normalizeEmail } from '../domain/credentialRules.js';
import { createRateLimiter } from './rateLimit.js';

const MS_PER_MINUTE = 60_000;
export const LOGIN_FAILURE_LIMITS = Object.freeze({ windowMs: 15 * MS_PER_MINUTE, limit: 5 });
export const LOGIN_IP_LIMITS = Object.freeze({ windowMs: 15 * MS_PER_MINUTE, limit: 30 });
export const SIGNUP_LIMITS = Object.freeze({ windowMs: 60 * MS_PER_MINUTE, limit: 10 });
const HTTP_UNAUTHORIZED = 401;

function failureKey(req) {
  const email = typeof req.body?.email === 'string' ? normalizeEmail(req.body.email) : '';
  return `${ipKeyGenerator(req.ip)}|${createHash('sha256').update(email).digest('hex')}`;
}

/**
 * Login and signup limiters (in-memory; per process, reset on restart).
 * - loginFailure: keyed by IP AND email together (never email alone, so nobody can lock out an account from
 *   elsewhere). Counts only 401 credential failures: successes, validation errors and 503 BUSY are skipped.
 * - loginIp: looser per-IP limit on all login attempts.
 * - signup: per-IP limit.
 * @param {{ loginFailure?: object, loginIp?: object, signup?: object }} [overrides] windowMs/limit per limiter.
 */
export function createAuthLimiters({ loginFailure, loginIp, signup } = {}) {
  return {
    loginFailure: createRateLimiter({
      ...(loginFailure ?? LOGIN_FAILURE_LIMITS),
      keyGenerator: failureKey,
      skipSuccessfulRequests: true,
      requestWasSuccessful: (_req, res) => res.statusCode !== HTTP_UNAUTHORIZED,
    }),
    loginIp: createRateLimiter(loginIp ?? LOGIN_IP_LIMITS),
    signup: createRateLimiter(signup ?? SIGNUP_LIMITS),
  };
}
