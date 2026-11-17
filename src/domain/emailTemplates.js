/*
 * Plain-text email templates (pure: no I/O). Customer emails exist in English (en), Gujarati (gu) and Hindi (hi).
 * NOTE: the Gujarati and Hindi wording was written by an AI assistant and has NOT been proofread by a native speaker.
 * It must be reviewed by a human before real customers receive it.
 *
 * Privacy rule: a customer email carries only the shop name, order number, status, a deadline (in minutes, taken from the order
 * constants) and a link. Never an amount, address, phone number, UPI ID or payment reference.
 */
import { ORDER_EXPIRY_MINUTES, ORDER_RESUBMIT_MINUTES } from './orderRules.js';
import { EMAIL_KINDS, MAX_BODY_LENGTH, MAX_SUBJECT_LENGTH } from './emailRules.js';
import { shopPath } from './seo.js';

/** When false every subject is written in English (a fallback if a mail client mangles non-ASCII subjects). */
export const LOCALIZE_SUBJECTS = true;
export const OWNER_ORDERS_PATH = '/orders';
export const OWNER_DASHBOARD_PATH = '/dashboard';

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f\u2028\u2029]/g;
const LINE_BREAKS = /[\r\n]+/g;
const PLACEHOLDER = /\{(\w+)\}/g;
const SUBJECT_ELLIPSIS = '…';
const LANGUAGES = Object.freeze(['en', 'gu', 'hi']);

/** Words shared by every customer email of a language. */
const COMMON = Object.freeze({
  en: {
    greeting: 'Thank you for shopping with {shop}.',
    orderNumber: 'Order number: {ref}',
    status: 'Status: {status}',
    privateLink: 'Your private order link: {url}',
    earlierLink: 'Use the private order link from your first email to see this order.',
    shopLink: 'Shop: {url}',
    ignore: 'If you did not place this order, ignore this email.',
  },
  gu: {
    greeting: '{shop} પાસેથી ખરીદી કરવા બદલ આભાર.',
    orderNumber: 'ઓર્ડર નંબર: {ref}',
    status: 'સ્થિતિ: {status}',
    privateLink: 'તમારી ખાનગી ઓર્ડર લિંક: {url}',
    earlierLink: 'આ ઓર્ડર જોવા પહેલા ઇમેઇલમાં આપેલી ખાનગી ઓર્ડર લિંક વાપરો.',
    shopLink: 'દુકાન: {url}',
    ignore: 'જો તમે આ ઓર્ડર આપ્યો ન હોય, તો આ ઇમેઇલને અવગણો.',
  },
  hi: {
    greeting: '{shop} से खरीदारी करने के लिए धन्यवाद।',
    orderNumber: 'ऑर्डर नंबर: {ref}',
    status: 'स्थिति: {status}',
    privateLink: 'आपका निजी ऑर्डर लिंक: {url}',
    earlierLink: 'इस ऑर्डर को देखने के लिए पहले ईमेल में दिया गया निजी ऑर्डर लिंक इस्तेमाल करें।',
    shopLink: 'दुकान: {url}',
    ignore: 'अगर आपने यह ऑर्डर नहीं किया है, तो इस ईमेल को अनदेखा करें।',
  },
});

