import { z } from 'zod';
import { checkbox, MAX_TAGLINE_LENGTH } from './shopSettings.js';
import { cleanLine, codePointLength, normalizeParagraph } from './productRules.js';
import { LANGUAGES, MAX_STORY_LENGTH } from './storeRules.js';

/** Limits mirror db/migrations/007_store_translations.sql (a unit test compares them). */
export const MAX_TRANSLATED_TAGLINE_LENGTH = MAX_TAGLINE_LENGTH;
export const MAX_TRANSLATED_STORY_LENGTH = MAX_STORY_LENGTH;
export const TRANSLATION_SOURCES = Object.freeze(['owner', 'ai']);
const RAW_LENGTH_FACTOR = 4;

/** Single-line tagline, at most 120 code points. May be empty. */
export const translatedTaglineSchema = z
  .string()
  .max(MAX_TRANSLATED_TAGLINE_LENGTH * RAW_LENGTH_FACTOR)
  .transform(cleanLine)
  .refine((value) => codePointLength(value) <= MAX_TRANSLATED_TAGLINE_LENGTH);

/** Multi-line story, at most 2000 code points. May be empty. NFKC is not applied (it can alter Indic text). */
export const translatedStorySchema = z
  .string()
  .max(MAX_TRANSLATED_STORY_LENGTH * RAW_LENGTH_FACTOR)
  .transform(normalizeParagraph)
  .refine((value) => codePointLength(value) <= MAX_TRANSLATED_STORY_LENGTH);

/**
 * Owner form for ONE language. Strict: unknown keys (including store_id) are rejected. The store always comes from the
 * session, never from this form.
 */
export const translationFormSchema = z
  .object({
    language: z.enum(LANGUAGES),
    tagline: translatedTaglineSchema,
    story: translatedStorySchema,
    approved: checkbox,
  })
  .strict();

/**
 * The languages that have a stored translation row: every language except the shop default (whose text lives in stores).
 * @param {string} defaultLanguage
 * @returns {string[]}
 */
export const targetLanguages = (defaultLanguage) => LANGUAGES.filter((language) => language !== defaultLanguage);

/**
 * Decides where saved text came from. Text the owner leaves untouched keeps its source (an AI draft that is only
 * approved stays 'ai'); any change, or a new row, makes it the owner's.
 * @param {{ tagline: string, story: string, source: string } | null} existing
 * @param {{ tagline: string, story: string }} next
 * @returns {'owner' | 'ai'}
 */
export function sourceAfterSave(existing, next) {
  const unchanged = existing && existing.tagline === next.tagline && existing.story === next.story;
  return unchanged && existing.source === 'ai' ? 'ai' : 'owner';
}
