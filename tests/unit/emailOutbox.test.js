import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { EMAIL_KINDS, EMAIL_LIMITS, MAX_ATTEMPTS, RETENTION_DAYS, RETRY_DELAYS_SECONDS, SUPPORT_REPLY_TO, WORKER_LEASE_SECONDS } from '../../src/domain/emailRules.js';
import { createEmailService } from '../../src/email/emailService.js';
import { createOutboxWorker, retryDelaySeconds } from '../../src/email/outboxWorker.js';
import { RELAY_REFUSED, RelayError } from '../../src/email/relayClient.js';
import { createFakeContacts, createFakeOutbox, createFakeRelay } from '../helpers/emailFakes.js';
import { createLogCollector } from '../helpers/productFakes.js';

const BASE_URL = 'https://shop.example.test';
const START = Date.UTC(2026, 10, 17, 9, 0, 0);
const MS = { second: 1000, minute: 60_000, hour: 3_600_000, day: 86_400_000 };
const OWNER = { id: '11111111-1111-4111-8111-111111111111', email: 'owner@example.test' };
const STORE = { id: '22222222-2222-4222-8222-222222222222', ownerId: OWNER.id, name: 'Kala Ghar', notifyEnquiryEmail: true };

function setup() {
  const clock = { now: START };
  const outbox = createFakeOutbox({ clock });
  const contacts = createFakeContacts({ clock });
  const logs = createLogCollector();
  const owners = { findById: async (id) => (id === OWNER.id ? OWNER : null) };
  const kicks = [];
  const emails = createEmailService({ outbox, owners, logger: logs, baseUrl: BASE_URL, kick: () => kicks.push(1) });
  const makeWorker = (relay) => createOutboxWorker({ outbox, contacts, relay, baseUrl: BASE_URL, logger: logs, clock: () => clock.now });
  return { clock, outbox, contacts, logs, emails, kicks, makeWorker };
}

const orderRow = (outbox, overrides = {}) =>
  outbox.enqueue({
    storeId: STORE.id, kind: EMAIL_KINDS.ORDER_PLACED, toEmail: 'buyer@example.test', language: 'hi', subject: '', body: '',
    payload: { reference: 'AS1001', shop: 'Kala Ghar', slug: 'kala-ghar', link: `${BASE_URL}/o/token` }, dedupeKey: `order_placed:${outbox.rows.length}`, ...overrides,
  });
const relayError = (code, httpStatus) => new RelayError(code, httpStatus);

describe('enqueue', () => {
  it('queues a contact email once; the same contact id again is a no-op', async () => {
    const { emails, outbox, kicks } = setup();
    const input = { inboxEmail: 'inbox@example.test', contactId: 'c1', name: 'Asha', email: 'asha@example.test', message: 'Hello' };
    assert.equal(await emails.enqueueContactInbox(input), 'queued');
    assert.equal(await emails.enqueueContactInbox(input), 'duplicate');
    assert.equal(outbox.rows.length, 1);
    assert.equal(kicks.length, 1, 'the worker is only woken for a new row');
    assert.deepEqual([outbox.rows[0].toEmail, outbox.rows[0].replyTo, outbox.rows[0].kind], ['inbox@example.test', 'asha@example.test', 'contact_inbox']);
    assert.ok(outbox.rows[0].body.includes('Hello'));
  });

  it('never throws to the caller when the outbox is down', async () => {
    const { emails, outbox, kicks, logs } = setup();
    outbox.failNextEnqueue = true;
    const result = await emails.enqueueContactInbox({ inboxEmail: 'inbox@example.test', contactId: 'c1', name: 'A', email: 'a@example.test', message: 'm' });
    assert.equal(result, 'error');
    assert.equal(kicks.length, 0);
    assert.ok(logs.entries.some((entry) => entry.outcome === 'error' && entry.kind === 'contact_inbox'));
  });

  it('the seller enquiry alert goes to the owner account email, only when the setting is on', async () => {
    const { emails, outbox } = setup();
    assert.equal(await emails.enqueueSellerEnquiryAlert({ ...STORE, notifyEnquiryEmail: false }, 'e0'), 'skipped');
    assert.equal(outbox.rows.length, 0);
    assert.equal(await emails.enqueueSellerEnquiryAlert(STORE, 'e1'), 'queued');
    assert.equal(outbox.rows[0].toEmail, OWNER.email);
    assert.equal(outbox.rows[0].kind, EMAIL_KINDS.SELLER_ENQUIRY_NEEDS_YOU);
    assert.equal(outbox.rows[0].language, 'en');
    assert.equal(await emails.enqueueSellerEnquiryAlert(STORE, 'e1'), 'duplicate');
  });

  it('skips the alert when the owner cannot be found', async () => {
    const { emails, outbox } = setup();
    assert.equal(await emails.enqueueSellerEnquiryAlert({ ...STORE, ownerId: 'f'.repeat(8) }, 'e1'), 'skipped');
    assert.equal(outbox.rows.length, 0);
  });
});

