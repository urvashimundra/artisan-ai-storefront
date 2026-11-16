import { randomUUID } from 'node:crypto';
import { AppError } from '../../src/lib/errors.js';
import { PUBLIC_PRODUCT_LIMIT } from '../../src/repositories/publicShopRepository.js';
import { requireStoreId } from '../../src/repositories/requireStoreId.js';
import { createPublicShopService, resetSitemapCache } from '../../src/services/publicShopService.js';
import { createFakeImages } from './productFakes.js';
import { startAuthApp } from './appHarness.js';

export const PUBLIC_BASE_URL = 'https://shop.example.test';
export const SECRET_EMAIL = 'secret-owner@example.test';
export const SECRET_UPI = 'secret.upi@okbank';
export const SECRET_NUMBER = '919876543210';

export const translation = (title, description, altText, approved = true) => ({ title, description, altText, approved });

/**
 * In-memory public repository with the real repository's interface and rules: a shop is found by slug only, every
 * product method needs the store id AND the published status, and only approved translations are returned. Private
 * columns (owner id, contact email, UPI) exist on the rows so leaks would show, but are never returned.
 */
export function createFakePublicRepo() {
  const shops = [];
  const products = [];
  const calls = [];
  const failures = {};
  const enter = (name) => {
    calls.push(name);
    if (failures[name]) throw new AppError('DATABASE_ERROR', 500, 'Something went wrong');
  };
  const approvedOnly = (all) => Object.fromEntries(Object.entries(all).filter(([, value]) => value.approved));
  const toCard = (row) => ({ id: row.id, pricePaise: row.pricePaise, stock: row.stock, translations: approvedOnly(row.translations) });
  const published = (storeId) => products.filter((row) => row.storeId === requireStoreId(storeId) && row.status === 'published');

  return {
    shops,
    products,
    calls,
    failures,
    addShop(overrides = {}) {
      const row = {
        id: randomUUID(), ownerId: randomUUID(), slug: `test-${randomUUID().slice(0, 8)}`, name: 'Test Shop', defaultLanguage: 'en',
        story: 'A small family workshop.', tagline: '', accentKey: 'terracotta', whatsappNumber: null, whatsappEnabled: false,
        instagramHandle: null, updatedAt: '2026-11-10T08:00:00.000Z', contactEmail: SECRET_EMAIL, upiId: SECRET_UPI, ...overrides,
      };
      shops.push(row);
      return row;
    },
    addProduct(shop, overrides = {}) {
      const id = overrides.id ?? randomUUID();
      const row = {
        id, storeId: shop.id, status: 'published', pricePaise: 25000, stock: null, createdAt: '2026-11-10T08:00:00.000Z',
        updatedAt: '2026-11-11T08:00:00.000Z', imagePath: `${shop.id}/${id}/${randomUUID()}.jpg`,
        translations: { [shop.defaultLanguage]: translation('Clay diya', 'A hand made diya.', 'A terracotta diya on a table.') },
        ...overrides,
      };
      products.push(row);
      return row;
    },
    async findShopBySlug(slug) {
      enter('findShopBySlug');
      const row = shops.find((shop) => shop.slug === slug);
      if (!row) return null;
      const { ownerId: _o, contactEmail: _c, upiId: _u, ...publicFields } = row;
      return { ...publicFields };
    },
    async listPublished(storeId) {
      enter('listPublished');
      const rows = [...published(storeId)].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
      return rows.slice(0, PUBLIC_PRODUCT_LIMIT).map(toCard);
    },
    async findPublished(storeId, productId) {
      enter('findPublished');
      const row = published(storeId).find((product) => product.id === productId);
      return row ? toCard(row) : null;
    },
    async findPublishedImage(storeId, productId) {
      enter('findPublishedImage');
      const row = published(storeId).find((product) => product.id === productId);
      return row ? { id: row.id, imagePath: row.imagePath } : null;
    },
    async listSitemapEntries(limit) {
      enter('listSitemapEntries');
      return products
        .filter((row) => row.status === 'published')
        .sort((a, b) => a.id.localeCompare(b.id))
        .slice(0, limit)
        .map((row) => {
          const shop = shops.find((candidate) => candidate.id === row.storeId);
          return { productId: row.id, productUpdatedAt: row.updatedAt, slug: shop.slug, shopUpdatedAt: shop.updatedAt };
        });
    },
  };
}

/** Starts the real app with the real public service over the fake repository. */
export async function startPublicApp({ config = {}, appOptions = {}, repo = createFakePublicRepo(), imageOptions } = {}) {
  resetSitemapCache();
  const warnings = [];
  const images = createFakeImages();
  const signed = [];
  const createSignedUrl = images.createSignedUrl.bind(images);
  images.createSignedUrl = async (storeId, productId, path) => {
    const url = await createSignedUrl(storeId, productId, path);
    signed.push(url);
    return `${url}&n=${signed.length}`;
  };
  Object.assign(images.failures, imageOptions ?? {});
  const clock = { now: Date.parse('2026-11-16T10:00:00Z') };
  const publicShop = createPublicShopService({
    shops: repo,
    images,
    logger: { warn: (message, fields) => warnings.push({ message, ...fields }) },
    baseUrl: config.baseUrl ?? PUBLIC_BASE_URL,
    now: () => clock.now,
  });
  const app = await startAuthApp({ extraServices: { publicShop }, config: { baseUrl: PUBLIC_BASE_URL, ...config }, ...appOptions });
  return { ...app, repo, images, signed, warnings, clock };
}