/** Per kind and language: subject, status label and the sentence that explains it. {minutes} comes from the order constants. */
const CUSTOMER_COPY = Object.freeze({
  [EMAIL_KINDS.ORDER_PLACED]: {
    en: { subject: 'Order {ref} placed: {shop}', status: 'Waiting for your payment', note: 'Your items are reserved for {minutes} minutes. Pay and enter your payment reference within this time.' },
    gu: { subject: 'ઓર્ડર {ref} મળ્યો: {shop}', status: 'ચુકવણીની રાહ', note: 'તમારી વસ્તુઓ {minutes} મિનિટ માટે અનામત રાખી છે. આ સમયમાં ચુકવણી કરો અને ચુકવણી સંદર્ભ દાખલ કરો.' },
    hi: { subject: 'ऑर्डर {ref} मिल गया: {shop}', status: 'भुगतान की प्रतीक्षा', note: 'आपका सामान {minutes} मिनट के लिए सुरक्षित रखा गया है। इस समय के भीतर भुगतान करें और भुगतान संदर्भ दर्ज करें।' },
  },
  [EMAIL_KINDS.ORDER_PAYMENT_RECEIVED]: {
    en: { subject: 'Payment reference received for order {ref}', status: 'Waiting for the seller to confirm', note: 'We received your payment reference. The seller will check their bank account and confirm your order.' },
    gu: { subject: 'ઓર્ડર {ref} માટે ચુકવણી સંદર્ભ મળ્યો', status: 'વેચનારની પુષ્ટિની રાહ', note: 'અમને તમારો ચુકવણી સંદર્ભ મળ્યો છે. વેચનાર પોતાનું બેંક ખાતું તપાસીને ઓર્ડરની પુષ્ટિ કરશે.' },
    hi: { subject: 'ऑर्डर {ref} के लिए भुगतान संदर्भ मिला', status: 'विक्रेता की पुष्टि की प्रतीक्षा', note: 'हमें आपका भुगतान संदर्भ मिल गया है। विक्रेता अपना बैंक खाता जाँचकर आपके ऑर्डर की पुष्टि करेगा।' },
  },
  [EMAIL_KINDS.ORDER_CONFIRMED]: {
    en: { subject: 'Order {ref} confirmed: {shop}', status: 'Confirmed', note: 'The seller has confirmed your payment. Open your private order link for the details.' },
    gu: { subject: 'ઓર્ડર {ref} ની પુષ્ટિ થઈ: {shop}', status: 'પુષ્ટિ થઈ', note: 'વેચનારે તમારી ચુકવણીની પુષ્ટિ કરી છે. વિગતો માટે તમારી ખાનગી ઓર્ડર લિંક ખોલો.' },
    hi: { subject: 'ऑर्डर {ref} की पुष्टि हो गई: {shop}', status: 'पुष्टि हो गई', note: 'विक्रेता ने आपके भुगतान की पुष्टि कर दी है। विवरण के लिए अपना निजी ऑर्डर लिंक खोलें।' },
  },
  [EMAIL_KINDS.ORDER_PAYMENT_NOT_FOUND]: {
    en: { subject: 'Payment not found for order {ref}', status: 'Payment not found', note: 'The seller could not find your payment. You can send the correct payment reference again within {minutes} minutes.' },
    gu: { subject: 'ઓર્ડર {ref} માટે ચુકવણી મળી નથી', status: 'ચુકવણી મળી નથી', note: 'વેચનારને તમારી ચુકવણી મળી નથી. તમે {minutes} મિનિટની અંદર સાચો ચુકવણી સંદર્ભ ફરી મોકલી શકો છો.' },
    hi: { subject: 'ऑर्डर {ref} के लिए भुगतान नहीं मिला', status: 'भुगतान नहीं मिला', note: 'विक्रेता को आपका भुगतान नहीं मिला। आप {minutes} मिनट के भीतर सही भुगतान संदर्भ दोबारा भेज सकते हैं।' },
  },
  [EMAIL_KINDS.ORDER_CANCELLED]: {
    en: { subject: 'Order {ref} cancelled: {shop}', status: 'Cancelled', note: 'This order has been cancelled and the items are available again.' },
    gu: { subject: 'ઓર્ડર {ref} રદ થયો: {shop}', status: 'રદ', note: 'આ ઓર્ડર રદ કરવામાં આવ્યો છે અને વસ્તુઓ ફરી ઉપલબ્ધ થઈ છે.' },
    hi: { subject: 'ऑर्डर {ref} रद्द हुआ: {shop}', status: 'रद्द', note: 'यह ऑर्डर रद्द कर दिया गया है और सामान फिर से उपलब्ध है।' },
  },
  [EMAIL_KINDS.ORDER_EXPIRED]: {
    en: { subject: 'Order {ref} expired: {shop}', status: 'Expired', note: 'The payment was not received in time, so the order was cancelled and the items were released. You can place a new order in the shop.' },
    gu: { subject: 'ઓર્ડર {ref} નો સમય પૂરો: {shop}', status: 'સમય પૂરો', note: 'સમયસર ચુકવણી મળી નથી, તેથી ઓર્ડર રદ થયો અને વસ્તુઓ મુક્ત કરવામાં આવી. તમે દુકાનમાં નવો ઓર્ડર આપી શકો છો.' },
    hi: { subject: 'ऑर्डर {ref} की समय-सीमा समाप्त: {shop}', status: 'समय समाप्त', note: 'समय पर भुगतान नहीं मिला, इसलिए ऑर्डर रद्द हो गया और सामान छोड़ दिया गया। आप दुकान में नया ऑर्डर कर सकते हैं।' },
  },
});

/** Minutes quoted in each customer email, from the order constants (never typed here). */
const MINUTES_BY_KIND = Object.freeze({
  [EMAIL_KINDS.ORDER_PLACED]: ORDER_EXPIRY_MINUTES,
  [EMAIL_KINDS.ORDER_PAYMENT_NOT_FOUND]: ORDER_RESUBMIT_MINUTES,
});
/** The first emails of an order: without a link they have no earlier email to point back to. */
const FIRST_EMAIL_KINDS = new Set([EMAIL_KINDS.ORDER_PLACED, EMAIL_KINDS.ORDER_PAYMENT_RECEIVED]);

