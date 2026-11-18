import { ZodError } from 'zod';
import { LANGUAGE_NAMES_ENGLISH } from '../domain/language.js';
import { REVIEW_INTENTS, formatPriceInput } from '../domain/productForm.js';
import { productIdParamsSchema } from '../domain/productRules.js';
import { LANGUAGES } from '../domain/storeRules.js';
import { notFound } from '../lib/errors.js';
import { STORY_MESSAGE, reviewFormErrors } from './productErrors.js';

const SEE_OTHER = 303;
const HTTP_CREATED = 201;
const HTTP_OK = 200;
const HTTP_BAD_REQUEST = 400;
const MAX_ECHO_LENGTH = 6000;
const LANGUAGE_NAMES = Object.freeze({ en: 'English', gu: 'Gujarati', hi: 'Hindi' });
const NOTICES = Object.freeze({
  generated: 'The AI draft is ready. Read each language, edit it, and approve it when you are happy.',
  saved: 'Saved as a draft.',
  published: 'Published.',
  'saved-live': 'Changes saved.',
  deleted: 'The product was deleted.',
});
/** Failures the owner can act on; each is shown on the page with its own status. Everything else is rethrown. */
const GENERATION_CODES = new Set([
  'NOT_DRAFT',
  'GENERATION_IN_PROGRESS',
  'GENERATION_SUPERSEDED',
  'AI_BUDGET_EXHAUSTED',
  'AI_BUDGET_UNAVAILABLE',
  'AI_TIMEOUT',
  'AI_PROVIDER_ERROR',
  'AI_INVALID_OUTPUT',
  'STORAGE_ERROR',
  'INVALID_IMAGE',
]);
const TRANSLATE_CODES = new Set(['NOTHING_TO_TRANSLATE', 'GENERATION_IN_PROGRESS', 'AI_BUDGET_EXHAUSTED', 'AI_BUDGET_UNAVAILABLE', 'AI_TIMEOUT', 'AI_PROVIDER_ERROR', 'AI_INVALID_OUTPUT']);
const DEFAULT_LANGUAGE_REFUSAL = 'DEFAULT_LANGUAGE_NOT_APPROVED';
const REVIEW_CODES = new Set(['GENERATION_IN_PROGRESS', 'PRICE_REQUIRED', DEFAULT_LANGUAGE_REFUSAL, 'INVALID_PRODUCT']);

const namesOf = (codes) => codes.map((code) => LANGUAGE_NAMES[code]).join(', ');

/** The notice after a translation update. The language lists come from the query string, so only known codes are used. */
function translatedNotice(query) {
  const known = (value) => (typeof value === 'string' ? value.split(',').filter((code) => LANGUAGES.includes(code)) : []);
  const updated = known(query.updated);
  const skipped = known(query.skipped);
  const parts = [updated.length > 0 ? `Drafts written for ${namesOf(updated)}. Read them and approve them when you are happy.` : 'No language needed updating.'];
  if (skipped.length > 0) parts.push(`Kept your own approved text in ${namesOf(skipped)}.`);
  return parts.join(' ');
}

function parseProductId(params) {
  const parsed = productIdParamsSchema.safeParse(params);
  if (!parsed.success) throw notFound('Product not found');
  return parsed.data.id;
}

const stringField = (body, name) => (typeof body?.[name] === 'string' ? body[name].slice(0, MAX_ECHO_LENGTH) : undefined);

/** Form values: what the database holds, overridden by what was just submitted when a form is shown again. */
function buildValues(view, body) {
  const { product, translations } = view;
  const submittedReview = typeof body?.intent === 'string';
  const values = {
    story: stringField(body, 'story') ?? product.story,
    price: stringField(body, 'price') ?? formatPriceInput(product.pricePaise),
    stock: stringField(body, 'stock') ?? (product.stock === null ? '' : String(product.stock)),
  };
  for (const language of LANGUAGES) {
    const stored = translations[language];
    values[`title_${language}`] = stringField(body, `title_${language}`) ?? stored.title;
    values[`description_${language}`] = stringField(body, `description_${language}`) ?? stored.description;
    values[`alt_text_${language}`] = stringField(body, `alt_text_${language}`) ?? stored.altText;
    values[`approved_${language}`] = submittedReview ? body[`approved_${language}`] === 'on' : stored.approved;
  }
  return values;
}

function productTitle(product, defaultLanguage) {
  const preferred = product.translations[defaultLanguage]?.title;
  const any = LANGUAGES.map((language) => product.translations[language].title).find(Boolean);
  return preferred || any || '';
}

/**
 * Owner product handlers (HTTP only). The store is `req.store`, resolved from the session's owner; no store id or
 * owner id is ever read from the request. A product id from the URL is only ever used together with that store.
 * @param {{ products: ReturnType<typeof import('../services/productService.js').createProductService>,
 *   listings: ReturnType<typeof import('../services/listingService.js').createListingService> }} deps
 */
