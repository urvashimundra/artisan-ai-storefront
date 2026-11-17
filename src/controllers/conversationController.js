import { ZodError } from 'zod';
import { LANGUAGE_COOKIE_NAME, isSupportedLanguage, resolveLanguage } from '../domain/language.js';
import { stringsFor } from '../domain/publicStrings.js';
import { AppError } from '../lib/errors.js';
import { parseCookies } from '../lib/cookies.js';
import { buildNoticePage } from '../services/publicShopService.js';
import { echoValues, fieldErrors } from './formErrors.js';

const SEE_OTHER = 303;
const HTTP_BAD_REQUEST = 400;
const HTTP_NOT_FOUND = 404;
const HTTP_INTERNAL_ERROR = 500;
const MAX_ECHO_LENGTH = 2000;
const START_FIELDS = ['name', 'phone', 'message'];
const FIELD_STRINGS = { name: 'chatErrName', phone: 'chatErrPhone', message: 'chatErrMessage', productId: 'chatErrRejected', startKey: 'chatErrRejected', messageId: 'chatErrRejected' };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Customer-facing string key for each application error code that means the message was NOT saved (or was refused). */
const ERROR_STRINGS = Object.freeze({
  CUSTOMER_LIMIT: 'chatErrCustomerLimit', CONVERSATION_BUSY: 'chatErrBusy', CONVERSATION_FULL: 'chatErrFull', PERSISTENCE_FAILED: 'chatErrNotSaved',
  CONVERSATION_ALREADY_STARTED: 'chatErrRejected',
});

const messagesFor = (strings) => Object.fromEntries(Object.entries(FIELD_STRINGS).map(([field, key]) => [field, strings[key]]));
const wantsJson = (req) => (req.get('accept') ?? '').includes('application/json');
const keepKey = (value) => (typeof value === 'string' && UUID.test(value) ? value : null);

/**
 * HTTP layer of the customer chat: the start screen and post, the private chat page, the polling endpoint and the message post. No session.
 * Pages and the polling endpoint never call Claude; only a message post that won the run claim does. Unknown, other-shop and malformed links
 * get the same generic 404. Nothing here logs a message, a name, a number or a token. Every failure that means "not saved" says so in plain
 * words, and a JSON caller always gets { saved: boolean }.
 * @param {{ conversations: ReturnType<import('../services/conversationService.js').createConversationService> }} deps
 */