describe('abuse limits (counted from the outbox)', () => {
  it('allows 6 customer emails per recipient per rolling hour, case-insensitively, and queues nothing beyond', async () => {
    const { outbox, logs, emails } = setup();
    for (let i = 0; i < EMAIL_LIMITS.customerPerHour; i += 1) assert.equal(await orderRow(outbox, { toEmail: 'Lim@Example.test', dedupeKey: `k${i}` }), 'queued');
    assert.equal(await orderRow(outbox, { toEmail: 'lim@example.test', dedupeKey: 'k-extra' }), 'limited_recipient');
    assert.equal(outbox.rows.length, EMAIL_LIMITS.customerPerHour);
    assert.equal(await orderRow(outbox, { toEmail: 'other@example.test', dedupeKey: 'k-other' }), 'queued');
    assert.equal(logs.entries.length, 0);
    assert.ok(emails);
  });

  it('the hourly window rolls, and 20 per day still applies', async () => {
    const { outbox, clock } = setup();
    let sequence = 0;
    for (let hour = 0; hour < 4; hour += 1) {
      for (let i = 0; i < EMAIL_LIMITS.customerPerHour; i += 1) {
        const result = await orderRow(outbox, { toEmail: 'day@example.test', dedupeKey: `d${sequence += 1}` });
        assert.equal(result, sequence <= EMAIL_LIMITS.customerPerDay ? 'queued' : 'limited_recipient', `email ${sequence}`);
      }
      clock.now += MS.hour + MS.second;
    }
    clock.now += 21 * MS.hour;
    assert.equal(await orderRow(outbox, { toEmail: 'day@example.test', dedupeKey: 'next-day' }), 'queued');
  });

  it('seller alerts have their own limit of 30 per hour and no daily limit', async () => {
    const { outbox } = setup();
    for (let i = 0; i < EMAIL_LIMITS.sellerPerHour; i += 1) {
      assert.equal(await orderRow(outbox, { kind: EMAIL_KINDS.SELLER_PAYMENT_SUBMITTED, toEmail: 'seller@example.test', dedupeKey: `s${i}` }), 'queued');
    }
    assert.equal(await orderRow(outbox, { kind: EMAIL_KINDS.SELLER_PAYMENT_SUBMITTED, toEmail: 'seller@example.test', dedupeKey: 's-extra' }), 'limited_recipient');
  });

  it('contact_inbox is not limited per recipient, but the global hourly cap stops every kind', async () => {
    const { outbox } = setup();
    for (let i = 0; i < EMAIL_LIMITS.globalPerHour; i += 1) {
      assert.equal(await orderRow(outbox, { kind: EMAIL_KINDS.CONTACT_INBOX, toEmail: 'inbox@example.test', dedupeKey: `c${i}` }), 'queued');
    }
    assert.equal(await orderRow(outbox, { toEmail: 'fresh@example.test', dedupeKey: 'g1' }), 'limited_global');
    assert.equal(await orderRow(outbox, { kind: EMAIL_KINDS.SELLER_PAYMENT_SUBMITTED, toEmail: 'seller@example.test', dedupeKey: 'g2' }), 'limited_global');
  });

  it('an over-limit enqueue through the service is logged by kind and outcome only, and never throws', async () => {
    const { outbox, emails, logs } = setup();
    for (let i = 0; i < EMAIL_LIMITS.globalPerHour; i += 1) await orderRow(outbox, { kind: EMAIL_KINDS.CONTACT_INBOX, toEmail: 'inbox@example.test', dedupeKey: `c${i}` });
    const result = await emails.enqueueContactInbox({ inboxEmail: 'inbox@example.test', contactId: 'late', name: 'Asha', email: 'asha@example.test', message: 'Hello' });
    assert.equal(result, 'limited_global');
    assert.deepEqual(logs.entries.map(({ level, message, kind, outcome }) => ({ level, message, kind, outcome })), [
      { level: 'info', message: 'email not queued', kind: 'contact_inbox', outcome: 'limited_global' },
    ]);
  });
});

