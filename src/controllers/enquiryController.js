import { ZodError } from 'zod';
import { INBOX_FILTERS, MAX_SELLER_MESSAGE_LENGTH } from '../domain/conversationRules.js';
import { MAX_REPLY_LENGTH } from '../domain/enquiryRules.js';
import { randomUUID } from 'node:crypto';
import { echoValues } from './formErrors.js';
import { STATE_LABELS } from '../services/conversationInboxService.js';

const SEE_OTHER = 303;
const HTTP_BAD_REQUEST = 400;
const HTTP_NOT_FOUND = 404;
const RAW_FIELD_FACTOR = 4;
const DONE_NOTICES = Object.freeze({
  reply: 'Your reply was added to the conversation and it is marked as handled. The customer sees it on their private link.',
  handled: 'Marked as handled.',
  deleted: 'The conversation and the customer details were deleted.',
});
const REPLY_ERROR = `Write a reply of 1 to ${MAX_SELLER_MESSAGE_LENGTH} characters.`;
const DELETE_ERROR = 'Tick the box to confirm that you want to delete this conversation.';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Owner Conversations inbox on the /enquiries URLs. The store always comes from the session (`req.store`, set by loadStore); an id from the URL
 * is only ever looked up inside that store, first as a conversation and then as a legacy enquiry. The strict reply schema rejects a store id in
 * the body. State changes are POST, redirect, GET.
 * @param {{ inbox?: ReturnType<import('../services/conversationInboxService.js').createConversationInboxService> | null,
 *   enquiries?: ReturnType<import('../services/enquiryInboxService.js').createEnquiryInboxService> | null }} deps
 */
export function createEnquiryController({ enquiries = null, inbox = null }) {
  const detailPath = (id, query = '') => `/enquiries/${id}${query}`;
  const notFound = (req, res) =>
    res.status(HTTP_NOT_FOUND).render('error', { title: 'Page not found', status: HTTP_NOT_FOUND, message: 'Conversation not found', correlationId: req.correlationId });
  const isConversation = (req) => (inbox ? inbox.has(req.store, req.params.id) : false);

  async function detailPage(req, res, status, { replyValue = null, replyError = null, deleteError = null } = {}) {
    const conversation = inbox ? await inbox.get(req.store, req.params.id) : null;
    if (conversation) {
      return res.status(status).render('conversation-detail', {
        title: 'Conversation', wide: true, conversation, done: DONE_NOTICES[req.query?.done] ?? null, replyValue: replyValue ?? '', replyError, deleteError,
        maxReply: MAX_SELLER_MESSAGE_LENGTH, replyId: randomUUID(),
      });
    }
    const legacy = enquiries ? await enquiries.get(req.store, req.params.id) : null;
    if (!legacy) return notFound(req, res);
    return res.status(status).render('enquiry-detail', {
      title: 'Enquiry', wide: true, enquiry: legacy, done: DONE_NOTICES[req.query?.done] ?? null, replyValue: replyValue ?? '', replyError, maxReply: MAX_REPLY_LENGTH, deleteError,
    });
  }

  const asConversationForm = (body) => ({ ...(body ?? {}), messageId: UUID.test(body?.messageId ?? '') ? body.messageId : undefined });

  return {
    async list(req, res) {
      const requested = typeof req.query?.status === 'string' ? req.query.status : null;
      const { filter, rows, earlier } = inbox ? await inbox.list(req.store, requested) : { filter: null, rows: [], earlier: (await enquiries.list(req.store, null)).rows };
      const filters = [
        { label: 'All', href: '/enquiries', current: filter === null },
        ...INBOX_FILTERS.map((value) => ({ label: STATE_LABELS[value], href: `/enquiries?status=${value}`, current: filter === value })),
      ];
      return res.render('conversations', { title: 'Conversations', wide: true, rows, earlier, filter, filters, done: DONE_NOTICES[req.query?.done] ?? null });
    },

    detail(req, res) {
      return detailPage(req, res, 200);
    },

    async reply(req, res) {
      const conversation = await isConversation(req);
      try {
        if (conversation) await inbox.reply(req.store, req.params.id, asConversationForm(req.body));
        else await enquiries.reply(req.store, req.params.id, req.body);
      } catch (error) {
        if (error?.httpStatus === HTTP_NOT_FOUND) return notFound(req, res);
        if (!(error instanceof ZodError)) throw error;
        const replyValue = echoValues(req.body, ['reply'], MAX_REPLY_LENGTH * RAW_FIELD_FACTOR).reply ?? '';
        return detailPage(req, res, HTTP_BAD_REQUEST, { replyValue, replyError: REPLY_ERROR });
      }
      return res.redirect(SEE_OTHER, detailPath(req.params.id, '?done=reply'));
    },

    async markHandled(req, res) {
      try {
        if (await isConversation(req)) await inbox.markHandled(req.store, req.params.id);
        else await enquiries.markHandled(req.store, req.params.id);
      } catch (error) {
        if (error?.httpStatus === HTTP_NOT_FOUND) return notFound(req, res);
        throw error;
      }
      return res.redirect(SEE_OTHER, detailPath(req.params.id, '?done=handled'));
    },

    /** Seller-initiated deletion of a conversation (or a legacy enquiry), with every customer detail. Needs confirm=yes. */
    async remove(req, res) {
      try {
        await inbox.remove(req.store, req.params.id, req.body);
      } catch (error) {
        if (error?.httpStatus === HTTP_NOT_FOUND) return notFound(req, res);
        if (!(error instanceof ZodError)) throw error;
        return detailPage(req, res, HTTP_BAD_REQUEST, { deleteError: DELETE_ERROR });
      }
      return res.redirect(SEE_OTHER, '/enquiries?done=deleted');
    },
  };
}
