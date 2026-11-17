import { randomUUID } from 'node:crypto';
import { EMAIL_KINDS, EMAIL_LIMITS, EMAIL_STATUSES, MAX_ATTEMPTS, SELLER_KINDS } from '../../src/domain/emailRules.js';

const MS_PER_HOUR = 3_600_000;
const MS_PER_DAY = 86_400_000;
const isSeller = (kind) => SELLER_KINDS.includes(kind);

/**
 * In-memory email outbox with the rules of the migration 010 functions (the SQL itself is verified by db/test, not here):
 * dedupe, the limits, atomic claim with a lease, finish, retention. `clock.now` is epoch milliseconds, set by the test.
 * `enqueueForOrder` is what the order functions do inside their transaction (email_enqueue_order).
 * @param {{ clock: { now: number } }} deps
 */
export function createFakeOutbox({ clock }) {
  const rows = [];
  const recentFor = (to, windowMs) => rows.filter((r) => r.toEmail.toLowerCase() === to.toLowerCase() && clock.now - r.createdAtMs < windowMs).length;

  function limitReason(kind, to) {
    if (rows.filter((r) => clock.now - r.createdAtMs < MS_PER_HOUR).length >= EMAIL_LIMITS.globalPerHour) return 'limited_global';
    if (kind === EMAIL_KINDS.CONTACT_INBOX) return null;
    const hourly = isSeller(kind) ? EMAIL_LIMITS.sellerPerHour : EMAIL_LIMITS.customerPerHour;
    if (recentFor(to, MS_PER_HOUR) >= hourly) return 'limited_recipient';
    if (!isSeller(kind) && recentFor(to, MS_PER_DAY) >= EMAIL_LIMITS.customerPerDay) return 'limited_recipient';
    return null;
  }

  const outbox = {
    rows,
    failNextEnqueue: false,
    async enqueue(email) {
      if (outbox.failNextEnqueue) throw new Error('outbox down');
      if (rows.some((r) => r.dedupeKey === email.dedupeKey)) return 'duplicate';
      const reason = limitReason(email.kind, email.toEmail);
      if (reason) return reason;
      rows.push({
        id: randomUUID(), storeId: email.storeId, kind: email.kind, toEmail: email.toEmail, language: email.language, subject: email.subject,
        body: email.body, payload: email.payload ?? {}, replyTo: email.replyTo ?? null, dedupeKey: email.dedupeKey, status: EMAIL_STATUSES.QUEUED,
        attempts: 0, nextAttemptAtMs: clock.now, leaseUntilMs: null, lastErrorCode: null, createdAtMs: clock.now, sentAtMs: null,
      });
      return 'queued';
    },

    /** What email_enqueue_order does: customer kinds to the order's address and language, seller kinds to the owner, in English. */
    enqueueForOrder({ order, shop, ownerEmail, kind, suffix = null, link = null }) {
      const to = isSeller(kind) ? ownerEmail : order.customerEmail;
      if (!to) return 'skipped';
      return outbox.enqueue({
        storeId: order.storeId, kind, toEmail: to, language: isSeller(kind) ? 'en' : order.language, subject: '', body: '',
        payload: { reference: order.reference, shop: shop.name, slug: shop.slug, link }, dedupeKey: `${kind}:${order.id}${suffix === null ? '' : `:${suffix}`}`,
      });
    },

    async claimDue(limit, leaseSeconds) {
      for (const row of rows) {
        if (row.status === EMAIL_STATUSES.SENDING && row.leaseUntilMs <= clock.now && row.attempts >= MAX_ATTEMPTS) {
          Object.assign(row, { status: EMAIL_STATUSES.DEAD, body: '', payload: {}, leaseUntilMs: null, lastErrorCode: 'LEASE_EXPIRED' });
        }
      }
      const due = rows
        .filter((r) => (r.status === EMAIL_STATUSES.QUEUED && r.nextAttemptAtMs <= clock.now) || (r.status === EMAIL_STATUSES.SENDING && r.leaseUntilMs <= clock.now))
        .slice(0, limit);
      for (const row of due) Object.assign(row, { status: EMAIL_STATUSES.SENDING, leaseUntilMs: clock.now + leaseSeconds * 1000, attempts: row.attempts + 1 });
      return due.map((r) => ({ ...r, replyTo: r.replyTo, payload: structuredClone(r.payload) }));
    },

    async finish(id, { sent, errorCode = null, retrySeconds = null }) {
      const row = rows.find((r) => r.id === id && r.status === EMAIL_STATUSES.SENDING);
      if (!row) return null;
      const status = sent ? EMAIL_STATUSES.SENT : retrySeconds === null || row.attempts >= MAX_ATTEMPTS ? EMAIL_STATUSES.DEAD : EMAIL_STATUSES.QUEUED;
      Object.assign(row, { status, leaseUntilMs: null, lastErrorCode: sent ? null : errorCode });
      if (sent) row.sentAtMs = clock.now;
      if (status === EMAIL_STATUSES.QUEUED) row.nextAttemptAtMs = clock.now + retrySeconds * 1000;
      else Object.assign(row, { body: '', payload: {} });
      return status;
    },

    async deleteFinishedBefore(cutoffIso) {
      const cutoff = Date.parse(cutoffIso);
      const doomed = rows.filter((r) => [EMAIL_STATUSES.SENT, EMAIL_STATUSES.DEAD].includes(r.status) && r.createdAtMs < cutoff);
      for (const row of doomed) rows.splice(rows.indexOf(row), 1);
      return doomed.length;
    },
  };
  return outbox;
}

/** In-memory contact repository: insert, count since, delete before. */
export function createFakeContacts({ clock }) {
  const rows = [];
  return {
    rows,
    async insert({ name, email, message }) {
      const row = { id: randomUUID(), name, email, message, createdAtMs: clock.now };
      rows.push(row);
      return { id: row.id, createdAt: new Date(clock.now).toISOString() };
    },
    async countSince(email, sinceIso) {
      return rows.filter((r) => r.email.toLowerCase() === email.toLowerCase() && r.createdAtMs >= Date.parse(sinceIso)).length;
    },
    async deleteBefore(cutoffIso) {
      const doomed = rows.filter((r) => r.createdAtMs < Date.parse(cutoffIso));
      for (const row of doomed) rows.splice(rows.indexOf(row), 1);
      return doomed.length;
    },
  };
}

/** A relay that records messages and can be told to fail. `behaviour` is a function (message, attempt) => result or throws. */
export function createFakeRelay(behaviour = () => ({ messageId: 'm1', httpStatus: 200 })) {
  const sent = [];
  return { sent, async send(message) { sent.push(message); return behaviour(message, sent.length); } };
}
