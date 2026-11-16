import { z } from 'zod';
import { ACCENT_KEYS } from './palette.js';
import { cleanLine, codePointLength } from './productRules.js';
import { normalizeWhatsappNumber } from './whatsapp.js';

/** Limits and patterns. Mirrored in db/migrations/006_storefront.sql (a unit test compares them). */
export const MAX_TAGLINE_LENGTH = 120;
export const INSTAGRAM_PATTERN = /^[A-Za-z0-9._]{1,30}$/;
export const MAX_UPI_LENGTH = 100;
export const UPI_PATTERN = /^[A-Za-z0-9._-]{2,64}@[A-Za-z][A-Za-z0-9.]{1,63}$/;
const MAX_RAW_FIELD_LENGTH = 200;
const LEADING_AT = /^@+/;

const rawText = z.string().max(MAX_RAW_FIELD_LENGTH);
const emptyToNull = (value) => (value === '' ? null : value);

const tagline = rawText
  .transform(cleanLine)
  .refine((value) => codePointLength(value) <= MAX_TAGLINE_LENGTH, { message: 'tagline_too_long' });

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
