import { randomUUID } from 'node:crypto';
import { checkListingScripts } from '../ai/scriptCheck.js';
import { assertValidImage, buildImagePath } from '../domain/imageUpload.js';
import { parseReviewForm } from '../domain/productForm.js';
import { LANGUAGES } from '../domain/storeRules.js';
import { AppError, notFound } from '../lib/errors.js';
import { STALE_GENERATION_MS } from './listingService.js';

const HTTP_BAD_REQUEST = 400;
const HTTP_CONFLICT = 409;
const HTTP_UNPROCESSABLE = 422;

const REVIEW_REFUSALS = {
  price_required: () => new AppError('PRICE_REQUIRED', HTTP_UNPROCESSABLE, 'Enter a price before publishing.'),
  default_language_not_approved: () =>
    new AppError('DEFAULT_LANGUAGE_NOT_APPROVED', HTTP_UNPROCESSABLE, 'Approve your shop\'s default language before publishing.'),
  generating: () =>
    new AppError('GENERATION_IN_PROGRESS', HTTP_CONFLICT, 'A listing is being written for this product. Please wait a minute, refresh, then save your changes.'),
  invalid: () => new AppError('INVALID_PRODUCT', HTTP_BAD_REQUEST, 'Some of the product details are not valid.'),
};

const emptyTranslation = (language) => ({
  language,
  title: '',
  description: '',
  altText: '',
  source: 'owner',
  approved: false,
});

function byLanguage(translations) {
  return Object.fromEntries(LANGUAGES.map((language) => [language, translations.find((t) => t.language === language) ?? emptyTranslation(language)]));
}

/** Languages whose AI-written text is not in the expected script. Owner-edited text is never flagged. */
function scriptWarnings(translations) {
  const checkable = Object.fromEntries(
    LANGUAGES.map((language) => {
      const { title, description, altText } = translations[language];
      return [language, { title, description, alt_text: altText }];
    }),
  );
  const flags = checkListingScripts(checkable);
  return Object.fromEntries(LANGUAGES.map((language) => [language, translations[language].source === 'ai' && !flags[language]]));
}

/**
 * Product use cases that do not call the AI: photo upload, listing, review and delete. `storeId` always comes from
 * the authenticated owner's store, and every repository call is scoped by it.
 * @param {{ products: object, images: object, logger?: { error: Function }, now?: () => number,
 *   randomId?: () => string }} deps
 */
export function createProductService({ products, images, logger, now = Date.now, randomId = randomUUID }) {
  async function removeQuietly(storeId, productId, path) {
    try {
      await images.remove(storeId, productId, path);
    } catch {
      logger?.error('photo cleanup failed; object may be orphaned', { storeId, productId, path });
    }
  }

  async function signedUrlOrNull(storeId, product) {
    try {
      return await images.createSignedUrl(storeId, product.id, product.imagePath);
    } catch {
      logger?.error('photo signing failed', { storeId, productId: product.id });
      return null;
    }
  }

  const isGenerating = (product) =>
    product.aiStatus === 'generating' && Date.parse(product.aiStartedAt ?? '') > now() - STALE_GENERATION_MS;

  return {
    /**
     * Validates a photo by its bytes, stores it privately, then creates the draft product. If the product row
     * cannot be created the stored object is removed, so a failed upload leaves neither.
     * @param {string} storeId @param {unknown} body Raw request body.
     * @returns {Promise<{ id: string }>}
     * @throws {AppError} INVALID_IMAGE, IMAGE_TOO_LARGE, STORAGE_ERROR.
     */
    async createFromImage(storeId, body) {
      const detected = assertValidImage(body);
      const id = randomId();
      const path = buildImagePath({ storeId, productId: id, extension: detected.extension });
      try {
        await images.upload(storeId, id, path, body, detected.contentType);
        await products.insert(storeId, { id, imagePath: path, imageContentType: detected.contentType });
      } catch (error) {
        await removeQuietly(storeId, id, path);
        throw error;
      }
      return { id };
    },

    /** @param {string} storeId @returns {Promise<object[]>} Products with `translations` by language, newest first. */
    async list(storeId) {
      const rows = await products.listByStore(storeId);
      return rows.map((product) => ({ ...product, translations: byLanguage(product.translations), generating: isGenerating(product) }));
    },

    /**
     * Everything the review page needs. A signing failure only hides the picture.
     * @returns {Promise<{ product: object, translations: object, imageUrl: string | null, scriptWarnings: object, generating: boolean }>}
     * @throws {AppError} NOT_FOUND when the product is not in this store.
     */
    async getForEdit(storeId, productId) {
      const product = await products.findById(storeId, productId);
      if (!product) throw notFound('Product not found');
      const translations = byLanguage(product.translations);
      return {
        product,
        translations,
        imageUrl: await signedUrlOrNull(storeId, product),
        scriptWarnings: scriptWarnings(translations),
        generating: isGenerating(product),
      };
    },

    /**
     * Saves the owner's review (and publishes when asked). Story, stock, translations, approvals, price and status
     * are applied by one database function in one transaction, so a refusal changes nothing. It also refuses while
     * a generation is running. The returned status is the database's answer, never an assumption.
     * @returns {Promise<{ status: 'draft' | 'published' }>}
     * @throws {import('zod').ZodError} Invalid form. @throws {AppError} NOT_FOUND, GENERATION_IN_PROGRESS, PRICE_REQUIRED, DEFAULT_LANGUAGE_NOT_APPROVED.
     */
    async saveReview(storeId, productId, form) {
      const { review, stock } = parseReviewForm(form);
      const result = await products.saveReview(storeId, productId, {
        story: review.story,
        stock,
        pricePaise: review.price,
        translations: review.translations,
        approvedLanguages: review.approvedLanguages,
        publish: review.publish,
      });
      if (result.ok) return { status: result.status };
      throw result.reason === 'not_found' ? notFound('Product not found') : REVIEW_REFUSALS[result.reason]();
    },

    /**
     * Deletes the product row first, then its photo. A storage failure is logged (the object is orphaned but
     * unreachable) and never reported as a failed delete.
     * @returns {Promise<{ photoRemoved: boolean }>}
     * @throws {AppError} NOT_FOUND when the product is not in this store.
     */
    async remove(storeId, productId) {
      const path = await products.deleteById(storeId, productId);
      if (path === null) throw notFound('Product not found');
      try {
        await images.remove(storeId, productId, path);
        return { photoRemoved: true };
      } catch {
        logger?.error('photo removal failed after product delete; object is orphaned', { storeId, productId, path });
        return { photoRemoved: false };
      }
    },
  };
}
