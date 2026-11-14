import { randomUUID } from 'node:crypto';

export const CORRELATION_HEADER = 'x-request-id';
const MAX_CORRELATION_ID_LENGTH = 64;
const VALID_CORRELATION_ID = /^[A-Za-z0-9_-]+$/;

/**
 * Accepts a caller-supplied id only if it is short and uses safe characters.
 * @param {unknown} candidate Raw header value.
 * @returns {string} The accepted id, or a fresh UUID.
 */
export function resolveCorrelationId(candidate) {
  const usable =
    typeof candidate === 'string' &&
    candidate.length > 0 &&
    candidate.length <= MAX_CORRELATION_ID_LENGTH &&
    VALID_CORRELATION_ID.test(candidate);
  return usable ? candidate : randomUUID();
}
