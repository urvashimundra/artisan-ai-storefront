import { z } from 'zod';
import { ENQUIRY_STATUS, ENQUIRY_STATUSES, FLAG_REASONS } from '../domain/enquiryRules.js';
import { AppError } from '../lib/errors.js';
import { throwIfError } from './pgErrors.js';
import { requireStoreId } from './requireStoreId.js';

const HTTP_INTERNAL_ERROR = 500;
/** The most enquiries the seller's list returns (newest first). */
export const MAX_LISTED_ENQUIRIES = 100;
/** token_hash is never selected: it is only a lookup key. token_enc is selected only on the seller's detail view. */
const LIST_COLUMNS =
  'id, store_id, product_id, language, customer_name, customer_phone, question, status, answer_text, flag_reason, trace, seller_reply, replied_at, claimed_at, created_at, updated_at';
const DETAIL_COLUMNS = `${LIST_COLUMNS}, token_enc`;
const REPLYABLE = [ENQUIRY_STATUS.ANSWERED, ENQUIRY_STATUS.NEEDS_YOU, ENQUIRY_STATUS.HANDLED];
const HANDLEABLE = [ENQUIRY_STATUS.ANSWERED, ENQUIRY_STATUS.NEEDS_YOU];

const enquiryRow = z.object({
  id: z.uuid(),
  store_id: z.uuid(),
  product_id: z.uuid().nullable(),
  language: z.enum(['en', 'gu', 'hi']),
  customer_name: z.string(),
  customer_phone: z.string(),
  question: z.string(),
  status: z.enum(ENQUIRY_STATUSES),
  answer_text: z.string().nullable(),
  flag_reason: z.enum(FLAG_REASONS).nullable(),
  trace: z.array(z.string()),
  seller_reply: z.string().nullable(),
  replied_at: z.string().nullable(),
  claimed_at: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
  token_enc: z.string().nullable().optional(),
});
const contextRow = z.object({ owner_id: z.uuid(), name: z.string(), notify_enquiry_email: z.boolean(), owners: z.object({ is_demo: z.boolean() }) });
const idRow = z.object({ id: z.uuid() });

function parse(schema, value, operation) {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new AppError('DATABASE_ERROR', HTTP_INTERNAL_ERROR, 'Something went wrong', { operation, reason: 'unexpected_result_shape' });
  return parsed.data;
}

const toEnquiry = (row) => ({
  id: row.id,
  storeId: row.store_id,
  productId: row.product_id,
  language: row.language,
  customerName: row.customer_name,
  customerPhone: row.customer_phone,
  question: row.question,
  status: row.status,
  answerText: row.answer_text,
  flagReason: row.flag_reason,
  trace: row.trace,
  sellerReply: row.seller_reply,
  repliedAt: row.replied_at,
  claimedAt: row.claimed_at,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  tokenEnc: row.token_enc ?? null,
});

/**
 * Customer enquiries and the assistant's work on them. Every method takes storeId first and scopes its query by it; the private
 * answer page is looked up INSIDE the shop named in its URL, so there is no cross-store query. Every state change is one conditional
 * UPDATE (a compare-and-set on the current status), so a refresh or a double submit cannot run twice.
 * @param {{ client: any }} deps
 */
