import { z } from 'zod';
import { RESERVED_SLUGS, SLUG_PATTERN } from './dbConstraints.js';

export const MAX_STORE_NAME_LENGTH = 80;
export const MAX_STORY_LENGTH = 2000;
export const MAX_SLUG_INPUT_LENGTH = 80;
/** Products shown on a public shop page. The repository reads one more, to know whether to show the "more products" note. */
export const MAX_PUBLIC_PRODUCTS = 48;
export const LANGUAGES = Object.freeze(['en', 'gu', 'hi']);

/** Lowercased slug matching the database CHECK and not reserved. */
export const slugSchema = z
  .string()
  .max(MAX_SLUG_INPUT_LENGTH)
  .transform((value) => value.trim().toLowerCase())
  .pipe(
    z
      .string()
      .regex(SLUG_PATTERN)
      .refine((slug) => !RESERVED_SLUGS.includes(slug)),
  );

export const storeSchema = z
  .object({
    name: z.string().trim().min(1).max(MAX_STORE_NAME_LENGTH),
    slug: slugSchema,
    defaultLanguage: z.enum(LANGUAGES),
    story: z.string().trim().min(1).max(MAX_STORY_LENGTH),
  })
  .strict();
