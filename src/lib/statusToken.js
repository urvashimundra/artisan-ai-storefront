import { createHash, randomBytes } from 'node:crypto';

const TOKEN_BYTES = 32;
/** 32 bytes as unpadded base64url. */
export const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/** @returns {string} A new unguessable status token (32 random bytes, base64url). Shown only in the customer's link. */
export const generateStatusToken = () => randomBytes(TOKEN_BYTES).toString('base64url');

/**
 * @param {string} token
 * @returns {string} Lowercase hex SHA-256. This is the only form that is stored or looked up.
 */
export const hashStatusToken = (token) => createHash('sha256').update(token, 'utf8').digest('hex');

/** @param {unknown} value @returns {boolean} True only for a well-formed token (checked before any lookup). */
export const isWellFormedToken = (value) => typeof value === 'string' && TOKEN_PATTERN.test(value);
