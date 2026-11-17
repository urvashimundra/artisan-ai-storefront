import { z } from 'zod';

/** Email kinds. Mirrored in the email_outbox_kind_check constraint of db/migrations/010_email_outbox_contact.sql. */
export const EMAIL_KINDS = Object.freeze({
  ORDER_PLACED: 'order_placed',
  ORDER_PAYMENT_RECEIVED: 'order_payment_received',
  ORDER_CONFIRMED: 'order_confirmed',
  ORDER_PAYMENT_NOT_FOUND: 'order_payment_not_found',
  ORDER_CANCELLED: 'order_cancelled',
  ORDER_EXPIRED: 'order_expired',
  SELLER_PAYMENT_SUBMITTED: 'seller_payment_submitted',
  SELLER_ENQUIRY_NEEDS_YOU: 'seller_enquiry_needs_you',
  CONTACT_INBOX: 'contact_inbox',
});
export const CUSTOMER_KINDS = Object.freeze([
  EMAIL_KINDS.ORDER_PLACED,
  EMAIL_KINDS.ORDER_PAYMENT_RECEIVED,
  EMAIL_KINDS.ORDER_CONFIRMED,
  EMAIL_KINDS.ORDER_PAYMENT_NOT_FOUND,
  EMAIL_KINDS.ORDER_CANCELLED,
  EMAIL_KINDS.ORDER_EXPIRED,
]);
export const SELLER_KINDS = Object.freeze([EMAIL_KINDS.SELLER_PAYMENT_SUBMITTED, EMAIL_KINDS.SELLER_ENQUIRY_NEEDS_YOU]);
export const EMAIL_KIND_VALUES = Object.freeze(Object.values(EMAIL_KINDS));

export const EMAIL_STATUSES = Object.freeze({ QUEUED: 'queued', SENDING: 'sending', SENT: 'sent', DEAD: 'dead' });

/** Abuse limits. Mirrored in email_enqueue() in migration 010 (a unit test compares them). */
export const EMAIL_LIMITS = Object.freeze({
  customerPerHour: 6,
  customerPerDay: 20,
  sellerPerHour: 30,
  globalPerHour: 150,
});

/** Delivery. MAX_ATTEMPTS is mirrored in claim_due_emails() and finish_email() (a unit test compares them). */
export const MAX_ATTEMPTS = 5;
export const RETRY_DELAYS_SECONDS = Object.freeze([10, 30, 120, 900]);
export const WORKER_INTERVAL_MS = 15_000;
export const WORKER_BATCH_SIZE = 10;
export const WORKER_LEASE_SECONDS = 300;
export const RETENTION_DAYS = 30;
export const MS_PER_DAY = 86_400_000;
export const RETENTION_INTERVAL_MS = MS_PER_DAY;

/** Column limits. Mirrored in migration 010. */
export const MAX_SUBJECT_LENGTH = 200;
export const MAX_BODY_LENGTH = 4000;
export const MAX_ADDRESS_LENGTH = 254;
export const MAX_CONTACT_NAME_LENGTH = 80;
export const MAX_CONTACT_MESSAGE_LENGTH = 2000;

export const SENDER_NAME = 'The Artisan Story';
export const SUPPORT_REPLY_TO = 'support@theartisanstory.in';

/** The email facts an order event needs. The database writes them into the outbox payload; token_enc is the encrypted status token (see linkCipher). Strict. */
export const orderPayloadSchema = z
  .object({
    reference: z.string().min(1).max(20),
    shop: z.string().min(1).max(200),
    slug: z.string().min(1).max(40),
    token_enc: z.string().max(200).nullable().optional(),
  })
  .strict();
