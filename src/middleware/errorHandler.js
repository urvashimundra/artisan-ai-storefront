import { ZodError } from 'zod';
import { AppError, notFound } from '../lib/errors.js';

const HTTP_BAD_REQUEST = 400;
const HTTP_PAYLOAD_TOO_LARGE = 413;
const HTTP_INTERNAL_ERROR = 500;
const GENERIC_MESSAGE = 'Something went wrong';
const BODY_PARSER_ERRORS = {
  'entity.too.large': new AppError('PAYLOAD_TOO_LARGE', HTTP_PAYLOAD_TOO_LARGE, 'Request body is too large'),
  'entity.parse.failed': new AppError('INVALID_JSON', HTTP_BAD_REQUEST, 'Request body is not valid JSON'),
};

/**
 * JSON 404 for unmatched routes.
 * @returns {import('express').RequestHandler}
 */
export function notFoundHandler() {
  return (_req, _res, next) => next(notFound('Route not found'));
}

function fromZod(error) {
  const fields = error.issues.map((issue) => ({ path: issue.path.join('.'), code: issue.code }));
  return { appError: new AppError('VALIDATION_ERROR', HTTP_BAD_REQUEST, 'Request validation failed'), fields };
}

function fromBodyParser(error) {
  const known = BODY_PARSER_ERRORS[error.type];
  if (known) return known;
  const isClientError = error.statusCode >= HTTP_BAD_REQUEST && error.statusCode < HTTP_INTERNAL_ERROR;
  return isClientError ? new AppError('BAD_REQUEST', HTTP_BAD_REQUEST, 'Bad request') : null;
}

function toSafeError(error) {
  if (error instanceof AppError) return { appError: error };
  if (error instanceof ZodError) return fromZod(error);
  const parsed = typeof error?.type === 'string' ? fromBodyParser(error) : null;
  if (parsed) return { appError: parsed };
  return { appError: new AppError('INTERNAL_ERROR', HTTP_INTERNAL_ERROR, GENERIC_MESSAGE) };
}

/**
 * Central error handler. Never exposes stacks, SQL, provider errors or internal details.
 * @param {ReturnType<import('../lib/logger.js').createLogger>} logger
 * @returns {import('express').ErrorRequestHandler}
 */
export function errorHandler(logger) {
  return (error, req, res, next) => {
    if (res.headersSent) return next(error);
    const { appError, fields } = toSafeError(error);
    const log = req.log ?? logger;
    const level = appError.httpStatus >= HTTP_INTERNAL_ERROR ? 'error' : 'warn';
    log[level]('request failed', {
      correlationId: req.correlationId,
      code: appError.code,
      status: appError.httpStatus,
      err: appError.code === 'INTERNAL_ERROR' ? error : undefined,
    });
    const body = { code: appError.code, message: appError.message, correlationId: req.correlationId };
    if (fields) body.details = fields;
    return res.status(appError.httpStatus).json({ error: body });
  };
}
