import { ENQUIRY_STATUS, inboxFilter, replySchema } from '../domain/enquiryRules.js';
import { absoluteUrl } from '../domain/seo.js';
import { buildWhatsappLink } from '../domain/whatsapp.js';
import { notFound } from '../lib/errors.js';
import { isProductId } from './publicShopService.js';
import { formatExpiry } from './orderService.js';

const QUESTION_PREVIEW_LENGTH = 110;

/** What the seller sees for each status: text, never colour alone. */
export const STATUS_LABELS = Object.freeze({
  pending: 'Waiting for the assistant',
  answering: 'Assistant is answering',
  answered: 'Answered',
  needs_you: 'Needs you',
  handled: 'Handled',
});

const FLAG_LABELS = Object.freeze({
  not_in_document: 'The answer was not in your notes, so the assistant passed it to you.',
  budget: 'The daily AI limit was reached, so the question came straight to you.',
  error: 'The assistant had a problem, so the question came to you.',
  too_complex: 'The question needed too many steps for the assistant.',
  unverified_amount: 'The assistant tried to state a price on its own, so its answer was blocked.',
  daily_cap: "Your shop's daily limit for assistant answers was reached.",
});

const clip = (text, max) => (Array.from(text).length > max ? `${Array.from(text).slice(0, max).join('')}...` : text);
const displayPhone = (digits) => `+${digits}`;

function rowView(enquiry) {
  return {
    id: enquiry.id,
    customerName: enquiry.customerName,
    preview: clip(enquiry.question, QUESTION_PREVIEW_LENGTH),
    status: enquiry.status,
    statusLabel: STATUS_LABELS[enquiry.status],
    createdAt: formatExpiry(enquiry.createdAt, 'en'),
  };
}

/**
 * The seller's enquiries inbox. Every lookup is scoped to the store of the session (passed in by the controller from `req.store`).
 * The enquiry id in the URL is only ever looked up inside that store. Replying saves the text and marks the enquiry handled; the
 * "Open WhatsApp" link carries the reply plus the customer's private link (decrypted from the stored ciphertext).
 * @param {{ enquiries: ReturnType<import('../repositories/enquiryRepository.js').createEnquiryRepository>,
 *   logger: { info: Function, warn: Function }, linkCipher?: { decrypt: (value: string) => string | null } | null, baseUrl: string,
 *   now?: () => number }} deps
 */
export function createEnquiryInboxService({ enquiries, logger, linkCipher = null, baseUrl, now = Date.now }) {
  const nowIso = () => new Date(now()).toISOString();

  function privateLink(store, enquiry) {
    const token = enquiry.tokenEnc && linkCipher ? linkCipher.decrypt(enquiry.tokenEnc) : null;
    return token ? absoluteUrl(baseUrl, `/s/${store.slug}/q/${token}`) : null;
  }

  function whatsappUrl(store, enquiry) {
    if (!enquiry.sellerReply) return null;
    const link = privateLink(store, enquiry);
    return buildWhatsappLink(enquiry.customerPhone, link ? `${enquiry.sellerReply}\n\n${link}` : enquiry.sellerReply);
  }

  function detailView(store, enquiry) {
    return {
      id: enquiry.id,
      status: enquiry.status,
      statusLabel: STATUS_LABELS[enquiry.status],
      customerName: enquiry.customerName,
      customerPhone: displayPhone(enquiry.customerPhone),
      question: enquiry.question,
      language: enquiry.language,
      createdAt: formatExpiry(enquiry.createdAt, 'en'),
      answerText: enquiry.answerText,
      flagText: enquiry.flagReason ? FLAG_LABELS[enquiry.flagReason] : null,
      trace: enquiry.trace,
      sellerReply: enquiry.sellerReply,
      repliedAt: enquiry.repliedAt ? formatExpiry(enquiry.repliedAt, 'en') : null,
      canReply: [ENQUIRY_STATUS.ANSWERED, ENQUIRY_STATUS.NEEDS_YOU, ENQUIRY_STATUS.HANDLED].includes(enquiry.status),
      canMarkHandled: [ENQUIRY_STATUS.ANSWERED, ENQUIRY_STATUS.NEEDS_YOU].includes(enquiry.status),
      whatsappUrl: whatsappUrl(store, enquiry),
      hasPrivateLink: privateLink(store, enquiry) !== null,
    };
  }

  return {
    /** @param {{ id: string }} store From the session. @param {string | null} status Optional filter. */
    async list(store, status) {
      const filter = inboxFilter(status);
      const rows = await enquiries.listForOwner(store.id, { status: filter });
      return { filter, rows: rows.map(rowView) };
    },

    /** @returns {Promise<object | null>} null when the enquiry is not in this store. */
    async get(store, id) {
      if (!isProductId(id)) return null;
      const enquiry = await enquiries.findForOwner(store.id, id);
      return enquiry ? detailView(store, enquiry) : null;
    },

    /** Saves the reply and marks the enquiry handled. @throws {import('zod').ZodError} @throws {AppError} 404 when missing or still being answered. */
    async reply(store, id, body) {
      const { reply } = replySchema.parse(body ?? {});
      if (!isProductId(id) || !(await enquiries.saveReply(store.id, id, reply, nowIso()))) throw notFound('Enquiry not found');
      logger.info('enquiry replied', { storeId: store.id, enquiryId: id });
    },

    /** @throws {AppError} 404 when the enquiry is not in this store or is not waiting for the seller. */
    async markHandled(store, id) {
      if (!isProductId(id) || !(await enquiries.markHandled(store.id, id, nowIso()))) throw notFound('Enquiry not found');
      logger.info('enquiry handled', { storeId: store.id, enquiryId: id });
    },

    /** @returns {Promise<number>} Enquiries waiting for the seller (the dashboard counter). */
    needsYouCount: (storeId) => enquiries.countByStatus(storeId, ENQUIRY_STATUS.NEEDS_YOU),
  };
}
