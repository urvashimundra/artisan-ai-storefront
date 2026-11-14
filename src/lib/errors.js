const HTTP_BAD_REQUEST = 400;
const HTTP_UNAUTHORIZED = 401;
const HTTP_FORBIDDEN = 403;
const HTTP_NOT_FOUND = 404;
const HTTP_CONFLICT = 409;
const HTTP_TOO_MANY_REQUESTS = 429;

/**
 * Application error. `message` is safe to show to clients; `details` is for logs only.
 */
export class AppError extends Error {
  /**
   * @param {string} code Stable machine-readable code.
   * @param {number} httpStatus HTTP status to respond with.
   * @param {string} safeMessage Message that is safe to return to clients.
   * @param {unknown} [details] Internal context, never sent to clients.
   */
  constructor(code, httpStatus, safeMessage, details) {
    super(safeMessage);
    this.name = 'AppError';
    this.code = code;
    this.httpStatus = httpStatus;
    this.details = details;
  }
}

/** @param {string} [message] @param {unknown} [details] @returns {AppError} */
export const notFound = (message = 'Resource not found', details) =>
  new AppError('NOT_FOUND', HTTP_NOT_FOUND, message, details);

/** @param {string} [message] @param {unknown} [details] @returns {AppError} */
export const badRequest = (message = 'Bad request', details) =>
  new AppError('BAD_REQUEST', HTTP_BAD_REQUEST, message, details);

/** @param {string} [message] @param {unknown} [details] @returns {AppError} */
export const unauthorized = (message = 'Authentication required', details) =>
  new AppError('UNAUTHORIZED', HTTP_UNAUTHORIZED, message, details);

/** @param {string} [message] @param {unknown} [details] @returns {AppError} */
export const forbidden = (message = 'Forbidden', details) =>
  new AppError('FORBIDDEN', HTTP_FORBIDDEN, message, details);

/** @param {string} [message] @param {unknown} [details] @returns {AppError} */
export const conflict = (message = 'Conflict', details) =>
  new AppError('CONFLICT', HTTP_CONFLICT, message, details);

/** @param {string} [message] @param {unknown} [details] @returns {AppError} */
export const tooManyRequests = (message = 'Too many requests, please try again later', details) =>
  new AppError('TOO_MANY_REQUESTS', HTTP_TOO_MANY_REQUESTS, message, details);
