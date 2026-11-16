import { z } from 'zod';
import {
  MAX_ALT_TEXT_LENGTH,
  MAX_DESCRIPTION_LENGTH,
  MAX_TITLE_LENGTH,
  cleanLine,
  codePointLength,
} from '../../domain/productRules.js';

/** Name of the forced tool the model must call. */
export const LISTING_TOOL_NAME = 'propose_listing';

const MIN_FIELD_LENGTH = 1;
const RAW_LENGTH_FACTOR = 4;

const field = (limit) =>
  z
    .string()
    .max(limit * RAW_LENGTH_FACTOR)
    .transform(cleanLine)
    .refine((value) => value.length >= MIN_FIELD_LENGTH && codePointLength(value) <= limit);

const translation = z
  .object({
    title: field(MAX_TITLE_LENGTH),
    description: field(MAX_DESCRIPTION_LENGTH),
    alt_text: field(MAX_ALT_TEXT_LENGTH),
  })
  .strict();

/**
 * Validated model output. Strict at every level: any extra key (price, stock, url, contact, status, a fourth
 * language) fails validation instead of being passed on. Text is cleaned (controls removed, whitespace collapsed).
 */
export const listingOutputSchema = z
  .object({ translations: z.object({ en: translation, gu: translation, hi: translation }).strict() })
  .strict();

const MAX_REPORTED_ISSUES = 6;
const ROOT_PATH_LABEL = '(root)';

/**
 * Names where validation failed, as "path:code" (for example "translations.en.title:too_big"). Never includes values.
 * @param {import('zod').ZodError} error
 * @returns {string[]}
 */
function describeIssues(error) {
  return error.issues
    .slice(0, MAX_REPORTED_ISSUES)
    .map(({ path, code }) => `${path.length ? path.map(String).join('.') : ROOT_PATH_LABEL}:${code}`);
}

/**
 * Validates a tool input object from the model.
 * @param {unknown} input
 * @returns {{ ok: true, translations: Record<'en'|'gu'|'hi', {title: string, description: string, alt_text: string}> }
 *   | { ok: false, issues: string[] }}
 */
export function parseListingOutput(input) {
  const result = listingOutputSchema.safeParse(input);
  return result.success
    ? { ok: true, translations: result.data.translations }
    : { ok: false, issues: describeIssues(result.error) };
}

/** JSON Schema for the tool input, derived from the same Zod schema so the two cannot drift. */
export function buildListingInputSchema() {
  const { $schema: _omitted, ...schema } = z.toJSONSchema(listingOutputSchema, { io: 'input' });
  return schema;
}

/** The forced tool definition sent to the API. It proposes text only; nothing in it can express a price. */
export function buildListingTool() {
  return {
    name: LISTING_TOOL_NAME,
    description:
      'Record the proposed product listing: a title, description and image alt text in each of English, Gujarati and Hindi.',
    input_schema: buildListingInputSchema(),
  };
}
