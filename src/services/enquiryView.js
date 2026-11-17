import { LANGUAGE_NAMES } from '../domain/language.js';
import { ENQUIRY_STATUS, MAX_QUESTION_LENGTH } from '../domain/enquiryRules.js';
import { themeClass } from '../domain/palette.js';
import { fillTemplate, stringsFor } from '../domain/publicStrings.js';
import { absoluteUrl, shopPath, withLang } from '../domain/seo.js';
import { LANGUAGES } from '../domain/storeRules.js';
import { buildWhatsappLink } from '../domain/whatsapp.js';

const STATUS_STRING_KEYS = Object.freeze({
  pending: 'enquiryStatusPending',
  answering: 'enquiryStatusAnswering',
  answered: 'enquiryStatusAnswered',
  needs_you: 'enquiryStatusNeedsYou',
  handled: 'enquiryStatusHandled',
});

/**
 * The customer's ask form model, for the shop page, the product page and the error re-render. The action carries only the shop slug
 * and the language; the shop is resolved from the slug on the server and the product id (if any) is checked there.
 * @param {{ slug: string, language: string, productId?: string | null, values?: object, errors?: object, formError?: string | null }} input
 */
export function buildAskForm({ slug, language, productId = null, values = {}, errors = {}, formError = null }) {
  return { action: `/s/${slug}/ask?lang=${language}`, productId, values, errors, formError, maxQuestion: MAX_QUESTION_LENGTH };
}

/** The "contact the seller" link: built here, only when the seller opted in and has a number. The number never reaches a view. */
function sellerWhatsappLink(shop, strings, privateUrl) {
  if (!shop.whatsappEnabled || !shop.whatsappNumber) return null;
  return buildWhatsappLink(shop.whatsappNumber, fillTemplate(strings.enquiryWhatsappMessage, { shop: shop.name, url: privateUrl }));
}

/**
 * Pure view model of the customer's private answer page. Shows the question, the labelled assistant answer, and the seller's reply.
 * It never contains a phone number, contact email or UPI ID, and the customer's name and number are not on it at all.
 * @param {{ shop: object, enquiry: object, language: string, token: string, baseUrl: string }} input
 * @returns {object}
 */
export function buildEnquiryView({ shop, enquiry, language, token, baseUrl }) {
  const strings = stringsFor(language);
  const path = `/s/${shop.slug}/q/${token}`;
  const link = absoluteUrl(baseUrl, path);
  const needsSeller = enquiry.status === ENQUIRY_STATUS.NEEDS_YOU;
  return {
    kind: 'enquiry',
    language,
    strings,
    autosubmit: enquiry.status === ENQUIRY_STATUS.PENDING,
    themeClass: themeClass(shop.accentKey),
    shop: { name: shop.name, lang: shop.defaultLanguage },
    shopHref: withLang(shopPath(shop.slug), language, shop.defaultLanguage),
    languageLinks: LANGUAGES.map((lang) => ({ lang, name: LANGUAGE_NAMES[lang], href: `${path}?lang=${lang}`, current: lang === language })),
    meta: { title: fillTemplate(strings.enquiryPageTitle, { shop: shop.name }), robots: 'noindex, nofollow' },
    enquiry: {
      status: enquiry.status,
      statusLabel: strings[STATUS_STRING_KEYS[enquiry.status]],
      question: enquiry.question,
      answerText: enquiry.answerText,
      sellerReply: enquiry.sellerReply,
      canRequestAnswer: enquiry.status === ENQUIRY_STATUS.PENDING,
      needsSeller,
      link,
    },
    paths: { self: `${path}?lang=${language}`, answer: `${path}/answer?lang=${language}` },
    whatsappUrl: needsSeller ? sellerWhatsappLink(shop, strings, link) : null,
  };
}

/** The shop-level page model for the ask form error page (kind "ask"): the same header and theme as the other public pages. */
export function buildAskPage({ shop, language, ask }) {
  const strings = stringsFor(language);
  const path = `/s/${shop.slug}`;
  return {
    kind: 'ask',
    language,
    strings,
    ask,
    themeClass: themeClass(shop.accentKey),
    shop: { name: shop.name, lang: shop.defaultLanguage },
    shopHref: withLang(path, language, shop.defaultLanguage),
    languageLinks: null,
    meta: { title: strings.askPageTitle, robots: 'noindex, nofollow' },
  };
}
