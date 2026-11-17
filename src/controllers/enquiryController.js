import { ZodError } from 'zod';
import { INBOX_FILTERS, MAX_REPLY_LENGTH } from '../domain/enquiryRules.js';
import { echoValues, fieldErrors } from './formErrors.js';
import { STATUS_LABELS } from '../services/enquiryInboxService.js';

const SEE_OTHER = 303;
const HTTP_BAD_REQUEST = 400;
const HTTP_NOT_FOUND = 404;
const RAW_FIELD_FACTOR = 4;
const DONE_NOTICES = Object.freeze({ reply: 'Your reply was saved and the enquiry is marked as handled. Open WhatsApp below to send it.', handled: 'Marked as handled.' });
const REPLY_ERROR = `Write a reply of 1 to ${MAX_REPLY_LENGTH} characters.`;

/**
 * Owner enquiries inbox. The store always comes from the session (`req.store`, set by loadStore); an enquiry id from the URL is only
 * ever looked up inside that store, and the strict reply schema rejects a store id in the body. State changes are POST, redirect, GET.
 * @param {{ enquiries: ReturnType<import('../services/enquiryInboxService.js').createEnquiryInboxService> }} deps
 */
export function createEnquiryController({ enquiries }) {
  const detailPath = (id, query = '') => `/enquiries/${id}${query}`;
  const notFound = (req, res) =>
    res.status(HTTP_NOT_FOUND).render('error', { title: 'Page not found', status: HTTP_NOT_FOUND, message: 'Enquiry not found', correlationId: req.correlationId });

  async function detailPage(req, res, status, { replyValue = null, replyError = null } = {}) {
    const enquiry = await enquiries.get(req.store, req.params.id);
    if (!enquiry) return notFound(req, res);
    return res.status(status).render('enquiry-detail', {
      title: 'Enquiry', wide: true, enquiry, done: DONE_NOTICES[req.query?.done] ?? null, replyValue: replyValue ?? '', replyError, maxReply: MAX_REPLY_LENGTH,
    });
  }

  return {
    async list(req, res) {
      const requested = typeof req.query?.status === 'string' ? req.query.status : null;
      const { filter, rows } = await enquiries.list(req.store, requested);
      const filters = [
        { label: 'All', href: '/enquiries', current: filter === null },
        ...INBOX_FILTERS.map((value) => ({ label: STATUS_LABELS[value], href: `/enquiries?status=${value}`, current: filter === value })),
      ];
      return res.render('enquiries', { title: 'Enquiries', wide: true, rows, filter, filters });
    },

    detail(req, res) {
      return detailPage(req, res, 200);
    },

    async reply(req, res) {
      try {
        await enquiries.reply(req.store, req.params.id, req.body);
      } catch (error) {
        if (error?.httpStatus === HTTP_NOT_FOUND) return notFound(req, res);
        if (!(error instanceof ZodError)) throw error;
        fieldErrors(error, {});
        const replyValue = echoValues(req.body, ['reply'], MAX_REPLY_LENGTH * RAW_FIELD_FACTOR).reply ?? '';
        return detailPage(req, res, HTTP_BAD_REQUEST, { replyValue, replyError: REPLY_ERROR });
      }
      return res.redirect(SEE_OTHER, detailPath(req.params.id, '?done=reply'));
    },

    async markHandled(req, res) {
      try {
        await enquiries.markHandled(req.store, req.params.id);
      } catch (error) {
        if (error?.httpStatus === HTTP_NOT_FOUND) return notFound(req, res);
        throw error;
      }
      return res.redirect(SEE_OTHER, detailPath(req.params.id, '?done=handled'));
    },
  };
}
