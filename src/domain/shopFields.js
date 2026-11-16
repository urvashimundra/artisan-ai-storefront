import { z } from 'zod';
import { ACCENT_KEYS, DEFAULT_ACCENT_KEY } from './palette.js';
import { cleanLine, codePointLength } from './productRules.js';
import { storeFields } from './storeRules.js';
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

/** Shop tagline: one line, at most 120 code points. An empty tagline is allowed. */
export const tagline = rawText
  .transform(cleanLine)
  .refine((value) => codePointLength(value) <= MAX_TAGLINE_LENGTH, { message: 'tagline_too_long' });

/** Normalised phone number (digits) or null when empty. */
export const whatsappNumber = rawText
  .transform((value) => value.trim())
  .transform((value, ctx) => {
    if (value === '') return null;
    const normalized = normalizeWhatsappNumber(value);
    if (!normalized) ctx.addIssue({ code: 'custom', message: 'invalid_whatsapp' });
    return normalized;
  });

/** Instagram handle without a leading @, or null when empty. */
export const instagramHandle = rawText
  .transform((value) => value.trim().replace(LEADING_AT, ''))
  .transform(emptyToNull)
  .pipe(z.union([z.null(), z.string().regex(INSTAGRAM_PATTERN, { message: 'invalid_instagram' })]));

/** UPI ID or null when empty. */
export const upiId = rawText
  .transform((value) => value.trim())
  .transform(emptyToNull)
  .pipe(z.union([z.null(), z.string().max(MAX_UPI_LENGTH).regex(UPI_PATTERN, { message: 'invalid_upi' })]));

/** HTML checkbox: present as "on" when ticked, absent otherwise. */
export const checkbox = z
  .enum(['on'])
  .optional()
  .transform((value) => value === 'on');

/** The WhatsApp button needs a number to open. */
export const requireNumberForWhatsapp = (schema) =>
  schema.refine((value) => !value.whatsappEnabled || value.whatsappNumber !== null, {
    message: 'whatsapp_enabled_requires_number',
    path: ['whatsappNumber'],
  });

/** Contact and payment fields shared by onboarding step 2 and Shop settings. Strict. */
export const contactFields = { whatsappNumber, whatsappEnabled: checkbox, instagramHandle, upiId };

/** Onboarding step 2 form. Strict: unknown keys (including store_id) are rejected. */
export const contactSchema = requireNumberForWhatsapp(z.object(contactFields).strict());

/**
 * Onboarding step 1 form (store creation): the four required fields plus an optional tagline (default empty) and an
 * optional shop colour (default terracotta). Strict: unknown keys (including store_id) are rejected.
 */
export const newStoreSchema = z
  .object({
    ...storeFields,
    tagline: tagline.optional().transform((value) => value ?? ''),
    accentKey: z
      .enum(ACCENT_KEYS)
      .optional()
      .transform((value) => value ?? DEFAULT_ACCENT_KEY),
  })
  .strict();
