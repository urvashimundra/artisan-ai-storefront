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
const HTTP_TOO_MANY_REQUESTS = 429;
const HTTP_INTERNAL_ERROR = 500;
const MAX_ECHO_LENGTH = 2000;
const ASK_FIELDS = ['name', 'phone', 'question'];
const FIELD_STRINGS = { name: 'errAskName', phone: 'errAskPhone', question: 'errAskQuestion', productId: 'errUnavailable' };

const messagesFor = (strings) => Object.fromEntries(Object.entries(FIELD_STRINGS).map(([field, key]) => [field, strings[key]]));

/**
 * HTTP layer for asking the seller: the ask form post, the private answer page and the "find the answer" post. No session. The page
 * never calls Claude. Unknown, other-shop and malformed links all get the same generic 404, and nothing here logs a question, an answer,
 * a name, a number or a token.
 * @param {{ assistant: ReturnType<import('../services/assistantService.js').createAssistantService>,
 *   conversations?: { hasChat: (slug: string, token: string) => Promise<boolean> } | null }} deps
 */
export function createAssistantController({ assistant, conversations = null }) {
  const preferences = (req) => ({
    query: req.query?.lang,
    cookie: parseCookies(req.get('cookie'))[LANGUAGE_COOKIE_NAME],
    acceptLanguage: req.get('accept-language'),
  });

  function sendNotice(req, res, { status, template, titleKey, bodyKey }) {
    const language = resolveLanguage({ ...preferences(req), shopDefault: 'en' }).language;
    res.set('Content-Language', language);
    return res.status(status).render(template, buildNoticePage({ language, titleKey, bodyKey }));
  }

  const notFound = (req, res) =>
    sendNotice(req, res, { status: HTTP_NOT_FOUND, template: 'public/not-found', titleKey: 'notFoundTitle', bodyKey: 'notFoundBody' });

  const sendPage = (res, template, page, status) => {
    res.set('Content-Language', page.language);
    return res.status(status).render(template, page.view);
  };

  /** The ask page again, with the typed values (never a phone number in a log) and one message per field. */
  async function askFailure(req, res, error) {
    const limited = error instanceof AppError && error.code === 'ENQUIRY_LIMIT';
    if (!limited && !(error instanceof ZodError)) throw error;
    const base = { productId: typeof req.body?.productId === 'string' ? req.body.productId.slice(0, 40) : null, values: echoValues(req.body, ASK_FIELDS, MAX_ECHO_LENGTH) };
    const probe = await assistant.getAskPage(req.params.slug, preferences(req), base);
    if (!probe) return notFound(req, res);
    const strings = stringsFor(probe.language);
    const details = limited ? { formError: strings.errAskLimit } : { errors: fieldErrors(error, messagesFor(strings)) };
    const page = await assistant.getAskPage(req.params.slug, preferences(req), { ...base, ...details });
    return sendPage(res, 'public/ask', page, limited ? HTTP_TOO_MANY_REQUESTS : HTTP_BAD_REQUEST);
  }

  const privatePath = (req, language) => `/s/${req.params.slug}/q/${req.params.token}?lang=${language}`;

  return {
    async postAsk(req, res) {
      let saved;
      try {
        saved = await assistant.ask(req.params.slug, preferences(req), req.body);
      } catch (error) {
        if (error instanceof AppError && error.httpStatus === HTTP_NOT_FOUND) return notFound(req, res);
        return askFailure(req, res, error);
      }
      if (saved.trap) return res.redirect(SEE_OTHER, `/s/${saved.slug}`);
      return res.redirect(SEE_OTHER, `/s/${saved.slug}/q/${saved.token}?lang=${saved.language}`);
    },

    /** Legacy /q/ link: a conversation with the same private token (copied by the optional backfill) takes over; otherwise the old page. */
    async showEnquiry(req, res) {
      if (conversations && (await conversations.hasChat(req.params.slug, req.params.token))) {
        const language = isSupportedLanguage(req.query?.lang) ? req.query.lang : 'en';
        return res.redirect(SEE_OTHER, `/s/${req.params.slug}/c/${req.params.token}?lang=${language}`);
      }
      const page = await assistant.getPage(req.params.slug, req.params.token, preferences(req));
      return page ? sendPage(res, 'public/enquiry', page, 200) : notFound(req, res);
    },

    async postAnswer(req, res) {
      const found = await assistant.answer(req.params.slug, req.params.token, { correlationId: req.correlationId });
      if (!found) return notFound(req, res);
      const language = isSupportedLanguage(req.query?.lang) ? req.query.lang : 'en';
      return res.redirect(SEE_OTHER, privatePath(req, language));
    },

    /** Error handler for the assistant router: a friendly page, never a stack trace, provider text, token or form content. */
    handleError(logger) {
      return (error, req, res, next) => {
        if (res.headersSent) return next(error);
        const known = error instanceof AppError;
        const status = known ? error.httpStatus : error instanceof ZodError ? HTTP_BAD_REQUEST : HTTP_INTERNAL_ERROR;
        if (status === HTTP_NOT_FOUND) return notFound(req, res);
        const log = req.log ?? logger;
        log[status >= HTTP_INTERNAL_ERROR ? 'error' : 'warn']('enquiry request failed', {
          correlationId: req.correlationId,
          code: known ? error.code : error instanceof ZodError ? 'VALIDATION_ERROR' : 'INTERNAL_ERROR',
          status,
          err: known || error instanceof ZodError ? undefined : error,
        });
        return sendNotice(req, res, { status, template: 'public/error', titleKey: 'errorTitle', bodyKey: 'errorBody' });
      };
    },
  };
}
