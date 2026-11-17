import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CONTACT_ADDRESS_LIMITS, CONTACT_IP_LIMITS } from '../../src/domain/contactRules.js';
import { createEmailService } from '../../src/email/emailService.js';
import { createOutboxWorker } from '../../src/email/outboxWorker.js';
import { createContactService } from '../../src/services/contactService.js';
import { startAuthApp } from '../helpers/appHarness.js';
import { createFakeContacts, createFakeOutbox, createFakeRelay } from '../helpers/emailFakes.js';
import { createLogCollector } from '../helpers/productFakes.js';

const BASE_URL = 'https://shop.example.test';
const INBOX = 'inbox@example.test';
const GOOD = { name: 'Asha Patel', email: 'asha@example.test', message: 'Hello, I would like to know more.' };
const HIGH = { windowMs: 60_000, limit: 1000 };

async function startContactApp({ inboxEmail = INBOX, ipLimit = HIGH, emailsOverride } = {}) {
  const clock = { now: Date.UTC(2026, 10, 17, 9, 0, 0) };
  const outbox = createFakeOutbox({ clock });
  const contacts = createFakeContacts({ clock });
  const logs = createLogCollector();
  const emails = emailsOverride ?? createEmailService({ outbox, owners: { findById: async () => null }, logger: logs, baseUrl: BASE_URL });
  const contact = createContactService({ contacts, emails, inboxEmail, logger: logs, now: () => clock.now });
  const app = await startAuthApp({ extraServices: { contact }, appDeps: { contactRateLimits: { ip: ipLimit } } });
  const post = (form, extra = {}) => app.request('/contact', { method: 'POST', form, ...extra });
  return { ...app, clock, outbox, contacts, logs, post };
}

describe('GET /contact', () => {
  it('shows an accessible, mobile-friendly form with a counter, a hidden trap, no-store and no inline script or style', async () => {
    const app = await startContactApp();
    try {
      const res = await app.request('/contact');
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('cache-control'), 'no-store');
      assert.match(res.text, /<html lang="en">/);
      assert.match(res.text, /<label for="name">/);
      assert.match(res.text, /<input type="text" id="name" name="name" autocomplete="name" required maxlength="80"/);
      assert.match(res.text, /<input type="email" id="email" name="email" autocomplete="email" inputmode="email"/);
      assert.match(res.text, /<textarea id="message" name="message"[^>]*maxlength="2000"[^>]*data-counter="message-count"/);
      assert.match(res.text, /id="message-hint" class="hint">Up to 2000 characters\./);
      assert.match(res.text, /<div class="contact-trap" aria-hidden="true">[\s\S]*<input type="text" id="website" name="website" tabindex="-1" autocomplete="off"/);
      assert.match(res.text, /<script src="\/js\/char-counter.js" defer><\/script>/);
      assert.doesNotMatch(res.text, /<script(?![^>]*\ssrc=)/);
      assert.doesNotMatch(res.text, /\sstyle=|\sonclick=|<style/);
      assert.doesNotMatch(res.text, /role="alert"/, 'no error summary on a fresh form');
      assert.match(res.headers.get('content-security-policy'), /script-src 'self'/);
    } finally {
      await app.close();
    }
  });

  it('is linked from the footer of the login and signup pages and the confirmation page', async () => {
    const app = await startContactApp();
    try {
      for (const path of ['/login', '/signup', '/contact', '/contact/sent']) {
        const res = await app.request(path);
        assert.match(res.text, /<footer class="site-footer">\s*<nav aria-label="Site">\s*<a href="\/contact">Contact us<\/a>/, path);
      }
    } finally {
      await app.close();
    }
  });
});

