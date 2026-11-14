import { CORRELATION_HEADER, resolveCorrelationId } from '../lib/correlation.js';

/**
 * Assigns a correlation id to every request and echoes it in the response.
 * @returns {import('express').RequestHandler}
 */
export function correlationId() {
  return (req, res, next) => {
    const id = resolveCorrelationId(req.get(CORRELATION_HEADER));
    req.correlationId = id;
    res.locals.correlationId = id;
    res.set(CORRELATION_HEADER, id);
    next();
  };
}
