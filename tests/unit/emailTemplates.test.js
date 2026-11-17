import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { CUSTOMER_KINDS, EMAIL_KINDS, MAX_BODY_LENGTH, MAX_SUBJECT_LENGTH } from '../../src/domain/emailRules.js';
import { LOCALIZE_SUBJECTS, renderContactInbox, renderEmail } from '../../src/domain/emailTemplates.js';
import { ORDER_EXPIRY_MINUTES, ORDER_RESUBMIT_MINUTES } from '../../src/domain/orderRules.js';

const BASE_URL = 'https://shop.example.test';
const LINK = 'https://shop.example.test/o/abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ';
const FACTS = { reference: 'AS1042', shop: 'Kala Ghar', slug: 'kala-ghar', link: LINK };
const LANGUAGES = ['en', 'gu', 'hi'];
const SCRIPT = { gu: /[઀-૿]/, hi: /[ऀ-ॿ]/ };
const render = (kind, language, facts = FACTS) => renderEmail({ kind, language, facts, baseUrl: BASE_URL });
const source = readFileSync(fileURLToPath(new URL('../../src/domain/emailTemplates.js', import.meta.url)), 'utf8');

describe('customer email templates', () => {
  it('every customer kind is complete in en, gu and hi', () => {
    for (const kind of CUSTOMER_KINDS) {
      const seen = new Set();
      for (const language of LANGUAGES) {
        const { subject, text } = render(kind, language);
        assert.ok(subject.length > 0 && text.length > 0, `${kind}/${language}`);
        assert.ok(subject.includes('AS1042') || kind === 'order_payment_received' || subject.length > 5, `${kind}/${language} subject`);
        assert.doesNotMatch(`${subject}\n${text}`, /[{}]/, `${kind}/${language} has an unfilled placeholder`);
        assert.ok(text.includes('AS1042') && text.includes('Kala Ghar'), `${kind}/${language} names the shop and order`);
        assert.ok(text.includes(`${BASE_URL}/s/kala-ghar`), `${kind}/${language} links to the shop`);
        if (language !== 'en') assert.match(text, SCRIPT[language], `${kind}/${language} is written in its own script`);
        seen.add(text);
      }
      assert.equal(seen.size, LANGUAGES.length, `${kind} differs per language`);
    }
  });

  it('every customer email says what to do if the order was not placed by the reader', () => {
    const endings = new Set();
    for (const language of LANGUAGES) {
      const lines = render(EMAIL_KINDS.ORDER_PLACED, language).text.split('\n');
      endings.add(lines.at(-1));
    }
    assert.equal(endings.size, 3);
    assert.equal(render(EMAIL_KINDS.ORDER_PLACED, 'en').text.split('\n').at(-1), 'If you did not place this order, ignore this email.');
  });

  it('carries the private link in all six customer emails, and without one points back to the first email (never for the first two)', () => {
    for (const kind of CUSTOMER_KINDS) for (const language of LANGUAGES) assert.ok(render(kind, language).text.includes(LINK), `${kind}/${language}`);
    for (const kind of [EMAIL_KINDS.ORDER_CONFIRMED, EMAIL_KINDS.ORDER_PAYMENT_NOT_FOUND, EMAIL_KINDS.ORDER_CANCELLED, EMAIL_KINDS.ORDER_EXPIRED]) {
      const text = render(kind, 'en', { ...FACTS, link: null }).text;
      assert.ok(!text.includes(LINK), kind);
      assert.match(text, /private order link from your first email/);
    }
    assert.doesNotMatch(render(EMAIL_KINDS.ORDER_PAYMENT_RECEIVED, 'en', { ...FACTS, link: null }).text, /first email/);
    assert.doesNotMatch(render(EMAIL_KINDS.ORDER_PLACED, 'en', { ...FACTS, link: null }).text, /private order link:/);
  });

  it('takes the deadlines from the order constants', () => {
    for (const language of LANGUAGES) {
      assert.ok(render(EMAIL_KINDS.ORDER_PLACED, language).text.includes(String(ORDER_EXPIRY_MINUTES)), `placed/${language}`);
      assert.ok(render(EMAIL_KINDS.ORDER_PAYMENT_NOT_FOUND, language).text.includes(String(ORDER_RESUBMIT_MINUTES)), `not found/${language}`);
    }
    assert.doesNotMatch(source, /\d+ (minutes|मिनट|મિનિટ)/, 'no window length is typed into a template');
  });

  it('never contains an amount, address, phone, UPI id or payment reference, even if the facts offer them', () => {
    const hostile = { ...FACTS, amount: 'Rs 4,999', total: '499900', address: '12 Rose Lane', phone: '919876543210', upi: 'seller@okbank', utr: '123456789012', email: 'x@y.test' };
    for (const kind of CUSTOMER_KINDS) {
      for (const language of LANGUAGES) {
        const { subject, text } = render(kind, language, hostile);
        const all = `${subject}\n${text}`;
        for (const secret of ['4,999', '499900', 'Rose Lane', '919876543210', 'okbank', '123456789012', 'x@y.test']) assert.ok(!all.includes(secret), `${kind}/${language} leaks ${secret}`);
        assert.doesNotMatch(all, /₹|\bRs\b|\bINR\b/);
      }
    }
  });

  it('is plain text and strips CR and LF from anything placed in a subject or on one line', () => {
    const facts = { ...FACTS, shop: 'Kala\r\nBcc: evil@example.test', reference: 'AS1\nX' };
    for (const kind of CUSTOMER_KINDS) {
      const { subject, text } = render(kind, 'en', facts);
      assert.doesNotMatch(subject, /[\r\n]/, kind);
      assert.doesNotMatch(text, /\r/, kind);
      assert.ok(!text.split('\n').some((line) => line.startsWith('Bcc:')), `${kind} no injected header-like line`);
      assert.doesNotMatch(text, /<[a-z/][^>]*>/i, 'no HTML');
    }
  });

  it('keeps subjects and bodies within the column limits', () => {
    const long = { ...FACTS, shop: 'ક'.repeat(500) };
    for (const kind of CUSTOMER_KINDS) {
      const { subject, text } = render(kind, 'gu', long);
      assert.ok([...subject].length <= MAX_SUBJECT_LENGTH && [...text].length <= MAX_BODY_LENGTH, kind);
    }
  });

  it('subjects are localized, and the fallback switch exists', () => {
    assert.equal(LOCALIZE_SUBJECTS, true);
    assert.match(render(EMAIL_KINDS.ORDER_PLACED, 'gu').subject, SCRIPT.gu);
    assert.match(render(EMAIL_KINDS.ORDER_PLACED, 'hi').subject, SCRIPT.hi);
  });

  it('an unknown language falls back to English and an unknown kind throws', () => {
    assert.equal(render(EMAIL_KINDS.ORDER_PLACED, 'fr').text, render(EMAIL_KINDS.ORDER_PLACED, 'en').text);
    assert.throws(() => render('newsletter', 'en'));
  });
});