describe('worker', () => {
  it('renders an order row in its language from the payload and sends it from the relay sender with the support Reply-To', async () => {
    const { outbox, makeWorker } = setup();
    await orderRow(outbox);
    const relay = createFakeRelay();
    await makeWorker(relay).runOnce();
    assert.equal(relay.sent.length, 1);
    const [message] = relay.sent;
    assert.deepEqual([message.fromName, message.to, message.replyTo], ['The Artisan Story', ['buyer@example.test'], SUPPORT_REPLY_TO]);
    assert.match(message.text, /[ऀ-ॿ]/);
    assert.ok(message.text.includes('AS1001') && message.text.includes(`${BASE_URL}/o/token`));
    assert.equal(outbox.rows[0].status, 'sent');
    assert.equal(outbox.rows[0].body, '');
    assert.deepEqual(outbox.rows[0].payload, {}, 'the private link does not stay in the table');
  });

  it('sends a pre-rendered contact row as is, with Reply-To set to the visitor', async () => {
    const { emails, makeWorker } = setup();
    await emails.enqueueContactInbox({ inboxEmail: 'inbox@example.test', contactId: 'c1', name: 'Asha', email: 'asha@example.test', message: 'Hello there' });
    const relay = createFakeRelay();
    await makeWorker(relay).runOnce();
    assert.equal(relay.sent[0].replyTo, 'asha@example.test');
    assert.ok(relay.sent[0].text.includes('Hello there'));
  });

  it('retries on 5xx, timeouts and network errors on the 1 min, 5 min, 30 min, 2 h schedule, then is dead at the 5th attempt', async () => {
    const { outbox, clock, makeWorker } = setup();
    await orderRow(outbox);
    const failures = [relayError('RELAY_TIMEOUT'), relayError('RELAY_UNREACHABLE'), relayError(RELAY_REFUSED, 503), relayError('RELAY_RESPONSE_INVALID', 502), relayError('RELAY_TIMEOUT')];
    const relay = createFakeRelay((_, attempt) => { throw failures[attempt - 1]; });
    const worker = makeWorker(relay);
    const row = outbox.rows[0];
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      await worker.runOnce();
      assert.equal(row.attempts, attempt);
      if (attempt < MAX_ATTEMPTS) {
        assert.equal(row.status, 'queued');
        assert.equal(row.nextAttemptAtMs, clock.now + RETRY_DELAYS_SECONDS[attempt - 1] * MS.second, `delay after attempt ${attempt}`);
        await worker.runOnce();
        assert.equal(relay.sent.length, attempt, 'not sent before its time');
        clock.now = row.nextAttemptAtMs;
      }
    }
    assert.equal(row.status, 'dead');
    assert.equal(row.body, '');
    assert.equal(relay.sent.length, MAX_ATTEMPTS);
    assert.deepEqual([60, 300, 1800, 7200], RETRY_DELAYS_SECONDS);
    assert.equal(retryDelaySeconds(99), 7200);
  });

  it('a relay refusal (4xx, or success false) is dead immediately', async () => {
    for (const status of [400, 422, 200]) {
      const { outbox, makeWorker } = setup();
      await orderRow(outbox);
      const relay = createFakeRelay(() => { throw relayError(RELAY_REFUSED, status); });
      await makeWorker(relay).runOnce();
      assert.equal(outbox.rows[0].status, 'dead', `status ${status}`);
      assert.equal(outbox.rows[0].attempts, 1);
      assert.equal(outbox.rows[0].lastErrorCode, RELAY_REFUSED);
    }
  });

  it('a row with a bad payload is dead at once without calling the relay', async () => {
    const { outbox, makeWorker } = setup();
    await orderRow(outbox, { payload: { reference: 'AS1' } });
    const relay = createFakeRelay();
    await makeWorker(relay).runOnce();
    assert.equal(relay.sent.length, 0);
    assert.equal(outbox.rows[0].lastErrorCode, 'PAYLOAD_INVALID');
    assert.equal(outbox.rows[0].status, 'dead');
  });

  it('recovers a row whose worker died: after the lease expires another run sends it', async () => {
    const { outbox, clock, makeWorker } = setup();
    await orderRow(outbox);
    await outbox.claimDue(10, WORKER_LEASE_SECONDS);
    const relay = createFakeRelay();
    await makeWorker(relay).runOnce();
    assert.equal(relay.sent.length, 0, 'still leased');
    clock.now += (WORKER_LEASE_SECONDS + 1) * MS.second;
    await makeWorker(relay).runOnce();
    assert.equal(relay.sent.length, 1);
    assert.equal(outbox.rows[0].attempts, 2);
    assert.equal(outbox.rows[0].status, 'sent');
  });

  it('two workers running at once never send the same row twice', async () => {
    const { outbox, makeWorker } = setup();
    for (let i = 0; i < 5; i += 1) await orderRow(outbox, { toEmail: `b${i}@example.test`, dedupeKey: `p${i}` });
    const relay = createFakeRelay();
    await Promise.all([makeWorker(relay).runOnce(), makeWorker(relay).runOnce()]);
    assert.equal(relay.sent.length, 5);
    assert.equal(new Set(relay.sent.map((message) => message.to[0])).size, 5);
    assert.ok(outbox.rows.every((row) => row.status === 'sent' && row.attempts === 1));
  });

  it('one run claims at most a batch of 10', async () => {
    const { outbox, makeWorker } = setup();
    for (let i = 0; i < 12; i += 1) await orderRow(outbox, { toEmail: `b${i}@example.test`, dedupeKey: `p${i}` });
    const relay = createFakeRelay();
    await makeWorker(relay).runOnce();
    assert.equal(relay.sent.length, 10);
  });

  it('a relay that is down never makes runOnce throw, and nothing is lost', async () => {
    const { outbox, makeWorker } = setup();
    await orderRow(outbox);
    const relay = createFakeRelay(() => { throw relayError('RELAY_UNREACHABLE'); });
    await assert.doesNotReject(makeWorker(relay).runOnce());
    assert.equal(outbox.rows[0].status, 'queued');
  });

  it('survives a failing outbox without throwing', async () => {
    const { outbox, makeWorker } = setup();
    outbox.claimDue = async () => { throw new Error('db down'); };
    await assert.doesNotReject(makeWorker(createFakeRelay()).runOnce());
  });

  it('logs one summary line per run that did work, with counts and ids only', async () => {
    const { outbox, logs, makeWorker } = setup();
    await makeWorker(createFakeRelay()).runOnce();
    assert.equal(logs.entries.filter((e) => e.message === 'email worker run').length, 0, 'an idle run logs nothing');
    await orderRow(outbox, { toEmail: 'private.person@example.test' });
    await makeWorker(createFakeRelay()).runOnce();
    const summaries = logs.entries.filter((e) => e.message === 'email worker run');
    assert.equal(summaries.length, 1);
    assert.deepEqual([summaries[0].claimed, summaries[0].sent, summaries[0].retried, summaries[0].dead], [1, 1, 0, 0]);
    const serialized = JSON.stringify(logs.entries);
    for (const secret of ['private.person', 'AS1001', 'kala-ghar', '/o/token']) assert.ok(!serialized.includes(secret), secret);
  });

  it('starts and stops cleanly: the interval is unref-ed, cleared on stop, and start twice makes one timer', async () => {
    const { outbox, contacts, logs } = setup();
    const created = [];
    const timers = {
      setInterval: (fn, ms) => { const timer = { fn, ms, unrefCalled: false, unref() { this.unrefCalled = true; } }; created.push(timer); return timer; },
      clearInterval: (timer) => { timer.cleared = true; },
    };
    const worker = createOutboxWorker({ outbox, contacts, relay: createFakeRelay(), baseUrl: BASE_URL, logger: logs, timers });
    worker.start();
    worker.start();
    assert.equal(created.length, 1);
    assert.equal(created[0].ms, 15_000);
    assert.equal(created[0].unrefCalled, true);
    await worker.stop();
    assert.equal(created[0].cleared, true);
  });
});

