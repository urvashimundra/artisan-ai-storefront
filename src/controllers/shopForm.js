import { ACCENT_KEYS } from '../domain/palette.js';
import { echoValues } from './formErrors.js';

const MAX_ECHO_LENGTH = 200;
const ACCENT_LABELS = Object.freeze({
  terracotta: 'Terracotta',
  indigo: 'Indigo',
  forest: 'Forest green',
  plum: 'Plum',
  teal: 'Teal',
  saffron: 'Saffron',
});

/** Shop colour choices for the creation and settings forms. */
export const ACCENT_OPTIONS = Object.freeze(ACCENT_KEYS.map((key) => Object.freeze({ key, label: ACCENT_LABELS[key] })));

export const TAGLINE_MESSAGE = 'Enter a tagline of up to 120 characters.';
export const ACCENT_MESSAGE = 'Choose one of the listed colours.';

/** Field messages shared by onboarding step 2 and Shop settings (one source, so the two forms never disagree). */
export const CONTACT_MESSAGES = Object.freeze({
  whatsappNumber: 'Enter a phone number such as 98765 43210 or +91 98765 43210. To use the WhatsApp button, a number is required.',
  instagramHandle: 'Enter 1 to 30 letters, numbers, dots or underscores. A leading @ is fine.',
  upiId: 'Enter a UPI ID like name@bank, without spaces.',
});

export const CONTACT_TEXT_FIELDS = ['whatsappNumber', 'instagramHandle', 'upiId'];

/** Contact form values from a stored shop. */
export const contactValuesFromStore = (store) => ({
  notifyEnquiryEmail: store.notifyEnquiryEmail,
  whatsappNumber: store.whatsappNumber ?? '',
  whatsappEnabled: store.whatsappEnabled,
  instagramHandle: store.instagramHandle ?? '',
  upiId: store.upiId ?? '',
});

/** Contact form values echoed back from a rejected submission. */
export const contactValuesFromBody = (body) => ({
  ...echoValues(body, CONTACT_TEXT_FIELDS, MAX_ECHO_LENGTH),
  whatsappEnabled: body?.whatsappEnabled === 'on',
  notifyEnquiryEmail: body?.notifyEnquiryEmail === 'on',
});
