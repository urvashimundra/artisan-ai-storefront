import { z } from 'zod';
import { MAX_DESCRIPTION_LENGTH, MAX_TITLE_LENGTH } from '../../domain/productRules.js';
import { listingTextField } from './listing.js';

/** Name of the forced tool the model must call. */
export const PRODUCT_TRANSLATION_TOOL_NAME = 'propose_product_translations';

const entry = z.object({ title: listingTextField(MAX_TITLE_LENGTH), description: listingTextField(MAX_DESCRIPTION_LENGTH) }).strict();

/**
 * Strict output schema for the given target languages: exactly those languages, each with exactly a title and a description (the same
 * text validators as listing generation). Any extra key or language (a price, an alt text, a URL) fails validation instead of being passed on.
 * @param {string[]} targets
 */
export function buildProductTranslationSchema(targets) {
  return z.object({ translations: z.object(Object.fromEntries(targets.map((language) => [language, entry]))).strict() }).strict();
}

/**
 * @param {unknown} input @param {string[]} targets
 * @returns {{ ok: true, translations: Record<string, { title: string, description: string }> } | { ok: false }}
 */
export function parseProductTranslationOutput(input, targets) {
  const result = buildProductTranslationSchema(targets).safeParse(input);
  return result.success ? { ok: true, translations: result.data.translations } : { ok: false };
}

/** The forced tool definition. JSON Schema is derived from the same Zod schema so the two cannot drift. */
export function buildProductTranslationTool(targets) {
  const { $schema: _omitted, ...schema } = z.toJSONSchema(buildProductTranslationSchema(targets), { io: 'input' });
  return {
    name: PRODUCT_TRANSLATION_TOOL_NAME,
    description: 'Record the translated product title and description for each requested language.',
    input_schema: schema,
  };
}