describe('POST /contact', () => {
  it('saves the message, queues one email to the inbox with Reply-To set to the visitor, and redirects to a page that does not echo the address', async () => {
    const app = await startContactApp();
    try {
      const res = await app.post(GOOD);
      assert.equal(res.status, 303);
      assert.equal(res.location, '/contact/sent');
      assert.equal(app.contacts.rows.length, 1);
      assert.deepEqual([app.contacts.rows[0].name, app.contacts.rows[0].email, app.contacts.rows[0].message], [GOOD.name, GOOD.email, GOOD.message]);
      assert.equal(app.outbox.rows.length, 1);
      const [row] = app.outbox.rows;
      assert.deepEqual([row.kind, row.toEmail, row.replyTo, row.storeId], ['contact_inbox', INBOX, GOOD.email, null]);
      assert.ok(row.body.includes(GOOD.message) && row.subject.includes('Asha Patel'));
      const sent = await app.request('/contact/sent');
      assert.equal(sent.status, 200);
      assert.equal(sent.headers.get('cache-control'), 'no-store');
      assert.match(sent.text, /What happens next/);
      assert.match(sent.text, /role="status"/);
      assert.ok(!sent.text.includes(GOOD.email) && !sent.text.includes('Asha'));
      assert.match(sent.text, /href="\/login"/);
    } finally {
      await app.close();
    }
  });

  it('the worker then sends it with Reply-To set to the visitor, so the owner can simply reply', async () => {
    const app = await startContactApp();
    try {
      await app.post(GOOD);
      const relay = createFakeRelay();
      const worker = createOutboxWorker({ outbox: app.outbox, contacts: app.contacts, relay, baseUrl: BASE_URL, logger: app.logs, clock: () => app.clock.now });
      await worker.runOnce();
      assert.deepEqual([relay.sent[0].to, relay.sent[0].replyTo], [[INBOX], GOOD.email]);
    } finally {
      await app.close();
    }
  });

  it('uses the fallback inbox as configured, and still saves the message when there is no inbox at all', async () => {
    const withFallback = await startContactApp({ inboxEmail: 'owner.notify@example.test' });
    const noInbox = await startContactApp({ inboxEmail: null });
    try {
      await withFallback.post(GOOD);
      assert.equal(withFallback.outbox.rows[0].toEmail, 'owner.notify@example.test');
      assert.equal((await noInbox.post(GOOD)).status, 303);
      assert.equal(noInbox.contacts.rows.length, 1);
      assert.equal(noInbox.outbox.rows.length, 0);
    } finally {
      await withFallback.close();
      await noInbox.close();
    }
  });

  it('never fails the submit because of email: an outbox that throws, or an email service that throws, still gives the confirmation', async () => {
    const down = await startContactApp();
    const broken = await startContactApp({ emailsOverride: { enqueueContactInbox: async () => { throw new Error('email exploded'); } } });
    try {
      down.outbox.failNextEnqueue = true;
      assert.equal((await down.post(GOOD)).status, 303);
      assert.equal(down.contacts.rows.length, 1);
      assert.equal((await broken.post(GOOD)).status, 303);
      assert.equal(broken.contacts.rows.length, 1);
      assert.ok(broken.logs.entries.some((entry) => entry.message === 'contact email failed'));
    } finally {
      await down.close();
      await broken.close();
    }
  });

  it('validates strictly and re-renders with an error summary, per-field errors and what was typed (escaped)', async () => {
    const app = await startContactApp();
    try {
      const res = await app.post({ name: '', email: 'nope', message: '<script>alert(1)</script>'.padEnd(2100, 'x') });
      assert.equal(res.status, 400);
      assert.match(res.text, /<div class="alert error-summary" role="alert" id="error-summary">/);
      for (const field of ['name', 'email', 'message']) {
        assert.match(res.text, new RegExp(`<a href="#${field}">`), `${field} summary link`);
        assert.match(res.text, new RegExp(`id="${field}"[^>]*aria-invalid="true"`), `${field} marked invalid`);
        assert.match(res.text, new RegExp(`aria-describedby="${field}-(hint|error)[^"]*${field}-error"|aria-describedby="${field}-error"`), `${field} described by its error`);
        assert.match(res.text, new RegExp(`id="${field}-error" class="error-text"><span class="status-word">Error:</span>`), `${field} text status, not colour alone`);
      }
      assert.ok(!res.text.includes('<script>alert(1)'), 'echoed text is escaped');
      assert.equal(app.contacts.rows.length + app.outbox.rows.length, 0);
    } finally {
      await app.close();
    }
  });

  it('rejects unknown keys, empty and whitespace-only fields, and over-long input, saving nothing', async () => {
    const app = await startContactApp();
    try {
      assert.equal((await app.post({ ...GOOD, store_id: 'x' })).status, 400);
      assert.equal((await app.post({ ...GOOD, to: 'victim@example.test' })).status, 400);
      assert.equal((await app.post({ ...GOOD, name: '   ' })).status, 400);
      assert.equal((await app.post({ ...GOOD, message: ' \n ' })).status, 400);
      assert.equal((await app.post({ ...GOOD, name: 'n'.repeat(81) })).status, 400);
      assert.equal((await app.post({ ...GOOD, message: 'm'.repeat(2001) })).status, 400);
      assert.equal((await app.post({ ...GOOD, email: `${'a'.repeat(250)}@b.co` })).status, 400);
      assert.equal((await app.post({ name: GOOD.name, email: GOOD.email })).status, 400);
      assert.equal(app.contacts.rows.length + app.outbox.rows.length, 0);
      assert.equal((await app.post({ ...GOOD, message: 'm'.repeat(2000) })).status, 303);
    } finally {
      await app.close();
    }
  });

  it('refuses CR and LF in the name and the address (header injection) and saves and sends nothing', async () => {
    const app = await startContactApp();
    try {
      const attempts = [
        { ...GOOD, name: 'Asha\r\nBcc: victim@example.test' },
        { ...GOOD, name: 'Asha\nSubject: spam' },
        { ...GOOD, email: 'asha@example.test\r\nBcc: victim@example.test' },
        { ...GOOD, email: 'asha@example.test\nCc: victim@example.test' },
        { ...GOOD, email: 'victim@example.test, asha@example.test' },
      ];
      for (const attempt of attempts) assert.equal((await app.post(attempt)).status, 400, JSON.stringify(attempt).slice(0, 60));
      assert.equal(app.contacts.rows.length + app.outbox.rows.length, 0);
    } finally {
      await app.close();
    }
  });

  it('a multi-line message is kept, and no header-like line can reach the subject', async () => {
    const app = await startContactApp();
    try {
      await app.post({ ...GOOD, message: 'line one\r\nBcc: victim@example.test\r\nline three' });
      const [row] = app.outbox.rows;
      assert.doesNotMatch(row.subject, /[\r\n]/);
      assert.doesNotMatch(row.body, /\r/);
      assert.ok(row.body.includes('line one\nBcc: victim@example.test\nline three'));
      assert.deepEqual(row.replyTo, GOOD.email);
    } finally {
      await app.close();
    }
  });

  it('the trap field: filled means the normal success page and NOTHING is saved or sent', async () => {
    const app = await startContactApp();
    try {
      const res = await app.post({ ...GOOD, website: 'http://spam.example' });
      assert.equal(res.status, 303);
      assert.equal(res.location, '/contact/sent');
      assert.equal(app.contacts.rows.length, 0);
      assert.equal(app.outbox.rows.length, 0);
      assert.equal((await app.post({ ...GOOD, website: '' })).status, 303);
      assert.equal(app.contacts.rows.length, 1);
      assert.ok(app.logs.entries.some((entry) => entry.message === 'contact trap field filled'));
      assert.ok(!JSON.stringify(app.logs.entries).includes('spam.example'));
    } finally {
      await app.close();
    }
  });

  it('the Origin check applies: a cross-origin post is refused with 403 and nothing happens', async () => {
    const app = await startContactApp();
    try {
      assert.equal((await app.post(GOOD, { origin: 'http://evil.example' })).status, 403);
      assert.equal((await app.post(GOOD, { origin: null })).status, 403);
      assert.equal(app.contacts.rows.length + app.outbox.rows.length, 0);
    } finally {
      await app.close();
    }
  });

  it('limits each IP (in memory), counting trap submissions too, answering 429', async () => {
    const app = await startContactApp({ ipLimit: { windowMs: 60_000, limit: 2 } });
    try {
      assert.equal((await app.post({ ...GOOD, email: 'one@example.test' })).status, 303);
      assert.equal((await app.post({ ...GOOD, email: 'two@example.test', website: 'x' })).status, 303);
      assert.equal((await app.post({ ...GOOD, email: 'three@example.test' })).status, 429);
      assert.equal(app.contacts.rows.length, 1);
    } finally {
      await app.close();
    }
  });

  it('limits each address from the saved messages (so it survives a restart): 3 per hour, case-insensitive, then it frees up', async () => {
    const app = await startContactApp();
    try {
      for (let i = 0; i < CONTACT_ADDRESS_LIMITS.limit; i += 1) assert.equal((await app.post({ ...GOOD, email: i === 1 ? 'ASHA@example.test' : GOOD.email })).status, 303);
      const blocked = await app.post(GOOD);
      assert.equal(blocked.status, 429);
      assert.equal(app.contacts.rows.length, CONTACT_ADDRESS_LIMITS.limit);
      assert.equal((await app.post({ ...GOOD, email: 'someone.else@example.test' })).status, 303);
      app.clock.now += CONTACT_ADDRESS_LIMITS.windowMs + 1000;
      assert.equal((await app.post(GOOD)).status, 303);
    } finally {
      await app.close();
    }
  });

  it('exports the documented limits', () => {
    assert.deepEqual([CONTACT_IP_LIMITS.limit, CONTACT_ADDRESS_LIMITS.limit], [5, 3]);
  });

  it('logs ids only: never the name, address or message', async () => {
    const app = await startContactApp();
    try {
      await app.post(GOOD);
      const serialized = JSON.stringify(app.logs.entries);
      for (const secret of ['Asha', 'asha@example.test', 'Hello, I would', INBOX]) assert.ok(!serialized.includes(secret), secret);
    } finally {
      await app.close();
    }
  });
});
