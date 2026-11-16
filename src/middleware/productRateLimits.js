import { createRateLimiter } from './rateLimit.js';

const MS_PER_HOUR = 3_600_000;
export const UPLOAD_LIMITS = Object.freeze({ windowMs: MS_PER_HOUR, limit: 30 });
export const GENERATE_LIMITS = Object.freeze({ windowMs: MS_PER_HOUR, limit: 15 });
export const DRAFT_LIMITS = Object.freeze({ windowMs: MS_PER_HOUR, limit: 10 });

const ownerKey = (req) => req.owner.id;

/**
 * Per-owner limiters for the expensive product and translation-draft endpoints (in-memory: per process, reset on restart). They run after
 * authentication, so the key is the owner id and one owner cannot exhaust another's allowance. The database-backed AI
 * budget remains the real spending control; these only throttle request volume.
 * @param {{ upload?: object, generate?: object, draft?: object }} [overrides] windowMs/limit per limiter.
 */
export function createProductLimiters({ upload, generate, draft } = {}) {
  return {
    upload: createRateLimiter({ ...(upload ?? UPLOAD_LIMITS), keyGenerator: ownerKey }),
    generate: createRateLimiter({ ...(generate ?? GENERATE_LIMITS), keyGenerator: ownerKey }),
    draft: createRateLimiter({ ...(draft ?? DRAFT_LIMITS), keyGenerator: ownerKey }),
  };
}
