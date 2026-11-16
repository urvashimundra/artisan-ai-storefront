import { ZodError } from 'zod';
import { DEFAULT_ACCENT_KEY } from '../domain/palette.js';
import { LANGUAGE_NAMES_ENGLISH, isSupportedLanguage } from '../domain/language.js';
import { MAX_TRANSLATED_STORY_LENGTH, MAX_TRANSLATED_TAGLINE_LENGTH } from '../domain/storeTranslations.js';
import { AppError } from '../lib/errors.js';
import { echoValues, fieldErrors } from './formErrors.js';
import {
  ACCENT_MESSAGE, ACCENT_OPTIONS, CONTACT_MESSAGES, TAGLINE_MESSAGE, contactValuesFromBody, contactValuesFromStore,
} from './shopForm.js';

const SEE_OTHER = 303;
const HTTP_OK = 200;
const HTTP_BAD_REQUEST = 400;
const SETTINGS_PATH = '/store/settings';
const TEXT_FIELDS = ['tagline', 'accentKey'];
const STORY_FIELDS = ['story'];
const TRANSLATION_FIELDS = ['language', 'tagline', 'story'];
const MAX_ECHO_LENGTH = 200;
const MAX_STORY_ECHO_LENGTH = MAX_TRANSLATED_STORY_LENGTH * 4;
const SETTINGS_MESSAGES = {
  tagline: TAGLINE_MESSAGE,
  story: `Write your story, from 1 to ${MAX_TRANSLATED_STORY_LENGTH} characters.`,
  accentKey: ACCENT_MESSAGE,
  ...CONTACT_MESSAGES,
};
const TRANSLATION_MESSAGE = `Check the lengths: tagline up to ${MAX_TRANSLATED_TAGLINE_LENGTH}, story up to ${MAX_TRANSLATED_STORY_LENGTH} characters.`;
const NOTICES = {
  1: 'Your shop settings were saved.',
  translation: 'Your translation was saved.',
  drafts: 'Claude wrote draft translations. They are not public until you read them and tick Approve.',
  skipped: 'Nothing was drafted.',
};
const SKIPPED_NOTE = (names) => ` Skipped ${names}: you already approved your own text there, and a draft never replaces it.`;

const toFormValues = (store) => ({
  tagline: store.tagline,
  story: store.story,
  accentKey: store.accentKey,
  ...contactValuesFromStore(store),
});

/** Notice text from the redirect query; the skipped list is filtered to real languages before it is shown. */
function noticeFor(query) {
  const base = NOTICES[query?.saved];
  if (!base) return null;
  const skipped = String(query.skipped ?? '').split(',').filter(isSupportedLanguage);
  const names = [...new Set(skipped)].map((language) => LANGUAGE_NAMES_ENGLISH[language]).join(' and ');
  return names ? `${base}${SKIPPED_NOTE(names)}` : base;
}

const withNames = (rows) => rows.map((row) => ({ ...row, name: LANGUAGE_NAMES_ENGLISH[row.language] }));

/**
 * Owner shop-settings page, including translated tagline and story. The store always comes from the session
 * (`req.store`, set by loadStore); the owner id is `req.owner.id`. A store id is never read from the request: the
 * strict schemas reject one. `drafts` is absent when Claude is not configured, which hides the draft button.
 * @param {{ stores: { updateSettings: (ownerId: string, input: unknown) => Promise<object> },
 *   translations: ReturnType<typeof import('../services/storeTranslationService.js').createStoreTranslationService>,
 *   drafts?: ReturnType<typeof import('../services/translationDraftService.js').createTranslationDraftService> }} deps
 */
export function createShopSettingsController({ stores, translations, drafts }) {
  async function page(req, res, status, view = {}) {
    const rows = view.rows ?? (await translations.listForOwner(req.store));
    return res.status(status).render('shop-settings', {
      title: 'Shop settings',
      values: view.values ?? toFormValues(req.store),
      errors: view.errors ?? {},
      notice: view.notice ?? null,
      aiError: view.aiError ?? null,
      translationErrors: view.translationErrors ?? {},
      translationRows: withNames(rows),
      canDraft: Boolean(drafts),
      accents: ACCENT_OPTIONS,
      shopSlug: req.store.slug,
      defaultLanguageName: LANGUAGE_NAMES_ENGLISH[req.store.defaultLanguage],
      defaultTagline: req.store.tagline,
      defaultStory: req.store.story,
      defaultLanguage: req.store.defaultLanguage,
    });
  }

  function settingsFailure(req, res, error) {
    if (!(error instanceof ZodError)) throw error;
    const values = {
      ...echoValues(req.body, TEXT_FIELDS, MAX_ECHO_LENGTH),
      ...echoValues(req.body, STORY_FIELDS, MAX_STORY_ECHO_LENGTH),
      ...contactValuesFromBody(req.body),
    };
    values.accentKey ??= DEFAULT_ACCENT_KEY;
    return page(req, res, HTTP_BAD_REQUEST, { values, errors: fieldErrors(error, SETTINGS_MESSAGES) });
  }

  async function translationFailure(req, res, error) {
    if (!(error instanceof ZodError)) throw error;
    fieldErrors(error, {});
    const echoed = echoValues(req.body, TRANSLATION_FIELDS, MAX_STORY_ECHO_LENGTH);
    const rows = (await translations.listForOwner(req.store)).map((row) =>
      row.language === echoed.language ? { ...row, tagline: echoed.tagline ?? '', story: echoed.story ?? '' } : row,
    );
    return page(req, res, HTTP_BAD_REQUEST, { rows, translationErrors: { [echoed.language]: TRANSLATION_MESSAGE } });
  }

  return {
    show(req, res) {
      return page(req, res, HTTP_OK, { notice: noticeFor(req.query) });
    },

    async save(req, res) {
      try {
        await stores.updateSettings(req.owner.id, req.body ?? {});
      } catch (error) {
        return settingsFailure(req, res, error);
      }
      return res.redirect(SEE_OTHER, `${SETTINGS_PATH}?saved=1`);
    },

    async saveTranslation(req, res) {
      try {
        await translations.save(req.store, req.body ?? {});
      } catch (error) {
        return translationFailure(req, res, error);
      }
      return res.redirect(SEE_OTHER, `${SETTINGS_PATH}?saved=translation`);
    },

    async draftTranslations(req, res) {
      let outcome;
      try {
        outcome = await drafts.draft({ store: req.store, owner: req.owner, correlationId: req.correlationId });
      } catch (error) {
        if (!(error instanceof AppError)) throw error;
        return page(req, res, error.httpStatus, { aiError: error.message });
      }
      const saved = outcome.languages.length > 0 ? 'drafts' : 'skipped';
      const skipped = outcome.skipped.length > 0 ? `&skipped=${outcome.skipped.join(',')}` : '';
      return res.redirect(SEE_OTHER, `${SETTINGS_PATH}?saved=${saved}${skipped}`);
    },
  };
}