export function createConversationController({ conversations }) {
  const preferences = (req) => ({
    query: req.query?.lang,
    cookie: parseCookies(req.get('cookie'))[LANGUAGE_COOKIE_NAME],
    acceptLanguage: req.get('accept-language'),
  });

  const languageOf = (req) => resolveLanguage({ ...preferences(req), shopDefault: 'en' }).language;

  function sendNotice(req, res, { status, template, titleKey, bodyKey }) {
    const language = languageOf(req);
    res.set('Content-Language', language);
    return res.status(status).render(template, buildNoticePage({ language, titleKey, bodyKey }));
  }

  const notFound = (req, res) => sendNotice(req, res, { status: HTTP_NOT_FOUND, template: 'public/not-found', titleKey: 'notFoundTitle', bodyKey: 'notFoundBody' });

  const sendPage = (res, template, page, status = 200) => {
    res.set('Content-Language', page.language);
    return res.status(status).render(template, page.view);
  };

  const chatPath = (req, token, language) => `/s/${req.params.slug}/c/${token}?lang=${language}`;

  /** The start screen again, with the typed values and keys kept so a retry stays idempotent. */
  async function startFailure(req, res, error) {
    const known = error instanceof AppError && Object.hasOwn(ERROR_STRINGS, error.code);
    if (!known && !(error instanceof ZodError)) throw error;
    const base = { productId: req.body?.productId, values: echoValues(req.body, START_FIELDS, MAX_ECHO_LENGTH) };
    const probe = await conversations.startPage(req.params.slug, preferences(req), base);
    if (!probe) return notFound(req, res);
    const strings = stringsFor(probe.language);
    const keys = known && error.code === 'PERSISTENCE_FAILED' ? { startKey: keepKey(req.body?.startKey), messageId: keepKey(req.body?.messageId) } : undefined;
    const details = known ? { formError: strings[ERROR_STRINGS[error.code]] } : { errors: fieldErrors(error, messagesFor(strings)), formError: strings.chatErrRejected };
    const page = await conversations.startPage(req.params.slug, preferences(req), { ...base, ...details, keys: keys?.startKey && keys?.messageId ? keys : undefined });
    return sendPage(res, 'public/chat-start', page, known ? error.httpStatus : HTTP_BAD_REQUEST);
  }

  /** What a message post failure looks like to the page script. `saved` is always false here. */
  function jsonFailure(res, error, strings) {
    const known = error instanceof AppError && Object.hasOwn(ERROR_STRINGS, error.code);
    if (known) return res.status(error.httpStatus).json({ saved: false, code: error.code, text: strings[ERROR_STRINGS[error.code]] });
    if (error instanceof ZodError) return res.status(HTTP_BAD_REQUEST).json({ saved: false, code: 'REJECTED', text: strings.chatErrRejected });
    throw error;
  }

  /** The chat page again with the typed text and one banner; the same message id is kept only when saving failed, so a retry cannot double-save. */
  async function chatFailure(req, res, error) {
    const page = await conversations.chatPage(req.params.slug, req.params.token, preferences(req));
    if (!page) return notFound(req, res);
    const strings = stringsFor(page.language);
    const known = error instanceof AppError && Object.hasOwn(ERROR_STRINGS, error.code);
    if (!known && !(error instanceof ZodError)) throw error;
    const retryable = known && error.code === 'PERSISTENCE_FAILED';
    page.view.composerError = known ? strings[ERROR_STRINGS[error.code]] : strings.chatErrRejected;
    page.view.composerValue = echoValues(req.body, ['message'], MAX_ECHO_LENGTH).message ?? '';
    page.view.composerMessageId = retryable ? keepKey(req.body?.messageId) : null;
    return sendPage(res, 'public/chat', page, known ? error.httpStatus : HTTP_BAD_REQUEST);
  }

  return {
    async startPage(req, res) {
      const page = await conversations.startPage(req.params.slug, preferences(req), { productId: typeof req.query?.product === 'string' ? req.query.product : undefined });
      return page ? sendPage(res, 'public/chat-start', page) : notFound(req, res);
    },

    async postStart(req, res) {
      let started;
      try {
        started = await conversations.start(req.params.slug, preferences(req), req.body, { correlationId: req.correlationId });
      } catch (error) {
        if (error instanceof AppError && error.httpStatus === HTTP_NOT_FOUND) return notFound(req, res);
        return startFailure(req, res, error);
      }
      if (started.trap) return res.redirect(SEE_OTHER, `/s/${started.slug}`);
      return res.redirect(SEE_OTHER, `/s/${started.slug}/c/${started.token}?lang=${started.language}`);
    },

    async showChat(req, res) {
      const page = await conversations.chatPage(req.params.slug, req.params.token, preferences(req));
      return page ? sendPage(res, 'public/chat', page) : notFound(req, res);
    },

    /** New messages after ?after=N and the live state. JSON, no-store. Never calls Claude. */
    async poll(req, res) {
      const after = Number.parseInt(req.query?.after, 10);
      const found = await conversations.poll(req.params.slug, req.params.token, preferences(req), Number.isSafeInteger(after) && after >= 0 ? after : 0);
      if (!found) return res.status(HTTP_NOT_FOUND).json({ error: 'not_found' });
      return res.json(found.view);
    },

    async postMessage(req, res) {
      const json = wantsJson(req);
      let result;
      try {
        result = await conversations.post(req.params.slug, req.params.token, preferences(req), req.body, { correlationId: req.correlationId });
      } catch (error) {
        if (error instanceof AppError && error.httpStatus === HTTP_NOT_FOUND) return json ? res.status(HTTP_NOT_FOUND).json({ saved: false, code: 'NOT_FOUND' }) : notFound(req, res);
        return json ? jsonFailure(res, error, stringsFor(languageOf(req))) : chatFailure(req, res, error);
      }
      if (!result.found) return json ? res.status(HTTP_NOT_FOUND).json({ saved: false, code: 'NOT_FOUND' }) : notFound(req, res);
      if (json) return res.json({ saved: true, outcome: result.outcome, duplicate: result.duplicate });
      const language = isSupportedLanguage(req.query?.lang) ? req.query.lang : result.language;
      return res.redirect(SEE_OTHER, chatPath(req, req.params.token, language));
    },

    /** Error handler for the conversation routes: a friendly page or JSON, never a stack trace, provider text, token or message content. */
    handleError(logger) {
      return (error, req, res, next) => {
        if (res.headersSent) return next(error);
        const known = error instanceof AppError;
        const status = known ? error.httpStatus : error instanceof ZodError ? HTTP_BAD_REQUEST : HTTP_INTERNAL_ERROR;
        if (status === HTTP_NOT_FOUND) return notFound(req, res);
        const log = req.log ?? logger;
        log[status >= HTTP_INTERNAL_ERROR ? 'error' : 'warn']('conversation request failed', {
          correlationId: req.correlationId, code: known ? error.code : error instanceof ZodError ? 'VALIDATION_ERROR' : 'INTERNAL_ERROR', status,
          err: known || error instanceof ZodError ? undefined : error,
        });
        if (wantsJson(req)) return res.status(status).json({ saved: false, code: 'UNCONFIRMED', text: stringsFor(languageOf(req)).chatErrUnknown });
        return sendNotice(req, res, { status, template: 'public/error', titleKey: 'errorTitle', bodyKey: 'errorBody' });
      };
    },
  };
}
