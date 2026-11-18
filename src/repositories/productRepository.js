import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { AppError } from '../lib/errors.js';
import { requireStoreId } from './requireStoreId.js';
import { throwIfError } from './pgErrors.js';

const HTTP_INTERNAL_ERROR = 500;
const MAX_LISTED_PRODUCTS = 200;
const PRODUCT_COLUMNS =
  'id, status, price_paise, stock, story, image_path, image_content_type, ai_status, ai_started_at, created_at, updated_at';
const CLAIM_COLUMNS = `${PRODUCT_COLUMNS}, ai_generation_id`;
const TRANSLATION_COLUMNS = 'language, title, description, alt_text, source, approved';
const WITH_TRANSLATIONS = `${PRODUCT_COLUMNS}, product_translations(${TRANSLATION_COLUMNS})`;
const GENERATION_END_STATES = Object.freeze(['idle', 'failed']);

const translationRowSchema = z.object({
  language: z.enum(['en', 'gu', 'hi']),
  title: z.string(),
  description: z.string(),
  alt_text: z.string(),
  source: z.enum(['ai', 'owner']),
  approved: z.boolean(),
});

const productRowSchema = z.object({
  id: z.uuid(),
  status: z.enum(['draft', 'published']),
  price_paise: z.number().int().nullable(),
  stock: z.number().int().nullable(),
  story: z.string(),
  image_path: z.string(),
  image_content_type: z.string().nullable(),
  ai_status: z.enum(['idle', 'generating', 'failed']),
  ai_started_at: z.string().nullable(),
  ai_generation_id: z.uuid().nullable().optional(),
  created_at: z.string(),
  updated_at: z.string(),
  product_translations: z.array(translationRowSchema).optional(),
});

const aiListingResultSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), draft_id: z.uuid() }).strict(),
  z.object({ ok: z.literal(false), reason: z.enum(['not_found', 'not_draft', 'stale_generation', 'invalid']) }).strict(),
]);

const reviewResultSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), status: z.enum(['draft', 'published']) }).strict(),
  z
    .object({
      ok: z.literal(false),
      reason: z.enum(['not_found', 'generating', 'price_required', 'default_language_not_approved', 'invalid']),
    })
    .strict(),
]);

const translationDraftsResultSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), saved: z.array(z.enum(['en', 'gu', 'hi'])), skipped: z.array(z.enum(['en', 'gu', 'hi'])) }).strict(),
  z.object({ ok: z.literal(false), reason: z.enum(['not_found', 'generating', 'invalid']) }).strict(),
]);

function requireGenerationId(generationId) {
  if (!z.uuid().safeParse(generationId).success) throw new TypeError('A generation id is required');
  return generationId;
}

function failure(operation, details) {
  return new AppError('DATABASE_ERROR', HTTP_INTERNAL_ERROR, 'Something went wrong', { operation, ...details });
}

function parseShape(schema, value, operation) {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw failure(operation, { reason: 'unexpected_result_shape' });
  return parsed.data;
}

const toTranslation = (row) => ({
  language: row.language,
  title: row.title,
  description: row.description,
  altText: row.alt_text,
  source: row.source,
  approved: row.approved,
});

function toProduct(row, operation) {
  const parsed = parseShape(productRowSchema, row, operation);
  return {
    id: parsed.id,
    status: parsed.status,
    pricePaise: parsed.price_paise,
    stock: parsed.stock,
    story: parsed.story,
    imagePath: parsed.image_path,
    imageContentType: parsed.image_content_type,
    aiStatus: parsed.ai_status,
    aiStartedAt: parsed.ai_started_at,
    createdAt: parsed.created_at,
    updatedAt: parsed.updated_at,
    translations: (parsed.product_translations ?? []).map(toTranslation),
  };
}

async function callRpc(client, operation, args, schema) {
  const { data, error } = await client.rpc(operation, args);
  if (error) throw failure(operation, { pgCode: error.code });
  return parseShape(schema, data, operation);
}

/**
 * Product persistence (products, product_translations, and the two RPCs as replaced by Migration 005). Every method takes
 * storeId first and scopes its query by it; a product id alone is never enough to read or change a row.
 * @param {{ client: any, newGenerationId?: () => string }} deps
 */
