import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { STORE_FORM, signupAndLogin } from '../helpers/appHarness.js';
import { ASK, call, finalAnswer, startAssistantApp, turn } from '../helpers/assistantApp.js';

const run = async (options, fn) => {
  const t = await startAssistantApp(options);
  try {
    await fn(t);
  } finally {
    await t.close();
  }
};
/** Asks a question and lets the assistant finish it. */
const asked = async (t, form = ASK) => {
  const token = t.tokenOf(await t.ask(form));
  await t.answer(token);
  return { token, enquiry: t.enquiryRepo.rows.at(-1) };
};
const post = (t, path, form = {}, extra = {}) => t.owner(path, { method: 'POST', form, ...extra });
const hrefOf = (html) => /href="(https:\/\/wa\.me\/[^"]+)"/.exec(html)?.[1];

describe('seller inbox: guard stack and scoping', () => {
  it('applies login, no-store and the Origin check to every route', () => run({ script: [finalAnswer('needs_seller', 'Not sure.')] }, async (t) => {
    const { enquiry } = await asked(t);
    for (const path of ['/enquiries', `/enquiries/${enquiry.id}`]) {
      assert.equal((await t.request(path)).location, '/login');
      const res = await t.owner(path);
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('cache-control'), 'no-store');
    }
    for (const action of ['reply', 'handled']) {
      assert.equal((await t.request(`/enquiries/${enquiry.id}/${action}`, { method: 'POST', form: { reply: 'x' } })).location, '/login');
      assert.equal((await post(t, `/enquiries/${enquiry.id}/${action}`, { reply: 'x' }, { origin: 'https://evil.test' })).status, 403);
    }
    assert.equal(enquiry.status, 'needs_you');
    assert.equal(enquiry.sellerReply, null);
  }));

  it('owner B cannot read or change owner A enquiries, and sees an empty inbox and counter', () => run({ script: [finalAnswer('needs_seller', 'Not sure.')] }, async (t) => {
    const { enquiry } = await asked(t);
    const cookieB = await signupAndLogin(t, 'b@example.com');
    await t.request('/store/new', { method: 'POST', cookie: cookieB, form: { ...STORE_FORM, slug: 'other-shop', name: 'Other' } });
    const asB = (path, extra = {}) => t.request(path, { cookie: cookieB, ...extra });
    assert.doesNotMatch((await asB('/enquiries')).text, /Asha Patel/);
    assert.equal((await asB(`/enquiries/${enquiry.id}`)).status, 404);
    assert.equal((await asB(`/enquiries/${enquiry.id}/reply`, { method: 'POST', form: { reply: 'hijack' } })).status, 404);
    assert.equal((await asB(`/enquiries/${enquiry.id}/handled`, { method: 'POST' })).status, 404);
    assert.equal(enquiry.sellerReply, null);
    assert.equal(enquiry.status, 'needs_you');
    assert.doesNotMatch((await asB('/dashboard')).text, /need you/);
  }));

  it('strict schemas reject a store id in the reply body', () => run({ script: [finalAnswer('needs_seller', 'Not sure.')] }, async (t) => {
    const { enquiry } = await asked(t);
    assert.equal((await post(t, `/enquiries/${enquiry.id}/reply`, { reply: 'Hi', store_id: t.store.id })).status, 400);
    assert.equal(enquiry.sellerReply, null);
  }));

  it('an unknown or malformed id is a 404', () => run({}, async (t) => {
    for (const id of ['nope', '00000000-0000-4000-8000-000000000000']) assert.equal((await t.owner(`/enquiries/${id}`)).status, 404, id);
  }));
});

