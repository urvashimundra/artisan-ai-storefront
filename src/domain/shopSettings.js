import { z } from 'zod';
import { ACCENT_KEYS } from './palette.js';
import { cleanLine, codePointLength, normalizeParagraph } from './productRules.js';
import { MAX_STORY_LENGTH } from './storeRules.js';
import { normalizeWhatsappNumber } from './whatsapp.js';

/** Limits and patterns. Mirrored in db/migrations/006_storefront.sql (a unit test compares them). */
export const MAX_TAGLINE_LENGTH = 120;
export const INSTAGRAM_PATTERN = /^[A-Za-z0-9._]{1,30}$/;
export const MAX_UPI_LENGTH = 100;
export const UPI_PATTERN = /^[A-Za-z0-9._-]{2,64}@[A-Za-z][A-Za-z0-9.]{1,63}$/;
const MAX_RAW_FIELD_LENGTH = 200;
const LEADING_AT = /^@+/;
const RAW_STORY_FACTOR = 4;

const rawText = z.string().max(MAX_RAW_FIELD_LENGTH);
const emptyToNull = (value) => (value === '' ? null : value);

const tagline = rawText
  .transform(cleanLine)
  .refine((value) => codePointLength(value) <= MAX_TAGLINE_LENGTH, { message: 'tagline_too_long' });

/** Default-language shop story: 1 to 2000 code points, same limits as stores.story. Line breaks are kept. */
const story = z
  .string()
  .max(MAX_STORY_LENGTH * RAW_STORY_FACTOR)
  .transform(normalizeParagraph)
  .refine((value) => value.length > 0 && codePointLength(value) <= MAX_STORY_LENGTH, { message: 'story_invalid' });

const whatsappNumber = rawText
  .transform((value) => value.trim())
  .transform((value, ctx) => {
    if (value === '') return null;
    const normalized = normalizeWhatsappNumber(value);
    if (!normalized) ctx.addIssue({ code: 'custom', message: 'invalid_whatsapp' });
    return normalized;
  });

const instagramHandle = rawText
  .transform((value) => value.trim().replace(LEADING_AT, ''))
  .transform(emptyToNull)
  .pipe(z.union([z.null(), z.string().regex(INSTAGRAM_PATTERN, { message: 'invalid_instagram' })]));

const upiId = rawText
  .transform((value) => value.trim())
  .transform(emptyToNull)
  .pipe(z.union([z.null(), z.string().max(MAX_UPI_LENGTH).regex(UPI_PATTERN, { message: 'invalid_upi' })]));

/** HTML checkbox: present as "on" when ticked, absent otherwise. */
export const checkbox = z
  .enum(['on'])
  .optional()
  .transform((value) => value === 'on');

/**
 * Owner shop-settings form. Strict: unknown keys (including store_id) are rejected. Output is camelCase and ready to
 * store: whatsappNumber is digits or null, instagramHandle has no @, empty optional fields are null.
 */
export const shopSettingsSchema = z
  .object({
    tagline,
    story,
    accentKey: z.enum(ACCENT_KEYS),
    whatsappNumber,
    whatsappEnabled: checkbox,
    instagramHandle,
    upiId,
  })
  .strict()
  .refine((value) => !value.whatsappEnabled || value.whatsappNumber !== null, {
    message: 'whatsapp_enabled_requires_number',
    path: ['whatsappNumber'],
  });

/**
 * Public Instagram profile link for a stored handle.
 * @param {string} handle Already validated against INSTAGRAM_PATTERN.
 * @returns {string}
 */
export const instagramUrl = (handle) => `https://www.instagram.com/${handle}/`;
