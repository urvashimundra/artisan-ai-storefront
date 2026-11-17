import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CUSTOMER_KINDS, EMAIL_KINDS, SELLER_KINDS, WORKER_BATCH_SIZE } from '../../src/domain/emailRules.js';
import { renderEmail } from '../../src/domain/emailTemplates.js';
import { createEmailService } from '../../src/email/emailService.js';
import { createOutboxWorker } from '../../src/email/outboxWorker.js';
import { createLinkCipher } from '../../src/lib/linkCipher.js';
import { createFakeContacts, createFakeOutbox, createFakeRelay } from '../helpers/emailFakes.js';
import { createLogCollector } from '../helpers/productFakes.js';

const BASE_URL = 'https://kala-ghar.example.test';
const ORIGIN = new URL(BASE_URL).origin;
const OTHER_BASE_URL = 'https://preview-shop.example.test';
const LANGUAGES = ['en', 'gu', 'hi'];
const START = Date.UTC(2026, 10, 17, 9, 0, 0);
const TOKEN = 'T'.repeat(43);
const URL_PATTERN = /https?:\/\/\S+/g;
const cipher = createLinkCipher('A'.repeat(43));
const STORE = { id: '22222222-2222-4222-8222-222222222222', ownerId: '11111111-1111-4111-8111-111111111111', name: 'Kala Ghar', notifyEnquiryEmail: true };
const OWNER = { id: STORE.ownerId, email: 'owner@example.test' };
const FACTS = { reference: 'AS1042', shop: 'Kala Ghar', slug: 'kala-ghar' };

/** Every URL that appears in the given texts, reduced to its origin. */
function originsIn(...texts) {
  return texts.flatMap((text) => text.match(URL_PATTERN) ?? []).map((url) => new URL(url).origin);
}

function assertOnlyOrigin(texts, origin, label) {
  for (const found of originsIn(...texts)) assert.equal(found, origin, `${label} links only to ${origin}`);
}

function setup(baseUrl = BASE_URL) {
  const clock = { now: START };
  const outbox = createFakeOutbox({ clock });
  const contacts = createFakeContacts({ clock });
  const logs = createLogCollector();
  const owners = { findById: async (id) => (id === OWNER.id ? OWNER : null) };
  const emails = createEmailService({ outbox, owners, logger: logs, baseUrl, kick: () => {} });
  const makeWorker = (relay, worker = { baseUrl, linkCipher: cipher }) =>
    createOutboxWorker({ outbox, contacts, relay, baseUrl: worker.baseUrl, logger: logs, linkCipher: worker.linkCipher, clock: () => clock.now });
  return { outbox, emails, makeWorker };
}

function enqueueOrderRow(outbox, kind, language, index) {
  return outbox.enqueueNow({
    storeId: STORE.id, kind, toEmail: `buyer-${index}@example.test`, language, subject: '', body: '',
    payload: { ...FACTS, token_enc: cipher.encrypt(TOKEN) }, dedupeKey: `${kind}:${language}:${index}`,
  });
}

describe('email links use only the configured BASE_URL origin', () => {
  it('renders every customer and seller kind in every language with links to that origin only', () => {
    const facts = { ...FACTS, link: `${BASE_URL}/o/${TOKEN}` };
    for (const kind of CUSTOMER_KINDS) {
      for (const language of LANGUAGES) {
        for (const link of [facts.link, null]) {
          const { subject, text } = renderEmail({ kind, language, facts: { ...facts, link }, baseUrl: BASE_URL });
          assertOnlyOrigin([subject, text], ORIGIN, `${kind}/${language}`);
          assert.ok(text.includes(`${ORIGIN}/s/kala-ghar`), `${kind}/${language} links to the shop`);
          if (link) assert.ok(text.includes(link), `${kind}/${language} carries the private link`);
        }
      }
    }
    for (const kind of SELLER_KINDS) {
      const { subject, text } = renderEmail({ kind, language: 'en', facts, baseUrl: BASE_URL });
      assertOnlyOrigin([subject, text], ORIGIN, kind);
      assert.ok(originsIn(text).length > 0, `${kind} carries a link`);
    }
  });

  it('order rows queued by the database and sent by the worker link only to the configured origin', async () => {
    const { outbox, makeWorker } = setup();
    let index = 0;
    for (const kind of CUSTOMER_KINDS) {
      for (const language of LANGUAGES) enqueueOrderRow(outbox, kind, language, (index += 1));
    }
    const relay = createFakeRelay();
    const worker = makeWorker(relay);
    for (let run = 0; run < Math.ceil(index / WORKER_BATCH_SIZE); run += 1) await worker.runOnce();
    assert.equal(relay.sent.length, index, 'every order row was sent');
    for (const message of relay.sent) {
      assertOnlyOrigin([message.subject, message.text], ORIGIN, 'order email');
      assert.ok(message.text.includes(`${ORIGIN}/o/${TOKEN}`), 'the private link is built from the configured origin');
    }
  });

  it('a seller enquiry alert queued by the app stores a body with the configured origin only, and sends it unchanged', async () => {
    const { outbox, emails, makeWorker } = setup();
    assert.equal(await emails.enqueueSellerEnquiryAlert(STORE, 'enquiry-1'), 'queued');
    const [{ subject, body }] = outbox.rows;
    assertOnlyOrigin([subject, body], ORIGIN, 'queued seller alert');
    const relay = createFakeRelay();
    await makeWorker(relay).runOnce();
    assert.deepEqual([relay.sent[0].subject, relay.sent[0].text], [subject, body]);
  });

  it('the worker sends a stored body unchanged, even when its own BASE_URL differs', async () => {
    const { outbox, makeWorker } = setup();
    const stored = `Open ${BASE_URL}/s/kala-ghar for the shop.\nNothing is rendered again.`;
    outbox.enqueueNow({
      storeId: STORE.id, kind: EMAIL_KINDS.SELLER_ENQUIRY_NEEDS_YOU, toEmail: OWNER.email, language: 'en',
      subject: 'A customer enquiry needs you: Kala Ghar', body: stored, payload: {}, dedupeKey: 'stored-body',
    });
    const relay = createFakeRelay();
    await makeWorker(relay, { baseUrl: OTHER_BASE_URL, linkCipher: null }).runOnce();
    assert.equal(relay.sent[0].text, stored);
    assert.ok(!relay.sent[0].text.includes(OTHER_BASE_URL), 'the worker never rewrites a stored link');
  });

  it('a worker started with another BASE_URL builds order links from that BASE_URL only', async () => {
    const { outbox, makeWorker } = setup();
    enqueueOrderRow(outbox, EMAIL_KINDS.ORDER_CONFIRMED, 'en', 1);
    const relay = createFakeRelay();
    await makeWorker(relay, { baseUrl: OTHER_BASE_URL, linkCipher: cipher }).runOnce();
    assertOnlyOrigin([relay.sent[0].text], new URL(OTHER_BASE_URL).origin, 'order confirmed');
  });
});
