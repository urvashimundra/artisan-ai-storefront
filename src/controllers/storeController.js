import { ZodError } from 'zod';
import { MAX_STORY_LENGTH } from '../domain/storeRules.js';
import { SLUG_TAKEN } from '../services/storeService.js';
import { echoValues, fieldErrors } from './formErrors.js';

const SEE_OTHER = 303;
const HTTP_OK = 200;
const HTTP_BAD_REQUEST = 400;
const HTTP_CONFLICT = 409;
const LANGUAGE_NAMES = { en: 'English', gu: 'Gujarati', hi: 'Hindi' };
const FORM_FIELDS = ['name', 'slug', 'defaultLanguage', 'story'];
const STORE_MESSAGES = {
  name: 'Enter a store name of up to 80 characters.',
  slug: 'Use 1 to 40 lowercase letters, numbers or hyphens, not starting or ending with a hyphen. Names such as admin or api are reserved.',
  defaultLanguage: 'Choose English, Gujarati or Hindi.',
  story: 'Enter your story, up to 2000 characters.',
};

/**
 * Store creation and dashboard handlers. The owner always comes from the session (`req.owner`); the store is
 * resolved from that owner id. A store id is never read from the request.
 * @param {{ stores: object }} deps
 */
export function createStoreController({ stores }) {
  const formPage = (res, status, errors, values) =>
    res.status(status).render('store-new', { title: 'Create your store', errors, values });

  function createFailure(req, res, error) {
    const values = echoValues(req.body, FORM_FIELDS, MAX_STORY_LENGTH);
    if (error instanceof ZodError) return formPage(res, HTTP_BAD_REQUEST, fieldErrors(error, STORE_MESSAGES), values);
    if (error.code === SLUG_TAKEN) return formPage(res, HTTP_CONFLICT, { slug: error.message }, values);
    throw error;
  }

  return {
    async showNewStore(req, res) {
      if (await stores.findForOwner(req.owner.id)) return res.redirect(SEE_OTHER, '/dashboard');
      return formPage(res, HTTP_OK, {}, { defaultLanguage: 'en' });
    },

    async postNewStore(req, res) {
      try {
        await stores.create(req.owner.id, req.body ?? {});
      } catch (error) {
        return createFailure(req, res, error);
      }
      return res.redirect(SEE_OTHER, '/dashboard');
    },

    async dashboard(req, res) {
      const store = await stores.findForOwner(req.owner.id);
      if (!store) return res.redirect(SEE_OTHER, '/store/new');
      return res.render('dashboard', { title: 'Dashboard', store, languageName: LANGUAGE_NAMES[store.defaultLanguage] });
    },
  };
}