describe('seller inbox: list, filters, counter', () => {
  it('lists newest first with text statuses, filters by status with links, and counts needs_you on the dashboard', () => run({
    script: [finalAnswer('answered', 'Yes we ship.'), finalAnswer('needs_seller', 'Not sure.')],
  }, async (t) => {
    await asked(t, { ...ASK, name: 'First Buyer', phone: '9876543201' });
    t.clock.now += 60_000;
    await asked(t, { ...ASK, name: 'Second Buyer', phone: '9876543202', question: 'Custom size?' });
    const all = await t.owner('/enquiries');
    assert.ok(all.text.indexOf('Second Buyer') < all.text.indexOf('First Buyer'));
    for (const label of ['Answered', 'Needs you']) assert.match(all.text, new RegExp(`status-badge status-[a-z_]+">${label}<`));
    assert.match(all.text, /href="\/enquiries\?status=needs_you"/);
    const needs = await t.owner('/enquiries?status=needs_you');
    assert.match(needs.text, /aria-current="page" href="\/enquiries\?status=needs_you"/);
    assert.match(needs.text, /Second Buyer/);
    assert.doesNotMatch(needs.text, /First Buyer/);
    assert.match((await t.owner('/enquiries?status=bogus')).text, /First Buyer/);
    const dash = await t.owner('/dashboard');
    assert.match(dash.text, /href="\/enquiries">Enquiries <span class="badge">1 need you<\/span>/);
  }));

  it('shows an empty state and adds an Enquiries link in the header', () => run({}, async (t) => {
    const res = await t.owner('/enquiries');
    assert.match(res.text, /No enquiries to show/);
    assert.match(res.text, /<a href="\/enquiries">Enquiries<\/a>/);
  }));
});

