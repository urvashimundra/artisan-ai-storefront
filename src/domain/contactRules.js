import { z } from 'zod';
import { MAX_CONTACT_MESSAGE_LENGTH, MAX_CONTACT_NAME_LENGTH } from './emailRules.js';
import { MAX_EMAIL_LENGTH } from './orderRules.js';
import { cleanLine, codePointLength, normalizeParagraph } from './productRules.js';

const MS_PER_HOUR = 3_600_000;
const RAW_FIELD_FACTOR = 4;
const EMAIL_PATTERN = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const LINE_BREAK = /[\r\n]/;
const MAX_TRAP_LENGTH = 200;

/** Contact form limits. Per IP (in memory, per process) and per address (counted from contact_messages, so they survive restarts). */
export const CONTACT_IP_LIMITS = Object.freeze({ windowMs: MS_PER_HOUR, limit: 5 });
export const CONTACT_ADDRESS_LIMITS = Object.freeze({ windowMs: MS_PER_HOUR, limit: 3 });
/** The hidden field real visitors never see or fill. */
export const TRAP_FIELD = 'website';
export { MAX_CONTACT_MESSAGE_LENGTH, MAX_CONTACT_NAME_LENGTH };

const withinCodePoints = (limit) => (value) => codePointLength(value) <= limit;
const noLineBreak = (value) => !LINE_BREAK.test(value);

const nameField = z
  .string()
  .max(MAX_CONTACT_NAME_LENGTH * RAW_FIELD_FACTOR)
  .refine(noLineBreak, { message: 'invalid_name' })
  .transform(cleanLine)
  .refine((value) => value.length > 0 && withinCodePoints(MAX_CONTACT_NAME_LENGTH)(value), { message: 'invalid_name' });

const emailField = z
  .string()
  .max(MAX_EMAIL_LENGTH * RAW_FIELD_FACTOR)
  .refine(noLineBreak, { message: 'invalid_email' })
  .transform((value) => value.trim())
  .refine((value) => value.length <= MAX_EMAIL_LENGTH && EMAIL_PATTERN.test(value), { message: 'invalid_email' });

const messageField = z
  .string()
  .max(MAX_CONTACT_MESSAGE_LENGTH * RAW_FIELD_FACTOR)
  .transform(normalizeParagraph)
  .refine((value) => value.length > 0 && withinCodePoints(MAX_CONTACT_MESSAGE_LENGTH)(value), { message: 'invalid_message' });

/**
 * The contact form. Strict: unknown keys are rejected. `website` is the hidden trap field: it is accepted here only so that a
 * bot filling it is recognised (the service then saves and sends nothing). CR or LF in the name or address is refused.
 */
export const contactSchema = z
  .object({
    name: nameField,
    email: emailField,
    message: messageField,
    [TRAP_FIELD]: z.string().max(MAX_TRAP_LENGTH).optional(),
  })
  .strict();
