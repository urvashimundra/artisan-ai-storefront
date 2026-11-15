const NANOSECONDS_PER_MILLISECOND = 1_000_000n;

function countForwardedHops(header) {
  if (typeof header !== 'string') return 0;
  return header.split(',').filter((entry) => entry.trim() !== '').length;
}

/**
 * Logs one structured line per finished request. Query strings and bodies are never logged. The client IP (req.ip) is logged, plus only the
 * NUMBER of X-Forwarded-For entries, never the raw header.
 * @param {ReturnType<import('../lib/logger.js').createLogger>} logger
 * @returns {import('express').RequestHandler}
 */
export function requestLogger(logger) {
  return (req, res, next) => {
    const startedAt = process.hrtime.bigint();
    req.log = logger.child({ correlationId: req.correlationId });
    res.on('finish', () => {
      const durationMs = Number((process.hrtime.bigint() - startedAt) / NANOSECONDS_PER_MILLISECOND);
      req.log.info('request completed', {
        method: req.method,
        path: req.originalUrl.split('?')[0],
        status: res.statusCode,
        ip: req.ip,
        xffHops: countForwardedHops(req.headers['x-forwarded-for']),
        durationMs,
      });
    });
    next();
  };
}
