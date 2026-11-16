import { z } from 'zod';
import { ACCENT_KEYS } from './palette.js';
import { codePointLength, normalizeParagraph } from './productRules.js';
import {
  INSTAGRAM_PATTERN, MAX_TAGLINE_LENGTH, MAX_UPI_LENGTH, UPI_PATTERN, checkbox, contactFields, requireNumberForWhatsapp, tagline,
} from './shopFields.js';
import { MAX_STORY_LENGTH } from './storeRules.js';

export { INSTAGRAM_PATTERN, MAX_TAGLINE_LENGTH, MAX_UPI_LENGTH, UPI_PATTERN, checkbox };

const RAW_STORY_FACTOR = 4;

/** Default-language shop story: 1 to 2000 code points, same limits as stores.story. Line breaks are kept. */
const story = z
  .string()
  .max(MAX_STORY_LENGTH * RAW_STORY_FACTOR)
  .transform(normalizeParagraph)
  .refine((value) => value.length > 0 && codePointLength(value) <= MAX_STORY_LENGTH, { message: 'story_invalid' });

/**
 * Owner shop-settings form. Strict: unknown keys (including store_id) are rejected. Output is camelCase and ready to
 * store: whatsappNumber is digits or null, instagramHandle has no @, empty optional fields are null.
 */
export const shopSettingsSchema = requireNumberForWhatsapp(
  z.object({ tagline, story, accentKey: z.enum(ACCENT_KEYS), ...contactFields }).strict(),
);

/**
 * Public Instagram profile link for a stored handle.
 * @param {string} handle Already validated against INSTAGRAM_PATTERN.
 * @returns {string}
 */
export const instagramUrl = (handle) => `https://www.instagram.com/${handle}/`;
