import { randomUUID } from 'node:crypto';
import { isOwnedImagePath } from '../../src/domain/imageUpload.js';
import { AppError } from '../../src/lib/errors.js';
import { createAiBudgetService } from '../../src/services/aiBudgetService.js';

/** A minimal complete JPEG: SOI marker, filler, EOI marker. Passes magic-byte and completeness checks. */
export const jpegBytes = (size = 64) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(size, 7), Buffer.from([0xff, 0xd9])]);

export const GOOD_TRANSLATIONS = Object.freeze({
  en: { title: 'Blue clay pot', description: 'A hand shaped clay pot with a blue glaze.', alt_text: 'A round blue clay pot on a table.' },
  gu: { title: 'વાદળી માટીનું વાસણ', description: 'હાથે બનાવેલું વાદળી ચમકવાળું માટીનું વાસણ.', alt_text: 'ટેબલ પર ગોળ વાદળી માટીનું વાસણ.' },
  hi: { title: 'नीला मिट्टी का बर्तन', description: 'हाथ से बना नीले रंग की चमक वाला मिट्टी का बर्तन।', alt_text: 'मेज़ पर गोल नीला मिट्टी का बर्तन।' },
});

const cleanRow = ({ storeId: _storeId, aiGenerationId: _token, ...row }) => structuredClone(row);

/** Mirrors STALE_GENERATION_MS and the 180 second window in migration 005. */
const STALE_MS = 180_000;

/**
 * In-memory product repository with the real repository's interface and semantics: every method is scoped by
 * storeId, claimGeneration is one atomic step that issues a fresh fencing token, and the two RPC fakes apply the same gates
 * as migrations 004 and 005. The token is never exposed except through claimGeneration.
 */
export function createFakeProducts({ defaultLanguageOf = () => 'en', now = Date.now } = {}) {
  const rows = [];
  const draftRows = [];
  const failures = {};
  const find = (storeId, productId) => rows.find((row) => row.id === productId && row.storeId === storeId);
  const maybeFail = (name) => {
    if (failures[name]) throw new AppError('DATABASE_ERROR', 500, 'Something went wrong');
  };
  return {
    rows,
    draftRows,
    failures,
    async insert(storeId, { id, imagePath, imageContentType }) {
      maybeFail('insert');
      const row = { id, storeId, status: 'draft', pricePaise: null, stock: null, story: '', imagePath, imageContentType,
        aiStatus: 'idle', aiStartedAt: null, createdAt: new Date(now()).toISOString(), updatedAt: new Date(now()).toISOString(), translations: [] };
      rows.push(row);
      return cleanRow(row);
    },
    async listByStore(storeId) {
      return rows.filter((row) => row.storeId === storeId).map(cleanRow).reverse();
    },
    async findById(storeId, productId) {
      const row = find(storeId, productId);
      return row ? cleanRow(row) : null;
    },
    async claimGeneration(storeId, productId, { story, nowIso, staleBeforeIso }) {
      const row = find(storeId, productId);
      const free = row && (row.aiStatus !== 'generating' || !row.aiStartedAt || row.aiStartedAt < staleBeforeIso);
      if (!row || row.status !== 'draft' || !free) return null;
      Object.assign(row, { aiStatus: 'generating', aiStartedAt: nowIso, story, aiGenerationId: randomUUID() });
      return { ...cleanRow(row), generationId: row.aiGenerationId };
    },
    async finishGeneration(storeId, productId, generationId, state) {
      maybeFail('finishGeneration');
      const row = find(storeId, productId);
      if (row?.aiStatus === 'generating' && generationId && row.aiGenerationId === generationId) {
        Object.assign(row, { aiStatus: state, aiStartedAt: null, aiGenerationId: null });
      }
    },
    async saveAiListing(storeId, productId, { generationId, translations, model, tokensIn, tokensOut, costMicroUsd }) {
      maybeFail('saveAiListing');
      const row = find(storeId, productId);
      if (!row) return { ok: false, reason: 'not_found' };
      if (row.status !== 'draft') return { ok: false, reason: 'not_draft' };
      if (!generationId || row.aiGenerationId !== generationId) return { ok: false, reason: 'stale_generation' };
      row.translations = Object.entries(translations).map(([language, t]) => ({
        language, title: t.title, description: t.description, altText: t.alt_text, source: 'ai', approved: false,
      }));
      Object.assign(row, { aiStatus: 'idle', aiStartedAt: null, aiGenerationId: null });
      const draftId = randomUUID();
      draftRows.push({ id: draftId, storeId, productId, model, tokensIn, tokensOut, costMicroUsd });
      return { ok: true, draftId };
    },
    async saveReview(storeId, productId, { story, stock, pricePaise, translations, approvedLanguages, publish }) {
      maybeFail('saveReview');
      const row = find(storeId, productId);
      if (!row) return { ok: false, reason: 'not_found' };
      const live = row.aiStatus === 'generating' && Date.parse(row.aiStartedAt ?? '') > now() - STALE_MS;
      if (live) return { ok: false, reason: 'generating' };
      const willBePublished = publish || row.status === 'published';
      if (willBePublished && pricePaise === null) return { ok: false, reason: 'price_required' };
      if (willBePublished && !approvedLanguages.includes(defaultLanguageOf(storeId))) return { ok: false, reason: 'default_language_not_approved' };
      for (const [language, t] of Object.entries(translations)) {
        const old = row.translations.find((entry) => entry.language === language);
        const changed = !old || old.title !== t.title || old.description !== t.description || old.altText !== t.alt_text;
        const next = { language, title: t.title, description: t.description, altText: t.alt_text, source: changed ? 'owner' : old.source, approved: false };
        row.translations = [...row.translations.filter((entry) => entry.language !== language), next];
      }
      for (const entry of row.translations) entry.approved = approvedLanguages.includes(entry.language);
      Object.assign(row, { story, stock, pricePaise });
      if (row.aiStatus === 'generating') Object.assign(row, { aiStatus: 'idle', aiStartedAt: null, aiGenerationId: null });
      if (willBePublished) row.status = 'published';
      return { ok: true, status: row.status };
    },
    async deleteById(storeId, productId) {
      const row = find(storeId, productId);
      if (!row) return null;
      rows.splice(rows.indexOf(row), 1);
      return row.imagePath;
    },
  };
}