/** @param {unknown} value @returns {string} One line: control characters and line breaks removed, trimmed. */
export function oneLine(value) {
  return String(value ?? '').replace(LINE_BREAKS, ' ').replace(CONTROL_CHARACTERS, '').trim();
}

function fill(template, values) {
  return template.replace(PLACEHOLDER, (whole, key) => (key in values ? values[key] : whole));
}

function clip(text, limit, suffix = '') {
  const characters = [...text];
  return characters.length <= limit ? text : `${characters.slice(0, limit - suffix.length).join('')}${suffix}`;
}

/** @param {string} subject @returns {string} A single line no longer than the column limit. */
export function safeSubject(subject) {
  return clip(oneLine(subject), MAX_SUBJECT_LENGTH, SUBJECT_ELLIPSIS);
}

const safeBody = (text) => clip(text, MAX_BODY_LENGTH, SUBJECT_ELLIPSIS);

function customerLines({ kind, language, facts, baseUrl }) {
  const copy = CUSTOMER_COPY[kind][language];
  const common = COMMON[language];
  const values = { shop: oneLine(facts.shop), ref: oneLine(facts.reference), minutes: String(MINUTES_BY_KIND[kind] ?? ''), status: copy.status };
  const privateUrl = facts.link ? oneLine(facts.link) : null;
  const shopUrl = new URL(shopPath(facts.slug), baseUrl).toString();
  const lines = [fill(common.greeting, values), '', fill(common.orderNumber, values), fill(common.status, values), '', fill(copy.note, values), ''];
  if (privateUrl) lines.push(fill(common.privateLink, { url: privateUrl }));
  else if (!FIRST_EMAIL_KINDS.has(kind)) lines.push(common.earlierLink);
  lines.push(fill(common.shopLink, { url: shopUrl }), '', common.ignore);
  return { subject: fill(copy.subject, values), lines };
}

function sellerCopy(kind, facts, baseUrl) {
  const shop = oneLine(facts.shop);
  if (kind === EMAIL_KINDS.SELLER_PAYMENT_SUBMITTED) {
    const ref = oneLine(facts.reference);
    return {
      subject: `Check your bank app: payment reference for order ${ref}`,
      lines: [
        `A customer sent a payment reference for order ${ref} in ${shop}.`,
        'Please check your bank app to see whether the money has arrived, then mark the order as paid or not received.',
        '',
        `Your orders: ${new URL(OWNER_ORDERS_PATH, baseUrl).toString()}`,
      ],
    };
  }
  return {
    subject: `A customer enquiry needs you: ${shop}`,
    lines: [`A customer enquiry in ${shop} needs your reply.`, '', `Your dashboard: ${new URL(OWNER_DASHBOARD_PATH, baseUrl).toString()}`],
  };
}

/**
 * Renders one email for an order event or a seller alert.
 * @param {{ kind: string, language: string, facts: { reference?: string, shop: string, slug?: string, link?: string | null }, baseUrl: string }} input
 *   Customer kinds use the language (falling back to English); seller kinds are always English.
 * @returns {{ subject: string, text: string }}
 * @throws {Error} for an unknown kind.
 */
export function renderEmail({ kind, language, facts, baseUrl }) {
  const isCustomer = Object.hasOwn(CUSTOMER_COPY, kind);
  const isSeller = kind === EMAIL_KINDS.SELLER_PAYMENT_SUBMITTED || kind === EMAIL_KINDS.SELLER_ENQUIRY_NEEDS_YOU;
  if (!isCustomer && !isSeller) throw new Error('Unknown email kind');
  const lang = LANGUAGES.includes(language) ? language : 'en';
  const { subject, lines } = isCustomer ? customerLines({ kind, language: lang, facts, baseUrl }) : sellerCopy(kind, facts, baseUrl);
  const englishFallback = isCustomer && !LOCALIZE_SUBJECTS && lang !== 'en';
  const finalSubject = englishFallback ? customerLines({ kind, language: 'en', facts, baseUrl }).subject : subject;
  return { subject: safeSubject(finalSubject), text: safeBody(lines.join('\n')) };
}

/**
 * The contact-form email to our own inbox. Name and address are single-line (CR and LF removed); the message keeps its lines.
 * @param {{ name: string, email: string, message: string }} contact
 * @returns {{ subject: string, text: string }}
 */
export function renderContactInbox({ name, email, message }) {
  const cleanName = oneLine(name);
  const lines = [`Name: ${cleanName}`, `Email: ${oneLine(email)}`, '', String(message).replace(/\r\n?/g, '\n')];
  return { subject: safeSubject(`Contact form: ${cleanName}`), text: safeBody(lines.join('\n')) };
}
