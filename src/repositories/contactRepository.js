import { z } from 'zod';
import { AppError } from '../lib/errors.js';
import { throwIfError } from './pgErrors.js';

const HTTP_INTERNAL_ERROR = 500;
const insertedRow = z.object({ id: z.uuid(), created_at: z.string() });

/**
 * Contact-form messages. SYSTEM-LEVEL by design (allowlisted by name in the tenancy scan): a message is sent to the site
 * owner from the public main site, so it belongs to no store.
 * @param {{ client: any }} deps
 */
export function createContactRepository({ client }) {
  return {
    /** @param {{ name: string, email: string, message: string }} contact @returns {Promise<{ id: string, createdAt: string }>} */
    async insert({ name, email, message }) {
      const { data, error } = await client.from('contact_messages').insert({ name, email, message }).select('id, created_at').single();
      throwIfError(error);
      const parsed = insertedRow.safeParse(data);
      if (!parsed.success) throw new AppError('DATABASE_ERROR', HTTP_INTERNAL_ERROR, 'Something went wrong', { operation: 'contact.insert' });
      return { id: parsed.data.id, createdAt: parsed.data.created_at };
    },

    /** Messages from this address (case-insensitive) since the given time. @param {string} email @param {string} sinceIso @returns {Promise<number>} */
    async countSince(email, sinceIso) {
      const { count, error } = await client
        .from('contact_messages')
        .select('id', { count: 'exact', head: true })
        .ilike('email', email.replace(/[\\%_]/g, '\\$&'))
        .gte('created_at', sinceIso);
      throwIfError(error);
      return count ?? 0;
    },

    /** Retention: ONE delete of messages created before the cutoff. @param {string} cutoffIso @returns {Promise<number>} */
    async deleteBefore(cutoffIso) {
      const { count, error } = await client.from('contact_messages').delete({ count: 'exact' }).lt('created_at', cutoffIso);
      throwIfError(error);
      return count ?? 0;
    },
  };
}