export function createProductRepository({ client, newGenerationId = randomUUID }) {
  const owned = (query, storeId, productId) => query.eq('id', productId).eq('store_id', requireStoreId(storeId));

  return {
    /** Inserts a draft product whose image is already stored. @returns {Promise<object>} */
    async insert(storeId, { id, imagePath, imageContentType }) {
      requireStoreId(storeId);
      const row = { id, store_id: requireStoreId(storeId), image_path: imagePath, image_content_type: imageContentType };
      const { data, error } = await client.from('products').insert(row).select(PRODUCT_COLUMNS).single();
      throwIfError(error);
      return toProduct(data, 'products.insert');
    },

    /** Newest first, at most 200, each with its translations. @returns {Promise<object[]>} */
    async listByStore(storeId) {
      requireStoreId(storeId);
      const { data, error } = await client
        .from('products')
        .select(WITH_TRANSLATIONS)
        .eq('store_id', requireStoreId(storeId))
        .order('created_at', { ascending: false })
        .limit(MAX_LISTED_PRODUCTS);
      throwIfError(error);
      return (data ?? []).map((row) => toProduct(row, 'products.list'));
    },

    /** @returns {Promise<object | null>} null when the product does not exist IN THIS STORE. */
    async findById(storeId, productId) {
      requireStoreId(storeId);
      const query = client.from('products').select(WITH_TRANSLATIONS);
      const { data, error } = await owned(query, storeId, productId).maybeSingle();
      throwIfError(error);
      return data ? toProduct(data, 'products.find') : null;
    },

    /**
     * Atomically takes the generation slot of a DRAFT product, saves the story and stamps a fresh fencing token. One
     * UPDATE: it matches only when nothing is generating, or the previous run started before `staleBeforeIso`.
     * The token is the proof of ownership for every later write of this run.
     * @returns {Promise<(object & { generationId: string }) | null>} The product, or null when not found, published or generating.
     */
    async claimGeneration(storeId, productId, { story, nowIso, staleBeforeIso }) {
      requireStoreId(storeId);
      const generationId = newGenerationId();
      const changes = { ai_status: 'generating', ai_started_at: nowIso, ai_generation_id: generationId, story, updated_at: nowIso };
      const query = owned(client.from('products').update(changes), storeId, productId)
        .eq('status', 'draft')
        .or(`ai_status.neq.generating,ai_started_at.is.null,ai_started_at.lt.${staleBeforeIso}`);
      const { data, error } = await query.select(CLAIM_COLUMNS);
      throwIfError(error);
      return data?.length ? { ...toProduct(data[0], 'products.claim'), generationId } : null;
    },

    /** Ends a generation without a result. Changes nothing unless the product still holds THIS run's token. */
    async finishGeneration(storeId, productId, generationId, state) {
      requireStoreId(storeId);
      requireGenerationId(generationId);
      if (!GENERATION_END_STATES.includes(state)) throw new TypeError('Unknown generation state');
      const changes = { ai_status: state, ai_started_at: null, ai_generation_id: null };
      const query = owned(client.from('products').update(changes), storeId, productId)
        .eq('ai_status', 'generating')
        .eq('ai_generation_id', generationId);
      const { error } = await query;
      throwIfError(error);
    },

    /** RPC save_ai_listing. @returns {Promise<{ ok: true, draftId: string } | { ok: false, reason: string }>} */
    async saveAiListing(storeId, productId, { generationId, translations, model, tokensIn, tokensOut, costMicroUsd }) {
      const args = {
        p_store_id: requireStoreId(storeId),
        p_product_id: productId,
        p_generation_id: requireGenerationId(generationId),
        p_translations: translations,
        p_model: model,
        p_tokens_in: tokensIn,
        p_tokens_out: tokensOut,
        p_cost: costMicroUsd,
      };
      const result = await callRpc(client, 'save_ai_listing', args, aiListingResultSchema);
      return result.ok ? { ok: true, draftId: result.draft_id } : result;
    },

    /**
     * RPC save_product_translation_drafts: title and description only, as unapproved AI drafts, in one transaction. A language whose approved
     * text the owner wrote is skipped and reported.
     * @param {string} storeId @param {string} productId @param {Record<string, { title: string, description: string }>} translations
     * @returns {Promise<{ ok: true, saved: string[], skipped: string[] } | { ok: false, reason: string }>}
     */
    async saveTranslationDrafts(storeId, productId, translations) {
      const args = { p_store_id: requireStoreId(storeId), p_product_id: productId, p_translations: translations };
      return callRpc(client, 'save_product_translation_drafts', args, translationDraftsResultSchema);
    },

    /** RPC save_product_review: story, stock and everything else in one transaction. @returns {Promise<{ ok: true, status: string } | { ok: false, reason: string }>} */
    async saveReview(storeId, productId, { story, stock, pricePaise, translations, approvedLanguages, publish }) {
      const args = {
        p_store_id: requireStoreId(storeId),
        p_product_id: productId,
        p_story: story,
        p_stock: stock,
        p_price_paise: pricePaise,
        p_translations: translations,
        p_approved_langs: approvedLanguages,
        p_publish: publish,
      };
      return callRpc(client, 'save_product_review', args, reviewResultSchema);
    },

    /** Deletes the product (translations cascade). @returns {Promise<string | null>} Its image path, or null. */
    async deleteById(storeId, productId) {
      requireStoreId(storeId);
      const { data, error } = await owned(client.from('products').delete(), storeId, productId).select('image_path');
      throwIfError(error);
      return data?.length ? data[0].image_path : null;
    },
  };
}
