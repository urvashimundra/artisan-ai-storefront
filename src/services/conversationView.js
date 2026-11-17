import { MAX_MESSAGE_LENGTH, MAX_NAME_LENGTH, POLL_INTERVAL_MS, isAiRunning } from '../domain/conversationRules.js';
import { TRANSLATION_REVIEW } from '../domain/conversationStrings.js';
import { LANGUAGE_NAMES } from '../domain/language.js';
import { themeClass } from '../domain/palette.js';
import { fillTemplate, stringsFor } from '../domain/publicStrings.js';
import { absoluteUrl, shopPath, withLang } from '../domain/seo.js';
import { LANGUAGES } from '../domain/storeRules.js';
import { buildWhatsappLink } from '../domain/whatsapp.js';

const INDIA_TIME_ZONE = 'Asia/Kolkata';
const LOCALES = Object.freeze({ en: 'en-IN', gu: 'gu-IN', hi: 'hi-IN' });
const SOURCE_STRING_KEYS = Object.freeze({
  seller_notes: 'chatSourceNotes', product_description: 'chatSourceProduct', shop_profile: 'chatSourceProfile', live_catalog: 'chatSourceCatalog',
});
const STATUS_STRING_KEYS = Object.freeze({ open: 'chatStatusOpen', needs_you: 'chatStatusNeedsYou', handled: 'chatStatusHandled' });
const SPEAKER_KEYS = Object.freeze({ customer: 'chatYou', assistant: 'chatAssistant', seller: 'chatSeller' });
const MS_PER_DAY = 86_400_000;

/**
 * "10:42 am" for today, "16 Nov, 10:42 am" for earlier days, in India time and the page language. Computed on the server so the chat shows
 * the same time on every device.
 * @param {string} isoTime @param {string} language @param {number} nowMs @returns {string}
 */
export function formatMessageTime(isoTime, language, nowMs) {
  const when = Date.parse(isoTime);
  const options = { timeZone: INDIA_TIME_ZONE, hour: 'numeric', minute: '2-digit' };
  const sameDay = Math.floor((when + 19_800_000) / MS_PER_DAY) === Math.floor((nowMs + 19_800_000) / MS_PER_DAY);
  const withDay = sameDay ? options : { ...options, day: 'numeric', month: 'short' };
  return new Intl.DateTimeFormat(LOCALES[language] ?? LOCALES.en, withDay).format(new Date(when));
}

/**
 * One message as the page and the polling endpoint show it. Only the fixed fields: no conflict values, no trace, no ids but the message id.
 * The text is plain (EJS and the page script both escape it).
 */
export function buildMessageView(message, { strings, language, nowMs }) {
  const labels = [...new Set((message.sources ?? []).map((source) => SOURCE_STRING_KEYS[source.label]).filter(Boolean))].map((key) => strings[key]);
  return {
    id: message.id, seq: message.seq, role: message.role, kind: message.kind, text: message.body, speaker: strings[SPEAKER_KEYS[message.role]],
    time: message.createdAt, timeLabel: formatMessageTime(message.createdAt, language, nowMs), sources: labels,
    escalated: message.kind === 'escalation' || message.kind === 'conflict' || message.kind === 'notice',
  };
}

const languageLinks = (path, current) => LANGUAGES.map((lang) => ({ lang, name: LANGUAGE_NAMES[lang], href: `${path}?lang=${lang}`, current: lang === current }));

function pageBase({ shop, language, title }) {
  const strings = stringsFor(language);
  return {
    language,
    strings,
    themeClass: themeClass(shop.accentKey),
    shop: { name: shop.name, lang: shop.defaultLanguage },
    shopHref: withLang(shopPath(shop.slug), language, shop.defaultLanguage),
    reviewPending: TRANSLATION_REVIEW[language] !== 'approved',
    meta: { title: fillTemplate(strings.chatPageTitle, { shop: title ?? shop.name }), robots: 'noindex, nofollow' },
  };
}

/**
 * The start screen: name, WhatsApp number and the first message, once per conversation. `keys` are the idempotency keys the form carries so a
 * retry after a failed request saves nothing twice.
 * @param {{ shop: object, language: string, productId: string | null, keys: { startKey: string, messageId: string },
 *   values?: object, errors?: object, formError?: string | null }} input
 */
export function buildStartView({ shop, language, productId, keys, values = {}, errors = {}, formError = null }) {
  const path = `/s/${shop.slug}/chat`;
  return {
    ...pageBase({ shop, language }),
    kind: 'chat-start',
    languageLinks: languageLinks(path, language),
    start: { action: `${path}?lang=${language}`, productId, keys, values, errors, formError, maxMessage: MAX_MESSAGE_LENGTH, maxName: MAX_NAME_LENGTH },
  };
}

function sellerWhatsapp(shop, strings, link) {
  if (!shop.whatsappEnabled || !shop.whatsappNumber) return null;
  return buildWhatsappLink(shop.whatsappNumber, fillTemplate(strings.chatWhatsappMessage, { shop: shop.name, url: link }));
}

/**
 * The private chat page: the whole history in order, the composer, and the state banners. `messageId` is a fresh idempotency key for the next
 * message. The private link is shown so the customer can keep it; it is the only place the token appears.
 * @param {{ shop: object, conversation: object, messages: object[], language: string, token: string, baseUrl: string, messageId: string, nowMs: number }} input
 */
export function buildChatView({ shop, conversation, messages, language, token, baseUrl, messageId, nowMs }) {
  const strings = stringsFor(language);
  const path = `/s/${shop.slug}/c/${token}`;
  const link = absoluteUrl(baseUrl, path);
  const needsSeller = conversation.status === 'needs_you';
  const views = messages.map((message) => buildMessageView(message, { strings, language, nowMs }));
  return {
    ...pageBase({ shop, language }),
    kind: 'chat',
    languageLinks: languageLinks(path, language),
    conversation: {
      status: conversation.status, statusLabel: strings[STATUS_STRING_KEYS[conversation.status]], aiRunning: isAiRunning(conversation), needsSeller, link,
    },
    messages: views,
    lastSeq: messages.at(-1)?.seq ?? 0,
    composer: { messageId, maxMessage: MAX_MESSAGE_LENGTH, action: `${path}/messages?lang=${language}` },
    paths: { self: `${path}?lang=${language}`, poll: `${path}/messages` },
    pollMs: POLL_INTERVAL_MS,
    whatsappUrl: needsSeller ? sellerWhatsapp(shop, strings, link) : null,
  };
}

/** The polling endpoint's body: new messages after a sequence number plus the live state. Same message shape as the page. */
export function buildPollView({ conversation, messages, language, nowMs }) {
  const strings = stringsFor(language);
  return {
    messages: messages.map((message) => buildMessageView(message, { strings, language, nowMs })),
    aiRunning: isAiRunning(conversation),
    status: conversation.status,
    statusLabel: strings[STATUS_STRING_KEYS[conversation.status]],
    needsSeller: conversation.status === 'needs_you',
  };
}