describe('retention', () => {
  it('deletes only sent and dead rows older than 30 days, plus old contact messages, once a day', async () => {
    const { outbox, contacts, clock, makeWorker } = setup();
    const keep = async (status, ageDays) => {
      await orderRow(outbox, { dedupeKey: `r-${status}-${ageDays}`, toEmail: `${status}${ageDays}@example.test` });
      const row = outbox.rows.at(-1);
      Object.assign(row, { status, createdAtMs: clock.now - ageDays * MS.day, nextAttemptAtMs: clock.now + MS.day });
      return row;
    };
    const oldSent = await keep('sent', RETENTION_DAYS + 1);
    const oldDead = await keep('dead', RETENTION_DAYS + 5);
    const oldQueued = await keep('queued', RETENTION_DAYS + 5);
    const youngSent = await keep('sent', 2);
    await contacts.insert({ name: 'Old', email: 'old@example.test', message: 'm' });
    contacts.rows[0].createdAtMs = clock.now - (RETENTION_DAYS + 1) * MS.day;
    await contacts.insert({ name: 'New', email: 'new@example.test', message: 'm' });
    const worker = makeWorker(createFakeRelay());
    await worker.runOnce();
    assert.deepEqual(outbox.rows.map((r) => r.id).sort(), [oldQueued.id, youngSent.id].sort());
    assert.ok(![oldSent, oldDead].some((r) => outbox.rows.includes(r)));
    assert.deepEqual(contacts.rows.map((r) => r.name), ['New']);

    await keep('sent', RETENTION_DAYS + 1);
    await worker.runOnce();
    assert.equal(outbox.rows.length, 3, 'not repeated within the day');
    clock.now += MS.day + MS.second;
    await worker.runOnce();
    assert.deepEqual(outbox.rows.map((r) => r.id), [youngSent.id], 'repeated the next day (the old queued row was due, sent, then purged)');
  });
});
