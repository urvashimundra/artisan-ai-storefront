import { ZodError } from 'zod';
import { MAX_CONTACT_MESSAGE_LENGTH, MAX_CONTACT_NAME_LENGTH } from '../domain/contactRules.js';
import { MAX_EMAIL_LENGTH } from '../domain/orderRules.js';
import { echoValues, fieldErrors } from './formErrors.js';

const SEE_OTHER = 303;
const HTTP_OK = 200;
const HTTP_BAD_REQUEST = 400;
const ECHO_LIMIT = MAX_CONTACT_MESSAGE_LENGTH * 4;
const FIELD_ORDER = ['name', 'email', 'message'];
const MESSAGES = {
  name: 'Enter your name (up to 80 characters, on one line).',
  email: 'Enter a valid email address.',
  message: 'Write your message (up to 2000 characters).',
};
const PAGE_LIMITS = { name: MAX_CONTACT_NAME_LENGTH, email: MAX_EMAIL_LENGTH, message: MAX_CONTACT_MESSAGE_LENGTH };

/**
 * Contact form pages (HTTP only; rules live in the contact service). The visitor's address is never echoed on the
 * confirmation page, and a submission always ends in a redirect to it, so a refresh cannot resend the form.
 * @param {{ contact: { submit: Function } }} deps
 */
export function createContactController({ contact }) {
  const formPage = (res, status, errors, values) =>
    res.status(status).render('contact', { title: 'Contact us', errors, values, limits: PAGE_LIMITS, fieldOrder: FIELD_ORDER, errorMessages: MESSAGES });

  return {
    showForm: (_req, res) => formPage(res, HTTP_OK, {}, {}),

    showSent: (_req, res) => res.status(HTTP_OK).render('contact-sent', { title: 'Message sent' }),

    async submit(req, res) {
      try {
        await contact.submit(req.body);
      } catch (error) {
        if (!(error instanceof ZodError)) throw error;
        return formPage(res, HTTP_BAD_REQUEST, fieldErrors(error, MESSAGES), echoValues(req.body, FIELD_ORDER, ECHO_LIMIT));
      }
      return res.redirect(SEE_OTHER, '/contact/sent');
    },
  };
}