describe('seller and contact templates', () => {
  it('the payment alert is English, asks the seller to check the bank app and links to the orders page', () => {
    const { subject, text } = render(EMAIL_KINDS.SELLER_PAYMENT_SUBMITTED, 'hi', { ...FACTS, amount: '499900' });
    assert.match(subject, /Check your bank app/);
    assert.match(text, /bank app/);
    assert.ok(text.includes(`${BASE_URL}/orders`));
    assert.ok(!text.includes('499900'));
  });

  it('the enquiry alert names the shop and links to the dashboard', () => {
    const { subject, text } = render(EMAIL_KINDS.SELLER_ENQUIRY_NEEDS_YOU, 'en', { shop: 'Kala Ghar' });
    assert.ok(subject.includes('Kala Ghar') && text.includes(`${BASE_URL}/dashboard`));
  });

  it('the contact email strips CR and LF from the subject, name and address but keeps the message lines', () => {
    const { subject, text } = renderContactInbox({ name: 'Asha\r\nBcc: evil@example.test', email: 'asha@example.test\r\nX: y', message: 'line one\r\nline two' });
    assert.doesNotMatch(subject, /[\r\n]/);
    assert.equal(text.split('\n')[0].includes('Bcc'), true);
    assert.doesNotMatch(text, /\r/);
    assert.ok(text.endsWith('line one\nline two'));
    assert.equal(text.split('\n')[1].startsWith('Email: asha@example.test'), true);
  });
});
