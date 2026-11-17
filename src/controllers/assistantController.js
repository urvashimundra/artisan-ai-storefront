import { ZodError } from 'zod';
import { LANGUAGE_COOKIE_NAME, isSupportedLanguage, resolveLanguage } from '../domain/language.js';
import { AppError } from '../lib/errors.js';
import { parseCookies } from '../lib/cookies.js';
import { buildNoticePage } from '../services/publicShopService.js';

const SEE_OTHER = 303;
const HTTP_BAD_REQUEST = 400;
const HTTP_NOT_FOUND = 404;
const HTTP_INTERNAL_ERROR = 500;

/**
 * HTTP layer of the LEGACY enquiry pages: the private answer page and the "find the answer" post for existing enquiries. No session. The page
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

  const privatePath = (req, language) => `/s/${req.params.slug}/q/${req.params.token}?lang=${language}`;

  return {
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
