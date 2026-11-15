import { PG_UNIQUE_VIOLATION } from '../domain/dbConstraints.js';
import { AppError } from '../lib/errors.js';

const HTTP_INTERNAL_ERROR = 500;
const UNKNOWN_CONSTRAINT = 'unknown';
const UNIQUE_MESSAGE = /unique constraint "([^"]+)"/;

/** A unique violation, carrying the violated constraint or index name (or 'unknown'). */
export class UniqueViolation extends Error {
  /** @param {string} constraint */
  constructor(constraint) {
    super('Unique constraint violated');
    this.name = 'UniqueViolation';
    this.constraint = constraint;
  }
}

/**
 * Reads the constraint name from a Postgres unique-violation message such as
 * `duplicate key value violates unique constraint "owners_email_lower_key"`.
 * Only `message` is inspected: `details` contains the offending values (for example the email).
 * @param {unknown} message
 * @returns {string}
 */
export function constraintNameFrom(message) {
  const match = UNIQUE_MESSAGE.exec(typeof message === 'string' ? message : '');
  return match ? match[1] : UNKNOWN_CONSTRAINT;
}

/**
 * Converts a supabase-js error into UniqueViolation (code 23505) or a generic AppError. Does nothing for null.
 * Provider messages and details are never forwarded.
 * @param {{ code?: string, message?: string } | null | undefined} error
 */
export function throwIfError(error) {
  if (!error) return;
  if (error.code === PG_UNIQUE_VIOLATION) throw new UniqueViolation(constraintNameFrom(error.message));
  throw new AppError('DATABASE_ERROR', HTTP_INTERNAL_ERROR, 'Something went wrong', { pgCode: error.code });
}