export function createProductController({ products, listings, translations = null }) {
  async function renderEdit(req, res, { status = HTTP_OK, body, errors = {}, formError, generateError, notice, approvalRefusal = null }) {
    const view = await products.getForEdit(req.store.id, parseProductId(req.params));
    return res.status(status).render('product-edit', {
      title: 'Review product',
      ...view,
      languages: LANGUAGES.map((code) => ({ code, name: LANGUAGE_NAMES[code] })),
      defaultLanguage: req.store.defaultLanguage,
      defaultLanguageName: LANGUAGE_NAMES[req.store.defaultLanguage],
      values: buildValues(view, body),
      errors,
      formError,
      generateError,
      notice,
      approvalRefusal,
      canTranslate: translations !== null,
    });
  }

  return {
    async list(req, res) {
      const rows = await products.list(req.store.id);
      const items = rows.map((product) => ({ ...product, displayTitle: productTitle(product, req.store.defaultLanguage) }));
      return res.render('products', { title: 'Products', products: items, notice: NOTICES[req.query.notice] });
    },

    showNew(_req, res) {
      return res.render('product-new', { title: 'Add a product' });
    },

    async postImage(req, res) {
      const { id } = await products.createFromImage(req.store.id, req.body);
      return res.status(HTTP_CREATED).json({ id, generateUrl: `/products/${id}/generate` });
    },

    showEdit(req, res) {
      const notice = req.query.notice === 'translated' ? translatedNotice(req.query) : NOTICES[req.query.notice];
      return renderEdit(req, res, { notice });
    },

    /** The "Update other languages?" confirmation. No side effects. */
    async confirmTranslate(req, res) {
      const view = await products.getForEdit(req.store.id, parseProductId(req.params));
      return res.render('product-update-languages', {
        title: 'Update other languages', product: view.product, defaultLanguageName: LANGUAGE_NAMES[req.store.defaultLanguage],
        otherNames: LANGUAGES.filter((code) => code !== req.store.defaultLanguage).map((code) => LANGUAGE_NAMES[code]),
      });
    },

    async postTranslate(req, res) {
      const productId = parseProductId(req.params);
      try {
        const { languages, skipped } = await translations.update({ store: req.store, owner: req.owner, productId, correlationId: req.correlationId });
        return res.redirect(SEE_OTHER, `/products/${productId}/edit?notice=translated&updated=${languages.join(',')}&skipped=${skipped.join(',')}`);
      } catch (error) {
        if (!TRANSLATE_CODES.has(error.code)) throw error;
        return renderEdit(req, res, { status: error.httpStatus, formError: error.message });
      }
    },

    async postGenerate(req, res) {
      const productId = parseProductId(req.params);
      try {
        await listings.generate({
          storeId: req.store.id,
          owner: req.owner,
          productId,
          input: req.body ?? {},
          correlationId: req.correlationId,
        });
      } catch (error) {
        return generationFailure(req, res, error);
      }
      return res.redirect(SEE_OTHER, `/products/${productId}/edit?notice=generated`);
    },

    async postSave(req, res) {
      const productId = parseProductId(req.params);
      try {
        const { status } = await products.saveReview(req.store.id, productId, req.body);
        const wasPublish = req.body?.intent === REVIEW_INTENTS.publish;
        const notice = status === 'published' ? (wasPublish ? 'published' : 'saved-live') : 'saved';
        return res.redirect(SEE_OTHER, `/products/${productId}/edit?notice=${notice}`);
      } catch (error) {
        return reviewFailure(req, res, error);
      }
    },

    async postDelete(req, res) {
      await products.remove(req.store.id, parseProductId(req.params));
      return res.redirect(SEE_OTHER, '/products?notice=deleted');
    },
  };

  function generationFailure(req, res, error) {
    if (error instanceof ZodError) {
      if (error.issues.some((issue) => issue.code === 'unrecognized_keys')) throw error;
      return renderEdit(req, res, { status: HTTP_BAD_REQUEST, body: req.body, generateError: STORY_MESSAGE });
    }
    if (!GENERATION_CODES.has(error.code)) throw error;
    return renderEdit(req, res, { status: error.httpStatus, body: req.body, generateError: error.message });
  }

  /** The shop's default language is not approved, so publishing is refused: name that language at the top and next to its approval box. */
  function defaultLanguageRefusal(req, res, error) {
    const message = `Approve the ${LANGUAGE_NAMES_ENGLISH[req.store.defaultLanguage]} text before publishing.`;
    return renderEdit(req, res, { status: error.httpStatus, body: req.body, formError: message, approvalRefusal: { language: req.store.defaultLanguage, message } });
  }

  function reviewFailure(req, res, error) {
    if (error instanceof ZodError) {
      return renderEdit(req, res, { status: HTTP_BAD_REQUEST, body: req.body, errors: reviewFormErrors(error) });
    }
    if (error.code === DEFAULT_LANGUAGE_REFUSAL) return defaultLanguageRefusal(req, res, error);
    if (!REVIEW_CODES.has(error.code)) throw error;
    return renderEdit(req, res, { status: error.httpStatus, body: req.body, formError: error.message });
  }
}
