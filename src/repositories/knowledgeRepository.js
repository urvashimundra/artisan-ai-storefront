import { z } from 'zod';
import { AppError } from '../lib/errors.js';
import { tiersSchema } from '../domain/knowledgeRules.js';
import { throwIfError } from './pgErrors.js';
import { requireStoreId } from './requireStoreId.js';

const HTTP_INTERNAL_ERROR = 500;
const COLUMNS = 'content, bulk_rules, updated_at';
const knowledgeRow = z.object({ content: z.string(), bulk_rules: tiersSchema, updated_at: z.string() });

function parse(value, operation) {
  const parsed = knowledgeRow.safeParse(value);
  if (!parsed.success) throw new AppError('DATABASE_ERROR', HTTP_INTERNAL_ERROR, 'Something went wrong', { operation, reason: 'unexpected_result_shape' });
  return { content: parsed.data.content, bulkRules: parsed.data.bulk_rules, updatedAt: parsed.data.updated_at };
}

/**
 * The shop knowledge document and its CONFIRMED bulk tiers, one row per store. Every method takes storeId first and scopes by it.
 * @param {{ client: any }} deps
 */
export function createKnowledgeRepository({ client }) {
  return {
    /** @returns {Promise<{ content: string, bulkRules: object[], updatedAt: string } | null>} */
    async get(storeId) {
      const { data, error } = await client.from('store_knowledge').select(COLUMNS).eq('store_id', requireStoreId(storeId)).maybeSingle();
      throwIfError(error);
      return data ? parse(data, 'knowledge.get') : null;
    },

    /** One UPSERT: replaces the document and CLEARS the confirmed tiers in the same statement (fail-closed). */
    async replaceContent(storeId, content, nowIso) {
      const row = { store_id: requireStoreId(storeId), content, bulk_rules: [], updated_at: nowIso };
      const { error } = await client.from('store_knowledge').upsert(row, { onConflict: 'store_id' });
      throwIfError(error);
    },

    /** Saves the confirmed tiers of this store; creates the row (empty document) when none exists yet. */
    async saveRules(storeId, rules, nowIso) {
      requireStoreId(storeId);
      const { data, error } = await client.from('store_knowledge').update({ bulk_rules: rules, updated_at: nowIso }).eq('store_id', storeId).select('store_id');
      throwIfError(error);
      if ((data ?? []).length > 0) return;
      const inserted = await client.from('store_knowledge').insert({ store_id: storeId, content: '', bulk_rules: rules, updated_at: nowIso });
      throwIfError(inserted.error);
    },
  };
}
