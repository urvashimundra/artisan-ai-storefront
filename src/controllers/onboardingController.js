import { ZodError } from 'zod';
import { LANGUAGE_NAMES_ENGLISH } from '../domain/language.js';
import { AppError } from '../lib/errors.js';
import { fieldErrors } from './formErrors.js';
import { CONTACT_MESSAGES, contactValuesFromBody, contactValuesFromStore } from './shopForm.js';

const SEE_OTHER = 303;
const HTTP_OK = 200;
const HTTP_BAD_REQUEST = 400;
const LANGUAGES_PATH = '/store/new/languages';
const DONE_PATH = '/dashboard?welcome=1';
const SKIP_PATH = '/dashboard';

const hasDraftText = (row) => row.story !== '';
const withNames = (rows) => rows.map((row) => ({ ...row, name: LANGUAGE_NAMES_ENGLISH[row.language] }));

/**
 * Onboarding steps 2 (contact) and 3 (languages) after the store exists. The store comes from the session (`req.store`,
 * set by loadStore) and the owner from `req.owner`; neither is ever read from the request. `drafts` is absent when
 * Claude is not configured: step 3 then skips straight to the dashboard.
 * @param {{ stores: { updateContact: Function }, translations: object, drafts?: { draft: Function } }} deps
 */
export function createOnboardingController({ stores, translations, drafts }) {
  const contactPage = (res, status, view) =>
    res.status(status).render('store-contact', { title: 'Contact and payments', errors: {}, ...view });

  /** Renders step 3. Auto-submit is offered only on a clean GET with no drafts, never after a failure or a finished draft. */
  async function languagesPage(req, res, status, { rows, aiError = null, autosubmit = false }) {
    const review = rows.some(hasDraftText);
    return res.status(status).render('store-languages', {
      title: 'Your languages',
      rows: withNames(rows),
      review,
      autosubmit: autosubmit && !review,
      aiError,
      defaultLanguageName: LANGUAGE_NAMES_ENGLISH[req.store.defaultLanguage],
    });
  }

  const skipWithoutDrafts = (res) => res.redirect(SEE_OTHER, DONE_PATH);

  return {
    showContact(req, res) {
      return contactPage(res, HTTP_OK, { values: contactValuesFromStore(req.store) });
    },

    async postContact(req, res) {
      try {
        await stores.updateContact(req.owner.id, req.body ?? {});
      } catch (error) {
        if (!(error instanceof ZodError)) throw error;
        const errors = fieldErrors(error, CONTACT_MESSAGES);
        return contactPage(res, HTTP_BAD_REQUEST, { values: contactValuesFromBody(req.body), errors });
      }
      return res.redirect(SEE_OTHER, LANGUAGES_PATH);
    },

    async showLanguages(req, res) {
      if (!drafts) return skipWithoutDrafts(res);
      const rows = await translations.listForOwner(req.store);
      return languagesPage(req, res, HTTP_OK, { rows, autosubmit: req.query?.drafted !== '1' });
    },

    async draftLanguages(req, res) {
      if (!drafts) return skipWithoutDrafts(res);
      try {
        await drafts.draft({ store: req.store, owner: req.owner, correlationId: req.correlationId });
      } catch (error) {
        if (!(error instanceof AppError)) throw error;
        const rows = await translations.listForOwner(req.store);
        return languagesPage(req, res, error.httpStatus, { rows: rows.filter((row) => !hasDraftText(row)), aiError: error.message });
      }
      return res.redirect(SEE_OTHER, `${LANGUAGES_PATH}?drafted=1`);
    },

    async approveLanguages(req, res) {
      if (!drafts) return skipWithoutDrafts(res);
      await translations.approveAll(req.store);
      return res.redirect(SEE_OTHER, DONE_PATH);
    },
  };
}
