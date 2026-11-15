import { ZodError } from 'zod';
import { AppError, notFound } from '../lib/errors.js';

const HTTP_BAD_REQUEST = 400;
const HTTP_PAYLOAD_TOO_LARGE = 413;
const HTTP_INTERNAL_ERROR = 500;
export const RETRY_AFTER_SECONDS = 5;
const JSON_ONLY_PREFIXES = ['/api', '/internal', '/health'];
const PAGE_TITLES = { 403: 'Not allowed', 404: 'Page not found', 429: 'Too many requests', 503: 'Server busy' };
const DEFAULT_PAGE_TITLE = 'Something went wrong';
const GENERIC_MESSAGE = 'Something went wrong';
const BODY_PARSER_ERRORS = {
  'entity.too.large': new AppError('PAYLOAD_TOO_LARGE', HTTP_PAYLOAD_TOO_LARGE, 'Request body is too large'),
  'entity.parse.failed': new AppError('INVALID_JSON', HTTP_BAD_REQUEST, 'Request body is not valid JSON'),
};

/**
 * 404 for unmatched routes (rendered as HTML or JSON by the central error handler).
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

function wantsHtml(req) {
  const jsonOnly = JSON_ONLY_PREFIXES.some((prefix) => req.path === prefix || req.path.startsWith(`${prefix}/`));
  return !jsonOnly && req.accepts(['json', 'html']) === 'html';
}

function respond(req, res, appError, fields) {
  const status = appError.httpStatus;
  if (appError.code === 'BUSY') res.set('Retry-After', String(RETRY_AFTER_SECONDS));
  const body = { code: appError.code, message: appError.message, correlationId: req.correlationId };
  if (fields) body.details = fields;
  const sendJson = () => res.status(status).json({ error: body });
  if (!wantsHtml(req)) return sendJson();
  const page = { title: PAGE_TITLES[status] ?? DEFAULT_PAGE_TITLE, status, message: appError.message, correlationId: req.correlationId };
  return res.status(status).render('error', page, (renderError, html) => (renderError ? sendJson() : res.send(html)));
}

/**
 * Central error handler. Renders an HTML page for browsers and JSON for /api, /internal, /health and clients that
 * do not ask for HTML. Both carry the correlation id. Never exposes stacks, SQL, provider errors or internal details.
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
    return respond(req, res, appError, fields);
  };
}
