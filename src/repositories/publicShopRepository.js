import { z } from 'zod';
import { AppError } from '../lib/errors.js';
import { throwIfError } from './pgErrors.js';
import { requireStoreId } from './requireStoreId.js';

import { MAX_PUBLIC_PRODUCTS } from '../domain/storeRules.js';

/** One more than is shown, so the page can say that further products exist instead of dropping them silently. */
export const PUBLIC_PRODUCT_FETCH_LIMIT = MAX_PUBLIC_PRODUCTS + 1;
const HTTP_INTERNAL_ERROR = 500;

/*
 * Explicit allowlists of PUBLIC columns. Never add owner_id, contact_email, upi_id, password or credential fields, and
 * never select image_content_type or ai_* columns. whatsapp_number is selected only so the service can build the
 * wa.me link after the owner opted in; the service never copies it into a view model.
 */
const SHOP_COLUMNS =
  'id, slug, name, default_language, story, tagline, accent_key, whatsapp_number, whatsapp_enabled, instagram_handle, updated_at';
const CARD_TRANSLATION_COLUMNS = 'language, title, alt_text, approved';
const PAGE_TRANSLATION_COLUMNS = 'language, title, description, alt_text, approved';
const CARD_COLUMNS = `id, price_paise, stock, created_at, product_translations(${CARD_TRANSLATION_COLUMNS})`;
const PAGE_COLUMNS = `id, price_paise, stock, product_translations(${PAGE_TRANSLATION_COLUMNS})`;
const PAGE_COLUMNS_WITH_DATE = `id, price_paise, stock, created_at, product_translations(${PAGE_TRANSLATION_COLUMNS})`;
const STORE_TRANSLATION_COLUMNS = 'language, tagline, story, approved';
const IMAGE_COLUMNS = 'id, image_path';
const SITEMAP_COLUMNS = 'id, updated_at, stores!inner(slug, updated_at)';
const APPROVED_FILTER_COLUMN = 'product_translations.approved';

const language = z.enum(['en', 'gu', 'hi']);
const translationRow = z.object({
  language,
  title: z.string(),
  description: z.string().optional(),
  alt_text: z.string(),
  approved: z.boolean(),
});
const shopRow = z.object({
  id: z.uuid(),
  slug: z.string(),
  name: z.string(),
  default_language: language,
  story: z.string(),
  tagline: z.string(),
  accent_key: z.string(),
  whatsapp_number: z.string().nullable(),
  whatsapp_enabled: z.boolean(),
  instagram_handle: z.string().nullable(),
  updated_at: z.string(),
});
const productRow = z.object({
  id: z.uuid(),
  price_paise: z.number().int().nullable(),
  stock: z.number().int().nullable(),
  product_translations: z.array(translationRow).optional(),
});
const storeTranslationRow = z.object({ language, tagline: z.string(), story: z.string(), approved: z.boolean() });
const imageRow = z.object({ id: z.uuid(), image_path: z.string() });
const sitemapRow = z.object({
  id: z.uuid(),
  updated_at: z.string(),
  stores: z.object({ slug: z.string(), updated_at: z.string() }),
});

function parseRow(schema, value, operation) {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new AppError('DATABASE_ERROR', HTTP_INTERNAL_ERROR, 'Something went wrong', { operation, reason: 'unexpected_result_shape' });
  }
  return parsed.data;
}

const toTranslations = (rows = []) =>
  Object.fromEntries(
    rows.map((row) => [
      row.language,
      { title: row.title, description: row.description ?? '', altText: row.alt_text, approved: row.approved },
    ]),
  );

const toProduct = (row) => ({
  id: row.id,
  pricePaise: row.price_paise,
  stock: row.stock,
  translations: toTranslations(row.product_translations),
});

const toShop = (row) => ({
  id: row.id,
  slug: row.slug,
  name: row.name,
  defaultLanguage: row.default_language,
  story: row.story,
  tagline: row.tagline,
  accentKey: row.accent_key,
  whatsappNumber: row.whatsapp_number,
  whatsappEnabled: row.whatsapp_enabled,
  instagramHandle: row.instagram_handle,
  updatedAt: row.updated_at,
});

/**
 * Read-only repository for the public storefront. Every store-scoped method takes storeId first and filters by it AND by
 * status = 'published'. The store id itself is only ever obtained by resolving a validated slug (findShopBySlug).
 * Two methods are documented entry points that are not store-scoped (see docs/DECISIONS.md and the tenancy scan test):
 * findShopBySlug (resolves the slug) and listSitemapEntries (the only cross-store query, explicit public columns only).
 * @param {{ client: any }} deps
 */
