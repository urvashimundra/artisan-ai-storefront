import { randomUUID } from 'node:crypto';
import {
  OWNERS_EMAIL_LOWER_KEY,
  SESSIONS_TOKEN_HASH_KEY,
  STORES_OWNER_ID_KEY,
  STORES_SLUG_KEY,
} from '../../src/domain/dbConstraints.js';
import { createJobQueue, createPasswordService } from '../../src/lib/password.js';
import { UniqueViolation } from '../../src/repositories/pgErrors.js';
import { createAuthService } from '../../src/services/authService.js';
import { createSessionService } from '../../src/services/sessionService.js';
import { createStoreService } from '../../src/services/storeService.js';
import { createStoreTranslationService } from '../../src/services/storeTranslationService.js';
import { requireStoreId } from '../../src/repositories/requireStoreId.js';

export const CHEAP_PARAMS = Object.freeze({ N: 16, r: 1, p: 1 });
export const INVITE_CODE = 'test-invite-code-0123456789';

/**
 * In-memory owner repository enforcing the lower(email) unique index.
 * `precheckBarrier: n` makes findByEmail wait until n calls have arrived, to force a signup race.
 */
export function createFakeOwners({ precheckBarrier = 0 } = {}) {
  const rows = [];
  const calls = [];
  let arrivals = 0;
  let open;
  const gate = new Promise((resolve) => (open = resolve));
  const view = (row) => (row ? { id: row.id, email: row.email, passwordHash: row.passwordHash, isDemo: row.isDemo } : null);
  return {
    rows,
    calls,
    async findByEmail(email) {
      calls.push('findByEmail');
      arrivals += 1;
      if (precheckBarrier && arrivals >= precheckBarrier) open();
      if (precheckBarrier) await gate;
      return view(rows.find((row) => row.email === email));
    },
    async findById(id) {
      calls.push('findById');
      return view(rows.find((row) => row.id === id));
    },
    async insert({ email, passwordHash, isDemo }) {
      calls.push('insert');
      if (rows.some((row) => row.email.toLowerCase() === email.toLowerCase())) {
        throw new UniqueViolation(OWNERS_EMAIL_LOWER_KEY);
      }
      const row = { id: randomUUID(), email, passwordHash, isDemo };
      rows.push(row);
      return { id: row.id };
    },
  };
}

/** In-memory session repository. */
export function createFakeSessions() {
  const rows = [];
  const deleted = [];
  return {
    rows,
    deleted,
    async insert({ ownerId, tokenHash, expiresAt }) {
      if (rows.some((row) => row.tokenHash === tokenHash)) throw new UniqueViolation(SESSIONS_TOKEN_HASH_KEY);
      rows.push({ id: randomUUID(), ownerId, tokenHash, expiresAt });
    },
    async findByTokenHash(tokenHash) {
      return rows.find((row) => row.tokenHash === tokenHash) ?? null;
    },
    async deleteById(id) {
      deleted.push(id);
      rows.splice(rows.findIndex((row) => row.id === id), 1);
    },
    async deleteByTokenHash(tokenHash) {
      const index = rows.findIndex((row) => row.tokenHash === tokenHash);
      if (index >= 0) rows.splice(index, 1);
    },
    async deleteExpiredForOwner(ownerId, nowIso) {
      for (let index = rows.length - 1; index >= 0; index -= 1) {
        const row = rows[index];
        if (row.ownerId === ownerId && Date.parse(row.expiresAt) <= Date.parse(nowIso)) rows.splice(index, 1);
      }
    },
  };
}

/** In-memory store repository enforcing the unique owner and slug constraints. */
export function createFakeStores() {
  const rows = [];
  return {
    rows,
    async findByOwnerId(ownerId) {
      return rows.find((row) => row.ownerId === ownerId) ?? null;
    },
    async insert({ ownerId, slug, name, defaultLanguage, story, tagline = '', accentKey = 'terracotta' }) {
      if (rows.some((row) => row.ownerId === ownerId)) throw new UniqueViolation(STORES_OWNER_ID_KEY);
      if (rows.some((row) => row.slug === slug)) throw new UniqueViolation(STORES_SLUG_KEY);
      const row = {
        id: randomUUID(), ownerId, slug, name, defaultLanguage, story, contactEmail: null, tagline, accentKey,
        whatsappNumber: null, whatsappEnabled: false, instagramHandle: null, upiId: null, notifyEnquiryEmail: true, updatedAt: new Date().toISOString(),
      };
      rows.push(row);
      return row;
    },
    async updateSettings(storeId, settings) {
      const row = rows.find((candidate) => candidate.id === storeId);
      if (!row) return null;
      Object.assign(row, settings, { updatedAt: new Date().toISOString() });
      return row;
    },
  };
}

/**
 * In-memory translation repository with the real one's interface: every method needs a store id and only touches that
 * store's rows.
 */
export function createFakeStoreTranslations() {
  const rows = [];
  const calls = [];
  const own = (storeId) => rows.filter((row) => row.storeId === requireStoreId(storeId));
  return {
    rows,
    calls,
    async list(storeId) {
      return own(storeId).map(({ storeId: _s, ...rest }) => ({ ...rest }));
    },
    async find(storeId, language) {
      const row = own(storeId).find((candidate) => candidate.language === language);
      return row ? { language: row.language, tagline: row.tagline, story: row.story, source: row.source, approved: row.approved } : null;
    },
    async upsertMany(storeId, translations) {
      calls.push('upsertMany');
      requireStoreId(storeId);
      for (const translation of translations) {
        const index = rows.findIndex((row) => row.storeId === storeId && row.language === translation.language);
        const next = { storeId, ...translation };
        if (index >= 0) rows[index] = next;
        else rows.push(next);
      }
    },
    async unapproveAll(storeId) {
      calls.push('unapproveAll');
      for (const row of own(storeId)) row.approved = false;
    },
    async approveAll(storeId, defaultLanguage) {
      calls.push('approveAll');
      for (const row of own(storeId)) if (row.language !== defaultLanguage && row.story !== '') row.approved = true;
    },
  };
}

/**
 * Real services over fake repositories, with cheap scrypt parameters.
 * @param {{ inviteCode?: string | undefined, ownersOptions?: object, now?: () => number,
 *   passwordOptions?: object }} [options]
 */
export async function buildFakeServices({
  inviteCode = INVITE_CODE,
  ownersOptions,
  now,
  passwordOptions = {},
} = {}) {
  const ownersRepo = createFakeOwners(ownersOptions);
  const sessionsRepo = createFakeSessions();
  const storesRepo = createFakeStores();
  const passwords = await createPasswordService({ params: CHEAP_PARAMS, queue: createJobQueue(), ...passwordOptions });
  const sessions = createSessionService({ sessions: sessionsRepo, owners: ownersRepo, now });
  const auth = createAuthService({ owners: ownersRepo, passwords, sessions, inviteCode });
  const translationsRepo = createFakeStoreTranslations();
  const stores = createStoreService({ stores: storesRepo, translations: translationsRepo });
  const translations = createStoreTranslationService({ translations: translationsRepo });
  return { ownersRepo, sessionsRepo, storesRepo, translationsRepo, passwords, sessions, auth, stores, translations };
}
