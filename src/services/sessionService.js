import { createHash, randomBytes } from 'node:crypto';

export const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;
const SESSION_TOKEN_BYTES = 32;
const MS_PER_SECOND = 1000;
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/;

/**
 * SHA-256 of a session token, hex encoded. Only this value is stored.
 * @param {string} token
 * @returns {string}
 */
export function hashToken(token) {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Session lifecycle. Tokens are 32 random bytes (base64url); a new one is issued on every login.
 * @param {{ sessions: ReturnType<import('../repositories/sessionRepository.js').createSessionRepository>,
 *   owners: ReturnType<import('../repositories/ownerRepository.js').createOwnerRepository>,
 *   now?: () => number, randomToken?: () => string }} deps
 */
export function createSessionService({
  sessions,
  owners,
  now = Date.now,
  randomToken = () => randomBytes(SESSION_TOKEN_BYTES).toString('base64url'),
}) {
  return {
    /**
     * Creates a session and removes this owner's expired sessions.
     * @param {string} ownerId
     * @returns {Promise<{ token: string }>} The raw token, returned once and never stored.
     */
    async create(ownerId) {
      const issuedAt = now();
      await sessions.deleteExpiredForOwner(ownerId, new Date(issuedAt).toISOString());
      const token = randomToken();
      const expiresAt = new Date(issuedAt + SESSION_TTL_SECONDS * MS_PER_SECOND).toISOString();
      await sessions.insert({ ownerId, tokenHash: hashToken(token), expiresAt });
      return { token };
    },

    /**
     * Resolves a cookie token to its owner. Missing, unknown and expired tokens give null; an expired row is deleted.
     * @param {string | undefined} token
     * @returns {Promise<{ id: string, isDemo: boolean } | null>}
     */
    async resolve(token) {
      if (typeof token !== 'string' || !TOKEN_SHAPE.test(token)) return null;
      const session = await sessions.findByTokenHash(hashToken(token));
      if (!session) return null;
      if (Date.parse(session.expiresAt) <= now()) {
        await sessions.deleteById(session.id);
        return null;
      }
      const owner = await owners.findById(session.ownerId);
      return owner ? { id: owner.id, isDemo: owner.isDemo } : null;
    },

    /** @param {string | undefined} token Deletes the session row for this token, if any. */
    async destroy(token) {
      if (typeof token !== 'string' || !TOKEN_SHAPE.test(token)) return;
      await sessions.deleteByTokenHash(hashToken(token));
    },
  };
}
