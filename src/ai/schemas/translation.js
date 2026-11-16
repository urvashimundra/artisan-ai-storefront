import { z } from 'zod';
import { translatedStorySchema, translatedTaglineSchema } from '../../domain/storeTranslations.js';

/** Name of the forced tool the model must call. */
export const TRANSLATION_TOOL_NAME = 'propose_translations';

const entry = z
  .object({ tagline: translatedTaglineSchema, story: translatedStorySchema.refine((value) => value.length > 0) })
  .strict();

/**
 * Strict output schema for the given target languages: exactly those languages, each with exactly a tagline and a
 * story. Any extra key or language (a price, a URL, a shop name field) fails validation instead of being passed on.
 * @param {string[]} targets
 */
export function buildTranslationOutputSchema(targets) {
  const languages = z.object(Object.fromEntries(targets.map((language) => [language, entry]))).strict();
  return z.object({ translations: languages }).strict();
}

/**
 * Validates a tool input object from the model.
 * @param {unknown} input
 * @param {string[]} targets
 * @returns {{ ok: true, translations: Record<string, { tagline: string, story: string }> } | { ok: false }}
 */
export function parseTranslationOutput(input, targets) {
  const result = buildTranslationOutputSchema(targets).safeParse(input);
  return result.success ? { ok: true, translations: result.data.translations } : { ok: false };
}

/** The forced tool definition. JSON Schema is derived from the same Zod schema so the two cannot drift. */
export function buildTranslationTool(targets) {
  const { $schema: _omitted, ...schema } = z.toJSONSchema(buildTranslationOutputSchema(targets), { io: 'input' });
  return {
    name: TRANSLATION_TOOL_NAME,
    description: 'Record the translated shop tagline and story for each requested language.',
    input_schema: schema,
  };
}
