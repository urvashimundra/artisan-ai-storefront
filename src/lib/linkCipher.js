import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { isWellFormedToken } from './statusToken.js';

const ALGORITHM = 'aes-256-gcm';
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
/** The key as unpadded base64url: 32 bytes. */
export const LINK_KEY_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/**
 * Encrypts the customer's status token for the order emails, so the database can hold something the worker turns back into the
 * private link without the database ever holding the token itself. AES-256-GCM, a random IV per message, output is
 * base64url(iv | tag | ciphertext). The key lives only in the ORDER_LINK_KEY environment variable.
 * @param {string} key 32 bytes as base64url (LINK_KEY_PATTERN).
 * @returns {{ encrypt: (token: string) => string, decrypt: (encrypted: string) => string | null }}
 */
export function createLinkCipher(key) {
  const keyBytes = Buffer.from(key, 'base64url');
  if (keyBytes.length !== KEY_BYTES) throw new TypeError('ORDER_LINK_KEY must be 32 bytes');
  return {
    encrypt(token) {
      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv(ALGORITHM, keyBytes, iv);
      const body = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64url');
    },

    /** @returns {string | null} The token, or null for anything that is not a valid message under this key (wrong key, tampering, junk). */
    decrypt(encrypted) {
      try {
        const raw = Buffer.from(encrypted, 'base64url');
        const decipher = createDecipheriv(ALGORITHM, keyBytes, raw.subarray(0, IV_BYTES));
        decipher.setAuthTag(raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
        const token = Buffer.concat([decipher.update(raw.subarray(IV_BYTES + TAG_BYTES)), decipher.final()]).toString('utf8');
        return isWellFormedToken(token) ? token : null;
      } catch {
        return null;
      }
    },
  };
}
