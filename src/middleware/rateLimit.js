import rateLimit from 'express-rate-limit';
import { tooManyRequests } from '../lib/errors.js';

/**
 * Creates a per-client rate limiter that reports through the central error handler.
 * Each call creates an independent in-memory counter.
 * @param {{ windowMs: number, limit: number }} options
 * @returns {import('express').RequestHandler}
 */
export function createRateLimiter({ windowMs, limit }) {
  return rateLimit({
    windowMs,
    limit,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    handler: (_req, _res, next) => next(tooManyRequests()),
  });
}
