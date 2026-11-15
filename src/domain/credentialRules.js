import { z } from 'zod';

export const MIN_PASSWORD_LENGTH = 12;
export const MAX_PASSWORD_LENGTH = 128;
export const MAX_EMAIL_LENGTH = 254;
/** Bounds work done by NFKC normalization, which can expand a character into many. */
export const MAX_RAW_PASSWORD_LENGTH = 1024;
export const MAX_INVITE_CODE_INPUT_LENGTH = 256;

/**
 * Normalizes an email: trim and lowercase.
 * @param {string} email
 * @returns {string}
 */
export const normalizeEmail = (email) => email.trim().toLowerCase();

/**
 * Normalizes a password with Unicode NFKC. Length limits are applied to the normalized form.
 * @param {string} password
 * @returns {string}
 */
export const normalizePassword = (password) => password.normalize('NFKC');

/** Validated, normalized email. */
export const emailSchema = z
  .string()
  .max(MAX_EMAIL_LENGTH * 2)
  .transform(normalizeEmail)
  .pipe(z.email().max(MAX_EMAIL_LENGTH));

/** New passwords: 12 to 128 characters, measured AFTER NFKC normalization. */
export const newPasswordSchema = z
  .string()
  .max(MAX_RAW_PASSWORD_LENGTH)
  .transform(normalizePassword)
  .pipe(z.string().min(MIN_PASSWORD_LENGTH).max(MAX_PASSWORD_LENGTH));

/** Login passwords: only bounded (1 to 128 after NFKC). Weak-length failures must look like any other failure. */
export const loginPasswordSchema = z
  .string()
  .max(MAX_RAW_PASSWORD_LENGTH)
  .transform(normalizePassword)
  .pipe(z.string().min(1).max(MAX_PASSWORD_LENGTH));

export const signupSchema = z
  .object({
    email: emailSchema,
    password: newPasswordSchema,
    inviteCode: z.string().max(MAX_INVITE_CODE_INPUT_LENGTH),
  })
  .strict();

export const loginSchema = z.object({ email: emailSchema, password: loginPasswordSchema }).strict();