describe('seller inbox: detail, reply, WhatsApp, handled', () => {
  it('shows the question, customer, labelled AI answer, and the trace built from real tool calls', () => run({
    script: [turn(call('read_knowledge')), finalAnswer('answered', 'We ship across India.')],
  }, async (t) => {
    const { enquiry } = await asked(t);
    const page = await t.owner(`/enquiries/${enquiry.id}`);
    assert.match(page.text, /Do you ship to Pune\?/);
    assert.match(page.text, /Asha Patel/);
    assert.match(page.text, /\+919876543210/);
    assert.match(page.text, /We ship across India\./);
    assert.match(page.text, /written by the shop&#39;s AI assistant/);
    assert.match(page.text, /What the assistant checked/);
    assert.match(page.text, /<li>Read the seller&#39;s notes<\/li>/);
    assert.match(page.text, /data-counter="reply-count"/);
  }));

  it('explains why the assistant passed the question on', () => run({ script: [finalAnswer('needs_seller', 'Not sure.')] }, async (t) => {
    const { enquiry } = await asked(t);
    assert.match((await t.owner(`/enquiries/${enquiry.id}`)).text, /was not in your notes/);
  }));

  it('saves a reply, marks it handled, and shows it on the customer link labelled From the seller', () => run({ script: [finalAnswer('needs_seller', 'Not sure.')] }, async (t) => {
    const { token, enquiry } = await asked(t);
    const res = await post(t, `/enquiries/${enquiry.id}/reply`, { reply: 'Yes, we can make it in blue.' });
    assert.equal(res.location, `/enquiries/${enquiry.id}?done=reply`);
    assert.deepEqual([enquiry.status, enquiry.sellerReply], ['handled', 'Yes, we can make it in blue.']);
    const customer = await t.page(token);
    assert.match(customer.text, /From the seller/);
    assert.match(customer.text, /Yes, we can make it in blue\./);
    assert.match(customer.text, /enquiry-chip-handled">Handled by the seller</);
    assert.doesNotMatch((await t.owner('/dashboard')).text, /need you/);
  }));

  it('builds the WhatsApp link to the customer with the reply and the private link, encoded, opening in a new tab', () => run({ script: [finalAnswer('needs_seller', 'Not sure.')] }, async (t) => {
    const { token, enquiry } = await asked(t);
    const reply = 'હા, વાદળી રંગમાં બનાવી શકીએ. Price & time: 5 days #1';
    await post(t, `/enquiries/${enquiry.id}/reply`, { reply });
    const page = await t.owner(`/enquiries/${enquiry.id}`);
    const href = hrefOf(page.text);
    assert.ok(href.startsWith('https://wa.me/919876543210?text='));
    assert.equal(decodeURIComponent(href.split('?text=')[1]), `${reply}\n\n${`https://shop.example.test/s/${t.store.slug}/q/${token}`}`);
    assert.doesNotMatch(href.split('?text=')[1], /[ &#\n]/);
    assert.match(page.text, new RegExp(`href="${href.replace(/[.?]/g, '\\$&')}" target="_blank" rel="noopener noreferrer"`));
    assert.match(page.text, /Open WhatsApp with this reply/);
  }));

  it('the WhatsApp message still works when the private link cannot be decrypted, and says so', () => run({ script: [finalAnswer('needs_seller', 'Not sure.')] }, async (t) => {
    const { enquiry } = await asked(t);
    enquiry.tokenEnc = null;
    await post(t, `/enquiries/${enquiry.id}/reply`, { reply: 'Hello' });
    const page = await t.owner(`/enquiries/${enquiry.id}`);
    assert.equal(decodeURIComponent(hrefOf(page.text).split('?text=')[1]), 'Hello');
    assert.match(page.text, /private link could not be added/);
  }));

  it('validates the reply: empty and over 1000 characters keep the typed text and show an alert', () => run({ script: [finalAnswer('needs_seller', 'Not sure.')] }, async (t) => {
    const { enquiry } = await asked(t);
    for (const reply of ['', '   ', 'x'.repeat(1001)]) {
      const res = await post(t, `/enquiries/${enquiry.id}/reply`, { reply });
      assert.equal(res.status, 400);
      assert.match(res.text, /role="alert" id="reply-error"/);
      assert.match(res.text, /aria-invalid="true"/);
    }
    assert.equal(enquiry.sellerReply, null);
    assert.equal((await post(t, `/enquiries/${enquiry.id}/reply`, { reply: 'x'.repeat(1000) })).status, 303);
  }));

  it('mark as handled works from answered and needs_you, repeats harmlessly, and refuses a pending enquiry', () => run({ script: [finalAnswer('answered', 'Yes.')] }, async (t) => {
    const { enquiry } = await asked(t);
    assert.equal((await post(t, `/enquiries/${enquiry.id}/handled`)).location, `/enquiries/${enquiry.id}?done=handled`);
    assert.equal(enquiry.status, 'handled');
    assert.equal((await post(t, `/enquiries/${enquiry.id}/handled`)).status, 303);
    const pending = t.enquiryRepo.rows.at(-1);
    t.tokenOf(await t.ask({ ...ASK, phone: '9876543299' }));
    const fresh = t.enquiryRepo.rows.at(-1);
    assert.notEqual(fresh.id, pending.id);
    assert.equal((await post(t, `/enquiries/${fresh.id}/handled`)).status, 404);
    assert.equal((await post(t, `/enquiries/${fresh.id}/reply`, { reply: 'early' })).status, 404);
    assert.equal(fresh.status, 'pending');
  }));

  it('escapes XSS payloads in the question, name, answer and reply on the seller pages', () => run({
    script: [finalAnswer('answered', '<img src=x onerror=alert(1)>')],
  }, async (t) => {
    const { enquiry } = await asked(t, { ...ASK, name: '<script>alert(1)</script>', question: '"><svg onload=alert(2)>' });
    await post(t, `/enquiries/${enquiry.id}/reply`, { reply: '<b onmouseover=alert(3)>hi' });
    for (const path of ['/enquiries', `/enquiries/${enquiry.id}`]) {
      const res = await t.owner(path);
      for (const raw of ['<script>alert', '<svg onload', '<img src=x', '<b onmouseover']) assert.equal(res.text.includes(raw), false, `${path} ${raw}`);
    }
    assert.match((await t.owner(`/enquiries/${enquiry.id}`)).text, /&lt;b onmouseover=alert\(3\)&gt;hi/);
  }));

  it('the seller pages never log customer text, and the inbox has no inline script or style', () => run({ script: [finalAnswer('needs_seller', 'Not sure.')] }, async (t) => {
    const { enquiry } = await asked(t);
    await post(t, `/enquiries/${enquiry.id}/reply`, { reply: 'A private reply text' });
    const res = await t.owner(`/enquiries/${enquiry.id}`);
    assert.doesNotMatch(res.text, /<script(?![^>]*src=)|\sstyle=|\son\w+=/i);
    const logged = JSON.stringify([t.logs, t.serviceLogs.entries]);
    for (const secret of ['A private reply text', ASK.question, 'Asha', '9876543210']) assert.equal(logged.includes(secret), false, secret);
  }));
});
