import { CONTACT_ADDRESS_LIMITS, TRAP_FIELD, contactSchema } from '../domain/contactRules.js';
import { tooManyRequests } from '../lib/errors.js';

export const CONTACT_OUTCOME = Object.freeze({ SAVED: 'saved', IGNORED: 'ignored' });

/**
 * The main-site contact form. Validates strictly, saves the message and queues one email to our inbox with Reply-To set to the
 * visitor. Email trouble never fails the submit. A filled trap field saves and sends nothing but looks like success.
 * Throws ZodError for a bad form and AppError (429) when this address has written too often.
 * @param {{ contacts: { insert: Function, countSince: Function }, emails: { enqueueContactInbox: Function },
 *   inboxEmail: string | null, logger: { info: Function, warn: Function }, now?: () => number }} deps
 *   `inboxEmail` is CONTACT_INBOX_EMAIL, or OWNER_NOTIFY_EMAIL as the fallback; null means no email is sent (the message is saved).
 */
export function createContactService({ contacts, emails, inboxEmail, logger, now = Date.now }) {
  async function assertWithinAddressLimit(email) {
    const since = new Date(now() - CONTACT_ADDRESS_LIMITS.windowMs).toISOString();
    if ((await contacts.countSince(email, since)) >= CONTACT_ADDRESS_LIMITS.limit) throw tooManyRequests('Too many messages from this address');
  }

  async function notifyInbox(saved, form) {
    if (!inboxEmail) {
      logger.warn('contact inbox not configured', { contactId: saved.id });
      return;
    }
    try {
      await emails.enqueueContactInbox({ inboxEmail, contactId: saved.id, name: form.name, email: form.email, message: form.message });
    } catch (error) {
      logger.warn('contact email failed', { contactId: saved.id, code: error?.code });
    }
  }

  return {
    /** @param {unknown} body The urlencoded form. @returns {Promise<'saved' | 'ignored'>} */
    async submit(body) {
      const form = contactSchema.parse(body ?? {});
      if (form[TRAP_FIELD]) {
        logger.info('contact trap field filled', {});
        return CONTACT_OUTCOME.IGNORED;
      }
      await assertWithinAddressLimit(form.email);
      const saved = await contacts.insert({ name: form.name, email: form.email, message: form.message });
      logger.info('contact message saved', { contactId: saved.id });
      await notifyInbox(saved, form);
      return CONTACT_OUTCOME.SAVED;
    },
  };
}
