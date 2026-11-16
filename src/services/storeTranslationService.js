import { translationFormSchema, sourceAfterSave, targetLanguages } from '../domain/storeTranslations.js';
import { AppError } from '../lib/errors.js';

const HTTP_BAD_REQUEST = 400;

const EMPTY = Object.freeze({ tagline: '', story: '', source: 'owner', approved: false });

/**
 * Owner-side rules for translated shop text. The store comes from the session (the caller passes `store`), never from
 * input. The shop default language lives in `stores`; only the other languages have rows here.
 * @param {{ translations: ReturnType<typeof import('../repositories/storeTranslationRepository.js').createStoreTranslationRepository> }} deps
 */
export function createStoreTranslationService({ translations }) {
  return {
    /**
     * One entry per non-default language, with empty defaults for languages that have no row yet.
     * @param {{ id: string, defaultLanguage: string }} store
     * @returns {Promise<{ language: string, tagline: string, story: string, source: string, approved: boolean }[]>}
     */
    async listForOwner(store) {
      const rows = await translations.list(store.id);
      return targetLanguages(store.defaultLanguage).map((language) => ({
        ...EMPTY,
        ...rows.find((row) => row.language === language),
        language,
      }));
    },

    /**
     * Saves one language as a single upsert. Text the owner changed becomes source 'owner'.
     * @param {{ id: string, defaultLanguage: string }} store
     * @param {unknown} rawInput Validated here with a strict schema.
     * @throws {import('zod').ZodError} for invalid input.
     * @throws {AppError} INVALID_LANGUAGE for the shop's default language.
     */
    async save(store, rawInput) {
      const input = translationFormSchema.parse(rawInput);
      if (input.language === store.defaultLanguage) {
        throw new AppError('INVALID_LANGUAGE', HTTP_BAD_REQUEST, 'The shop language is edited in the shop itself, not here.');
      }
      const existing = await translations.find(store.id, input.language);
      const source = sourceAfterSave(existing, input);
      await translations.upsertMany(store.id, [{ ...input, source }]);
    },
  };
}