/** In-memory private image storage. Enforces the same path-prefix rule as the real repository. */
export function createFakeImages() {
  const objects = new Map();
  const failures = {};
  const guard = (name, storeId, productId, path) => {
    if (!isOwnedImagePath(path, storeId, productId)) throw new TypeError('Path is outside the product prefix');
    if (failures[name]) throw new AppError('STORAGE_ERROR', 502, 'We could not reach photo storage. Please try again.');
  };
  return {
    objects,
    failures,
    async upload(storeId, productId, path, bytes, contentType) {
      guard('upload', storeId, productId, path);
      objects.set(path, { bytes, contentType });
    },
    async download(storeId, productId, path) {
      guard('download', storeId, productId, path);
      if (!objects.has(path)) throw new AppError('STORAGE_ERROR', 502, 'missing');
      return objects.get(path).bytes;
    },
    async remove(storeId, productId, path) {
      guard('remove', storeId, productId, path);
      objects.delete(path);
    },
    async createSignedUrl(storeId, productId, path) {
      guard('sign', storeId, productId, path);
      return `https://project.supabase.test/storage/v1/object/sign/product-images/${path}?token=signed`;
    },
  };
}

/** In-memory budget repository driving the REAL aiBudgetService. Records every call in order. */
export function createFakeBudgetRepo({ ownerRemaining = Infinity, failSettle = false, failRelease = false } = {}) {
  const calls = [];
  let counter = 0;
  return {
    calls,
    async reserveBudget({ amountMicroUsd }) {
      calls.push({ op: 'reserve', amountMicroUsd });
      if (amountMicroUsd > ownerRemaining) return { ok: false, reservationId: null, reason: 'owner_limit' };
      counter += 1;
      return { ok: true, reservationId: `00000000-0000-4000-8000-${String(counter).padStart(12, '0')}`, reason: null };
    },
    async settleBudget(reservationId, actualMicroUsd) {
      calls.push({ op: 'settle', reservationId, actualMicroUsd });
      if (failSettle) throw new Error('db down');
      return { ok: true, changed: true };
    },
    async releaseBudget(reservationId) {
      calls.push({ op: 'release', reservationId });
      if (failRelease) throw new Error('db down');
      return { ok: true, changed: true };
    },
  };
}

export const BIG_LIMITS = { ownerMicroUsd: 1_000_000, demoMicroUsd: 500_000, globalMicroUsd: 5_000_000 };
export const buildBudgetService = (repoOptions, limits = BIG_LIMITS) => {
  const repo = createFakeBudgetRepo(repoOptions);
  return { repo, service: createAiBudgetService({ budgets: repo, limits }) };
};

/** A scripted listing generator. `script` entries are results, or Errors to throw, consumed in order. */
export function createFakeGenerator(script) {
  const calls = [];
  const queue = [...script];
  return {
    calls,
    model: 'claude-haiku-5-5',
    promptVersion: 'listing-v1',
    async generate(input) {
      calls.push(input);
      const next = queue.shift();
      if (next instanceof Error) throw next;
      return next;
    },
  };
}

export const okResult = (usage = { inputTokens: 4000, outputTokens: 900 }) => ({ ok: true, translations: structuredClone(GOOD_TRANSLATIONS), usage });
export const invalidResult = (usage = { inputTokens: 4000, outputTokens: 300 }) => ({ ok: false, reason: 'invalid_output', usage });

export function createLogCollector() {
  const entries = [];
  const log = (level) => (message, fields) => entries.push({ level, message, ...fields });
  return { entries, info: log('info'), warn: log('warn'), error: log('error') };
}
