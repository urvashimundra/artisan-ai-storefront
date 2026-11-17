import { ZodError } from 'zod';
import { DEFAULT_ACCENT_KEY } from '../domain/palette.js';
import { buildProgress } from '../domain/onboardingProgress.js';
import { absoluteUrl, shopPath } from '../domain/seo.js';
import { MAX_STORY_LENGTH } from '../domain/storeRules.js';
import { SLUG_TAKEN } from '../services/storeService.js';
import { echoValues, fieldErrors } from './formErrors.js';
import { ACCENT_MESSAGE, ACCENT_OPTIONS, TAGLINE_MESSAGE } from './shopForm.js';

const SEE_OTHER = 303;
const HTTP_OK = 200;
const HTTP_BAD_REQUEST = 400;
const HTTP_CONFLICT = 409;
const LANGUAGE_NAMES = { en: 'English', gu: 'Gujarati', hi: 'Hindi' };
const FORM_FIELDS = ['name', 'slug', 'defaultLanguage', 'story', 'tagline', 'accentKey'];
const CONTACT_STEP_PATH = '/store/new/contact';
const NEW_STORE_PATH = '/store/new';
const STORE_MESSAGES = {
  name: 'Enter a store name of up to 80 characters.',
  slug: 'Use 1 to 40 lowercase letters, numbers or hyphens, not starting or ending with a hyphen. Names such as admin or api are reserved.',
  defaultLanguage: 'Choose English, Gujarati or Hindi.',
  story: 'Enter your story, up to 2000 characters.',
  tagline: TAGLINE_MESSAGE,
  accentKey: ACCENT_MESSAGE,
};

/**
 * Store creation and dashboard handlers. The owner always comes from the session (`req.owner`); the store is
 * resolved from that owner id. A store id is never read from the request.
 * Onboarding step 1 (creation) redirects to step 2; the dashboard shows the setup checklist until every step is done.
 * @param {{ stores: object, baseUrl: string, translations: object, products?: { list: (storeId: string) => Promise<object[]> },
 *   orders?: { pendingCount: (storeId: string) => Promise<number> }, enquiries?: { needsYouCount: (storeId: string) => Promise<number> },
 *   canDraft?: boolean }} deps
 */
export function createStoreController({ stores, baseUrl, translations, products, orders, enquiries, canDraft = false }) {
  const formPage = (res, status, errors, values) =>
    res.status(status).render('store-new', { title: 'Create your store', errors, values, accents: ACCENT_OPTIONS });

  async function progressFor(store) {
    const translationRows = await translations.listForOwner(store);
    const productCount = products ? (await products.list(store.id)).length : null;
    return buildProgress({ store, translationRows, productCount, canDraft });
  }

  function createFailure(req, res, error) {
    const values = echoValues(req.body, FORM_FIELDS, MAX_STORY_LENGTH);
    if (error instanceof ZodError) return formPage(res, HTTP_BAD_REQUEST, fieldErrors(error, STORE_MESSAGES), values);
    if (error.code === SLUG_TAKEN) return formPage(res, HTTP_CONFLICT, { slug: error.message }, values);
    throw error;
  }

  return {
    async showNewStore(req, res) {
      if (await stores.findForOwner(req.owner.id)) return res.redirect(SEE_OTHER, '/dashboard');
      return formPage(res, HTTP_OK, {}, { defaultLanguage: 'en', accentKey: DEFAULT_ACCENT_KEY });
    },

    async postNewStore(req, res) {
      try {
        await stores.create(req.owner.id, req.body ?? {});
      } catch (error) {
        return createFailure(req, res, error);
      }
      return res.redirect(SEE_OTHER, CONTACT_STEP_PATH);
    },

    async dashboard(req, res) {
      const store = await stores.findForOwner(req.owner.id);
      if (!store) return res.redirect(SEE_OTHER, NEW_STORE_PATH);
      const shopUrl = absoluteUrl(baseUrl, shopPath(store.slug));
      const progress = await progressFor(store);
      const welcome = req.query?.welcome === '1';
      const pendingPayments = orders ? await orders.pendingCount(store.id) : null;
      const needsYouEnquiries = enquiries ? await enquiries.needsYouCount(store.id) : null;
      return res.render('dashboard', { title: 'Dashboard', store, shopUrl, languageName: LANGUAGE_NAMES[store.defaultLanguage], progress, welcome, pendingPayments, needsYouEnquiries });
    },
  };
}
