import { ZodError } from 'zod';
import { ACCENT_KEYS, DEFAULT_ACCENT_KEY } from '../domain/palette.js';
import { echoValues, fieldErrors } from './formErrors.js';

const SEE_OTHER = 303;
const HTTP_OK = 200;
const HTTP_BAD_REQUEST = 400;
const SETTINGS_PATH = '/store/settings';
const TEXT_FIELDS = ['tagline', 'accentKey', 'whatsappNumber', 'instagramHandle', 'upiId'];
const MAX_ECHO_LENGTH = 200;
const ACCENT_LABELS = Object.freeze({
  terracotta: 'Terracotta',
  indigo: 'Indigo',
  forest: 'Forest green',
  plum: 'Plum',
  teal: 'Teal',
  saffron: 'Saffron',
});
const SETTINGS_MESSAGES = {
  tagline: 'Enter a tagline of up to 120 characters.',
  accentKey: 'Choose one of the listed colours.',
  whatsappNumber: 'Enter a phone number such as 98765 43210 or +91 98765 43210. To use the WhatsApp button, a number is required.',
  instagramHandle: 'Enter 1 to 30 letters, numbers, dots or underscores. A leading @ is fine.',
  upiId: 'Enter a UPI ID like name@bank, without spaces.',
};

const toFormValues = (store) => ({
  tagline: store.tagline,
  accentKey: store.accentKey,
  whatsappNumber: store.whatsappNumber ?? '',
  whatsappEnabled: store.whatsappEnabled,
  instagramHandle: store.instagramHandle ?? '',
  upiId: store.upiId ?? '',
});

/**
 * Owner shop-settings page. The store always comes from the session (`req.store`, set by loadStore); the owner id is
 * `req.owner.id`. A store id is never read from the request: the strict schema rejects one.
 * @param {{ stores: { updateSettings: (ownerId: string, input: unknown) => Promise<object> } }} deps
 */
export function createShopSettingsController({ stores }) {
  const page = (res, status, { values, errors = {}, saved = false }) =>
    res.status(status).render('shop-settings', {
      title: 'Shop settings',
      values,
      errors,
      saved,
      accents: ACCENT_KEYS.map((key) => ({ key, label: ACCENT_LABELS[key] })),
    });

  function failure(req, res, error) {
    if (!(error instanceof ZodError)) throw error;
    const values = { ...echoValues(req.body, TEXT_FIELDS, MAX_ECHO_LENGTH), whatsappEnabled: req.body?.whatsappEnabled === 'on' };
    values.accentKey ??= DEFAULT_ACCENT_KEY;
    return page(res, HTTP_BAD_REQUEST, { values, errors: fieldErrors(error, SETTINGS_MESSAGES) });
  }

  return {
    show(req, res) {
      return page(res, HTTP_OK, { values: toFormValues(req.store), saved: req.query?.saved === '1' });
    },

    async save(req, res) {
      try {
        await stores.updateSettings(req.owner.id, req.body ?? {});
      } catch (error) {
        return failure(req, res, error);
      }
      return res.redirect(SEE_OTHER, `${SETTINGS_PATH}?saved=1`);
    },
  };
}