export function createPublicShopRepository({ client }) {
  /** Validates the store id BEFORE building any query, then scopes to that store's published products. */
  const publishedProducts = (storeId, columns) => {
    requireStoreId(storeId);
    return client.from('products').select(columns).eq('store_id', storeId).eq('status', 'published');
  };

  return {
    /** Resolves a validated, lowercase slug to the public shop fields. @returns {Promise<object | null>} */
    async findShopBySlug(slug) {
      const { data, error } = await client.from('stores').select(SHOP_COLUMNS).eq('slug', slug).maybeSingle();
      throwIfError(error);
      return data ? toShop(parseRow(shopRow, data, 'public.findShopBySlug')) : null;
    },

    /**
     * Approved translated tagline and story of this store, keyed by language. Only approved rows are ever selected.
     * @returns {Promise<Record<string, { tagline: string, story: string, approved: boolean }>>}
     */
    async listStoreTranslations(storeId) {
      requireStoreId(storeId);
      const query = client.from('store_translations').select(STORE_TRANSLATION_COLUMNS).eq('store_id', storeId).eq('approved', true);
      const { data, error } = await query;
      throwIfError(error);
      const rows = (data ?? []).map((row) => parseRow(storeTranslationRow, row, 'public.listStoreTranslations'));
      return Object.fromEntries(rows.map((row) => [row.language, { tagline: row.tagline, story: row.story, approved: row.approved }]));
    },

    /** Newest first, at most 49 (48 shown plus one to detect more), approved translations only. @returns {Promise<object[]>} */
    async listPublished(storeId) {
      const query = publishedProducts(storeId, CARD_COLUMNS)
        .eq(APPROVED_FILTER_COLUMN, true)
        .order('created_at', { ascending: false })
        .order('id', { ascending: false })
        .limit(PUBLIC_PRODUCT_FETCH_LIMIT);
      const { data, error } = await query;
      throwIfError(error);
      return (data ?? []).map((row) => toProduct(parseRow(productRow, row, 'public.listPublished')));
    },

    /**
     * Same products and order as listPublished, WITH the approved descriptions: the assistant's catalogue view (it must read what the shop
     * says about a product, not only its title). Public columns only, still capped at the 49 rows listPublished fetches.
     * @returns {Promise<object[]>}
     */
    async listPublishedWithDescriptions(storeId) {
      const query = publishedProducts(storeId, PAGE_COLUMNS_WITH_DATE)
        .eq(APPROVED_FILTER_COLUMN, true)
        .order('created_at', { ascending: false })
        .order('id', { ascending: false })
        .limit(PUBLIC_PRODUCT_FETCH_LIMIT);
      const { data, error } = await query;
      throwIfError(error);
      return (data ?? []).map((row) => toProduct(parseRow(productRow, row, 'public.listPublishedWithDescriptions')));
    },

    /** @returns {Promise<object | null>} null unless the product is published in THIS store. */
    async findPublished(storeId, productId) {
      const query = publishedProducts(storeId, PAGE_COLUMNS)
        .eq('id', productId)
        .eq(APPROVED_FILTER_COLUMN, true);
      const { data, error } = await query.maybeSingle();
      throwIfError(error);
      return data ? toProduct(parseRow(productRow, data, 'public.findPublished')) : null;
    },

    /** @returns {Promise<{ id: string, imagePath: string } | null>} null unless published in THIS store. */
    async findPublishedImage(storeId, productId) {
      const query = publishedProducts(storeId, IMAGE_COLUMNS).eq('id', productId);
      const { data, error } = await query.maybeSingle();
      throwIfError(error);
      if (!data) return null;
      const row = parseRow(imageRow, data, 'public.findPublishedImage');
      return { id: row.id, imagePath: row.image_path };
    },

    /**
     * The ONLY cross-store query. Published products with their shop's slug, using only these public columns: product
     * id and updated_at, shop slug and updated_at. Deterministic (ordered by product id) and capped at `limit` rows.
     * @param {number} limit
     * @returns {Promise<{ productId: string, productUpdatedAt: string, slug: string, shopUpdatedAt: string }[]>}
     */
    async listSitemapEntries(limit) {
      const query = client.from('products').select(SITEMAP_COLUMNS).eq('status', 'published').order('id', { ascending: true }).limit(limit);
      const { data, error } = await query;
      throwIfError(error);
      return (data ?? []).map((raw) => {
        const row = parseRow(sitemapRow, raw, 'public.listSitemapEntries');
        return { productId: row.id, productUpdatedAt: row.updated_at, slug: row.stores.slug, shopUpdatedAt: row.stores.updated_at };
      });
    },
  };
}
