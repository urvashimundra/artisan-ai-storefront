import { EMAIL_KINDS } from '../domain/emailRules.js';
import { renderContactInbox, renderEmail } from '../domain/emailTemplates.js';

const QUEUED = 'queued';
const FAILED = 'error';
const SKIPPED = 'skipped';

/**
 * Email enqueue API for emails the APP queues itself (contact form, seller enquiry alerts). Order emails are queued by the
 * database functions inside the order transaction (migration 010), not here.
 * It never throws: a failed or limited enqueue is logged (kind and outcome only, never an address, subject or text) and the
 * caller carries on. Limits and dedupe are applied by the database function, so they survive restarts.
 * @param {{ outbox: { enqueue: Function }, owners: { findById: Function }, logger: { info: Function, warn: Function },
 *   baseUrl: string, kick?: () => void }} deps `kick` wakes the worker after a row was queued.
 */
export function createEmailService({ outbox, owners, logger, baseUrl, kick = () => {} }) {
  /** @returns {Promise<string>} queued | duplicate | limited_global | limited_recipient | error */
  async function deliver(kind, email) {
    try {
      const outcome = await outbox.enqueue({ kind, ...email });
      if (outcome === QUEUED) kick();
      else logger.info('email not queued', { kind, outcome });
      return outcome;
    } catch (error) {
      logger.warn('email enqueue failed', { kind, outcome: FAILED, code: error?.code });
      return FAILED;
    }
  }

  return {
    /**
     * Queues the contact-form email to our inbox. Reply-To is the visitor's validated address.
     * @param {{ inboxEmail: string, contactId: string, name: string, email: string, message: string }} input
     * @returns {Promise<string>}
     */
    enqueueContactInbox({ inboxEmail, contactId, name, email, message }) {
      const { subject, text } = renderContactInbox({ name, email, message });
      return deliver(EMAIL_KINDS.CONTACT_INBOX, {
        storeId: null, toEmail: inboxEmail, language: 'en', subject, body: text, replyTo: email, dedupeKey: `${EMAIL_KINDS.CONTACT_INBOX}:${contactId}`,
      });
    },

    /**
     * Queues "a customer enquiry needs you" to the owner's ACCOUNT email (read through the owner lookup, never from input).
     * Sent only when the store's notify_enquiry_email setting is on. Module 4b calls this.
     * @param {{ id: string, ownerId: string, name: string, notifyEnquiryEmail: boolean }} store From the session.
     * @param {string} enquiryId
     * @returns {Promise<string>}
     */
    async enqueueSellerEnquiryAlert(store, enquiryId) {
      if (!store.notifyEnquiryEmail) return SKIPPED;
      try {
        const owner = await owners.findById(store.ownerId);
        if (!owner?.email) return SKIPPED;
        const { subject, text } = renderEmail({ kind: EMAIL_KINDS.SELLER_ENQUIRY_NEEDS_YOU, language: 'en', facts: { shop: store.name }, baseUrl });
        return deliver(EMAIL_KINDS.SELLER_ENQUIRY_NEEDS_YOU, {
          storeId: store.id, toEmail: owner.email, language: 'en', subject, body: text, dedupeKey: `${EMAIL_KINDS.SELLER_ENQUIRY_NEEDS_YOU}:${enquiryId}`,
        });
      } catch (error) {
        logger.warn('email enqueue failed', { kind: EMAIL_KINDS.SELLER_ENQUIRY_NEEDS_YOU, outcome: FAILED, code: error?.code });
        return FAILED;
      }
    },
  };
}