export function createEnquiryRepository({ client }) {
  const enquiries = (storeId, columns = LIST_COLUMNS) => client.from('enquiries').select(columns).eq('store_id', requireStoreId(storeId));
  const counted = (storeId) => client.from('enquiries').select('id', { count: 'exact', head: true }).eq('store_id', requireStoreId(storeId));
  const update = (storeId, id, fields) => client.from('enquiries').update(fields).eq('store_id', requireStoreId(storeId)).eq('id', id);

  /** Runs a conditional UPDATE and reports whether a row changed. */
  async function changed(query, operation) {
    const { data, error } = await query.select('id');
    throwIfError(error);
    return parse(z.array(idRow), data ?? [], operation).length > 0;
  }

  async function count(query) {
    const { count: total, error } = await query;
    throwIfError(error);
    return total ?? 0;
  }

  return {
    /** The seller's account context for a shop: who pays for the AI call and whether the alert email is on. @returns {Promise<object | null>} */
    async findOwnerContext(storeId) {
      const query = client.from('stores').select('owner_id, name, notify_enquiry_email, owners(is_demo)').eq('id', requireStoreId(storeId));
      const { data, error } = await query.maybeSingle();
      throwIfError(error);
      if (!data) return null;
      const row = parse(contextRow, data, 'enquiries.findOwnerContext');
      return { id: storeId, ownerId: row.owner_id, name: row.name, notifyEnquiryEmail: row.notify_enquiry_email, isDemo: row.owners.is_demo };
    },

    /** Saves a new enquiry (status pending, or needs_you straight away when the daily cap was reached). @returns {Promise<{ id: string }>} */
    async create(storeId, enquiry) {
      const row = {
        store_id: requireStoreId(storeId), product_id: enquiry.productId, language: enquiry.language, customer_name: enquiry.customerName,
        customer_phone: enquiry.customerPhone, question: enquiry.question, status: enquiry.status, flag_reason: enquiry.flagReason,
        token_hash: enquiry.tokenHash, token_enc: enquiry.tokenEnc,
      };
      const { data, error } = await client.from('enquiries').insert(row).select('id').single();
      throwIfError(error);
      return parse(idRow, data, 'enquiries.create');
    },

    /** @returns {Promise<object | null>} The enquiry with this token hash in THIS shop, or null. */
    async findByTokenHash(storeId, tokenHash) {
      const { data, error } = await enquiries(storeId).eq('token_hash', tokenHash).maybeSingle();
      throwIfError(error);
      return data ? toEnquiry(parse(enquiryRow, data, 'enquiries.findByTokenHash')) : null;
    },

    /** Compare-and-set pending -> answering. @returns {Promise<boolean>} True for exactly one caller. */
    claim(storeId, id, nowIso) {
      const query = update(storeId, id, { status: ENQUIRY_STATUS.ANSWERING, claimed_at: nowIso, updated_at: nowIso }).eq('status', ENQUIRY_STATUS.PENDING);
      return changed(query, 'enquiries.claim');
    },

    /** Compare-and-set answering -> answered or needs_you. @returns {Promise<boolean>} */
    finish(storeId, id, { status, answerText, flagReason, trace }, nowIso) {
      const fields = { status, answer_text: answerText, flag_reason: flagReason, trace, updated_at: nowIso };
      return changed(update(storeId, id, fields).eq('status', ENQUIRY_STATUS.ANSWERING), 'enquiries.finish');
    },

    /** answering for longer than the stale limit -> needs_you (error). @returns {Promise<boolean>} True only for the call that changed it. */
    failStuck(storeId, id, staleBeforeIso, nowIso) {
      const fields = { status: ENQUIRY_STATUS.NEEDS_YOU, flag_reason: 'error', updated_at: nowIso };
      return changed(update(storeId, id, fields).eq('status', ENQUIRY_STATUS.ANSWERING).lt('claimed_at', staleBeforeIso), 'enquiries.failStuck');
    },

    /** @returns {Promise<number>} Enquiries from this phone number to this shop since the time. */
    countByPhoneSince(storeId, phone, sinceIso) {
      return count(counted(storeId).eq('customer_phone', phone).gte('created_at', sinceIso));
    },

    /** @returns {Promise<number>} Enquiries of this shop the assistant started on since the time (claimed_at is set when it starts). */
    countClaimedSince(storeId, sinceIso) {
      return count(counted(storeId).gte('claimed_at', sinceIso));
    },

    /** @returns {Promise<number>} Enquiries of this shop in a status (the dashboard counter). */
    countByStatus(storeId, status) {
      return count(counted(storeId).eq('status', status));
    },

    /** Newest first, at most 100; optional status filter. @returns {Promise<object[]>} */
    async listForOwner(storeId, { status = null } = {}) {
      let query = enquiries(storeId).order('created_at', { ascending: false }).order('id', { ascending: false }).limit(MAX_LISTED_ENQUIRIES);
      if (status) query = query.eq('status', status);
      const { data, error } = await query;
      throwIfError(error);
      return (data ?? []).map((row) => toEnquiry(parse(enquiryRow, row, 'enquiries.listForOwner')));
    },

    /** @returns {Promise<object | null>} One enquiry of this shop, with the encrypted link. */
    async findForOwner(storeId, id) {
      const { data, error } = await enquiries(storeId, DETAIL_COLUMNS).eq('id', id).maybeSingle();
      throwIfError(error);
      return data ? toEnquiry(parse(enquiryRow, data, 'enquiries.findForOwner')) : null;
    },

    /** Saves the seller's reply and marks the enquiry handled. @returns {Promise<boolean>} False when the enquiry is missing or still being answered. */
    saveReply(storeId, id, reply, nowIso) {
      const fields = { seller_reply: reply, replied_at: nowIso, status: ENQUIRY_STATUS.HANDLED, updated_at: nowIso };
      return changed(update(storeId, id, fields).in('status', REPLYABLE), 'enquiries.saveReply');
    },

    /** @returns {Promise<boolean>} True when the enquiry was answered or needed the seller, and is now handled. */
    markHandled(storeId, id, nowIso) {
      return changed(update(storeId, id, { status: ENQUIRY_STATUS.HANDLED, updated_at: nowIso }).in('status', HANDLEABLE), 'enquiries.markHandled');
    },
  };
}
