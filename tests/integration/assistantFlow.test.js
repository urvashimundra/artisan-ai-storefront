import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { hashStatusToken } from '../../src/lib/statusToken.js';
import { ASK, call, finalAnswer, startAssistantApp, turn } from '../helpers/assistantApp.js';
import { SECRET_EMAIL, SECRET_UPI } from '../helpers/publicFakes.js';

const TIERS = [{ minQty: 10, percentOff: 5 }];
const run = async (options, fn) => {
  const t = await startAssistantApp(options);
  try {
    await fn(t);
  } finally {
    await t.close();
  }
};
const row = (t) => t.enquiryRepo.rows[0];
const SELLER_WA = /href="https:\/\/wa\.me\/919123456780\?text=[^"]+"/;

describe('ask the seller: saving first, then the private page', () => {
  it('saves the enquiry as pending before any AI call and redirects to the private page', () => run({ script: [finalAnswer('answered', 'We ship in 5 days.')] }, async (t) => {
    const res = await t.ask();
    assert.equal(res.status, 303);
    assert.match(res.location, new RegExp(`^/s/${t.store.slug}/q/[A-Za-z0-9_-]{43}\\?lang=en$`));
    assert.equal(row(t).status, 'pending');
    assert.equal(row(t).question, ASK.question);
    assert.equal(row(t).customerPhone, '919876543210');
    assert.equal(t.requests.length, 0);
    assert.equal(t.budgets.reservations.length, 0);
  }));

  it('GET makes zero AI calls and shows the auto-submit form with a visible fallback button and a live status region', () => run({ script: [finalAnswer('answered', 'x')] }, async (t) => {
    const token = t.tokenOf(await t.ask());
    for (let i = 0; i < 3; i += 1) {
      const res = await t.page(token);
      assert.equal(res.status, 200);
      assert.match(res.text, new RegExp(`<form method="post" action="/s/${t.store.slug}/q/${token}/answer\\?lang=en" data-autosubmit data-autosubmit-message="Finding an answer…">`));
      assert.match(res.text, /<button type="submit" class="button">Show the answer<\/button>/);
      assert.match(res.text, /aria-live="polite" data-autosubmit-status/);
      assert.match(res.text, /<script src="\/js\/autosubmit\.js" defer><\/script>/);
    }
    assert.equal(t.requests.length, 0);
    assert.equal(row(t).status, 'pending');
  }));

  it('sends the private-page headers: no-store, noindex and Referrer-Policy same-origin (never no-referrer on a page with a form)', () => run({}, async (t) => {
    const token = t.tokenOf(await t.ask());
    for (const res of [await t.page(token), await t.page(`${token.slice(0, -1)}!`)]) {
      assert.equal(res.headers.get('cache-control'), 'no-store');
      assert.match(res.headers.get('x-robots-tag'), /noindex/);
      assert.equal(res.headers.get('referrer-policy'), 'same-origin');
    }
  }));

  it('answers once: the assistant runs, the page then shows the question, the labelled answer and the link to save', () => run({ script: [finalAnswer('answered', 'We ship across India in 5 days.')] }, async (t) => {
    const token = t.tokenOf(await t.ask());
    const res = await t.answer(token);
    assert.equal(res.status, 303);
    assert.equal(res.location, `/s/${t.store.slug}/q/${token}?lang=en`);
    const page = await t.page(token);
    assert.match(page.text, /Do you ship to Pune\?/);
    assert.match(page.text, /We ship across India in 5 days\./);
    assert.match(page.text, /Answered by this shop&#39;s AI assistant\. The seller can correct it\./);
    assert.match(page.text, /enquiry-chip-answered">Answered</);
    assert.match(page.text, /Save this link/);
    assert.match(page.text, /data-share data-share-url="https:\/\/shop\.example\.test\/s\/[a-z0-9-]+\/q\//);
    assert.doesNotMatch(page.text, /data-autosubmit/);
    assert.equal(t.budgets.settled.length, 1);
  }));

  it('a double submit or refresh runs the agent exactly once', () => run({ script: [finalAnswer('answered', 'Once only.'), finalAnswer('answered', 'Twice!')] }, async (t) => {
    const token = t.tokenOf(await t.ask());
    const results = await Promise.all([t.answer(token), t.answer(token), t.answer(token)]);
    assert.deepEqual(results.map((res) => res.status), [303, 303, 303]);
    await t.answer(token);
    assert.equal(t.requests.length, 1);
    assert.equal(row(t).answerText, 'Once only.');
  }));
});

describe('ask the seller: failures keep the question and point to the seller', () => {
  const needsSellerPage = async (t, token) => {
    const page = await t.page(token);
    assert.match(page.text, /Do you ship to Pune\?/);
    assert.match(page.text, /enquiry-chip-needs_you">Waiting for the seller</);
    assert.match(page.text, SELLER_WA);
    assert.match(page.text, /rel="noopener noreferrer"/);
    return page;
  };

  it('budget exhausted: no provider call, flag budget, WhatsApp pointer, one alert email', () => run({}, async (t) => {
    t.budgets.exhausted = true;
    const token = t.tokenOf(await t.ask());
    await t.answer(token);
    assert.equal(t.requests.length, 0);
    assert.deepEqual([row(t).status, row(t).flagReason], ['needs_you', 'budget']);
    await needsSellerPage(t, token);
    assert.equal(t.outbox.rows.filter((r) => r.kind === 'seller_enquiry_needs_you').length, 1);
  }));

  it('provider error: flag error and the same pointer', () => run({ send: async () => { throw Object.assign(new Error('x'), { kind: 'http', status: 529 }); } }, async (t) => {
    const token = t.tokenOf(await t.ask());
    await t.answer(token);
    assert.deepEqual([row(t).status, row(t).flagReason], ['needs_you', 'error']);
    await needsSellerPage(t, token);
  }));

  it('timeout: a model call that never answers is cut off at the wall-clock cap', () => run({ send: () => new Promise(() => {}), wallClockMs: 40 }, async (t) => {
    const token = t.tokenOf(await t.ask());
    await t.answer(token);
    assert.deepEqual([row(t).status, row(t).flagReason], ['needs_you', 'error']);
    await needsSellerPage(t, token);
  }));

  it('invalid output twice: needs_you with flag error', () => run({ script: [turn(call('final_answer', { outcome: 'x', text: 'y' })), turn(call('final_answer', {}))] }, async (t) => {
    await t.answer(t.tokenOf(await t.ask()));
    assert.deepEqual([row(t).status, row(t).flagReason], ['needs_you', 'error']);
  }));

  it('step cap: six calls then too_complex', () => run({ script: Array.from({ length: 8 }, () => turn(call('get_shop_info'))) }, async (t) => {
    await t.answer(t.tokenOf(await t.ask()));
    assert.equal(t.requests.length, 6);
    assert.deepEqual([row(t).status, row(t).flagReason], ['needs_you', 'too_complex']);
  }));

  it('needs_seller always becomes needs_you with the pointer, whatever the text says, and alerts once', () => run({ script: [finalAnswer('needs_seller', 'Sure, free delivery tomorrow!')] }, async (t) => {
    const token = t.tokenOf(await t.ask());
    await t.answer(token);
    assert.deepEqual([row(t).status, row(t).flagReason], ['needs_you', 'not_in_document']);
    const page = await t.page(token);
    assert.match(page.text, SELLER_WA);
    assert.match(page.text, /enquiry-chip-needs_you/);
    assert.equal(t.outbox.rows.filter((r) => r.kind === 'seller_enquiry_needs_you').length, 1);
    await t.answer(token);
    assert.equal(t.outbox.rows.filter((r) => r.kind === 'seller_enquiry_needs_you').length, 1);
  }));

  it('without WhatsApp opt-in the page says to contact the seller and shows no link or number', () => run({ shop: { whatsappEnabled: false }, script: [finalAnswer('needs_seller', 'Not sure.')] }, async (t) => {
    const token = t.tokenOf(await t.ask());
    await t.answer(token);
    const page = await t.page(token);
    assert.match(page.text, /Please contact the seller\./);
    assert.doesNotMatch(page.text, /wa\.me|919123456780/);
  }));

  it('the seller alert email respects the notify setting', () => run({ script: [finalAnswer('needs_seller', 'Not sure.')] }, async (t) => {
    t.storesRepo.rows[0].notifyEnquiryEmail = false;
    await t.answer(t.tokenOf(await t.ask()));
    assert.equal(t.outbox.rows.filter((r) => r.kind === 'seller_enquiry_needs_you').length, 0);
  }));

  it('an email failure never fails the request or loses the enquiry', () => run({ script: [finalAnswer('needs_seller', 'Not sure.')] }, async (t) => {
    t.outbox.failNextEnqueue = true;
    const res = await t.answer(t.tokenOf(await t.ask()));
    assert.equal(res.status, 303);
    assert.equal(row(t).status, 'needs_you');
  }));

  it('an enquiry stuck in answering for over two minutes shows as needs_you, and alerts once', () => run({}, async (t) => {
    const token = t.tokenOf(await t.ask());
    Object.assign(row(t), { status: 'answering', claimedAt: new Date(t.clock.now).toISOString() });
    assert.match((await t.page(token)).text, /enquiry-chip-answering/);
    t.clock.now += 121_000;
    const page = await t.page(token);
    assert.match(page.text, /enquiry-chip-needs_you/);
    await t.page(token);
    assert.equal(t.outbox.rows.filter((r) => r.kind === 'seller_enquiry_needs_you').length, 1);
    assert.equal(t.requests.length, 0);
  }));

});

describe('ask the seller: quotes and money through the whole app', () => {
  it('shows server-substituted amounts and the estimate line, never model-typed numbers', () => run({
    tiers: TIERS,
    stock: 100,
    script: [
      (request) => turn(call('calculate_quote', { productId: request.messages[0].content.match(/id ([0-9a-f-]{36})/)?.[1] ?? 'p1', quantity: 10 })),
      finalAnswer('answered', 'For 10 pieces you get 5% off. Your total is {{q1.total}}.'),
    ],
  }, async (t) => {
    const token = t.tokenOf(await t.ask({ ...ASK, productId: t.product.id }));
    await t.answer(token);
    assert.equal(row(t).productId, t.product.id);
    const page = await t.page(token);
    assert.match(page.text, /Your total is ₹2,375\.00\./);
    assert.match(page.text, /This is an estimate\. The seller will confirm\./);
    assert.deepEqual(row(t).trace, ['Calculated a quote: 10 x Clay diya, 5% bulk discount']);
  }));

  it('a quote above the stock goes to needs_you with no answer text, even if the model says it is available', () => run({
    tiers: TIERS,
    script: [
      (request) => turn(call('calculate_quote', { productId: request.messages[0].content.match(/id ([0-9a-f-]{36})/)?.[1] ?? 'p1', quantity: 10 })),
      finalAnswer('answered', 'Yes, 10 pieces are available. Your total is {{q1.total}}.'),
    ],
  }, async (t) => {
    const token = t.tokenOf(await t.ask({ ...ASK, productId: t.product.id }));
    await t.answer(token);
    assert.deepEqual([row(t).status, row(t).answerText], ['needs_you', null]);
    assert.doesNotMatch((await t.page(token)).text, /are available/);
  }));

  it('a typed amount discards the answer: needs_you with unverified_amount and nothing of it shown', () => run({ script: [finalAnswer('answered', 'It costs Rs 100 only!')] }, async (t) => {
    const token = t.tokenOf(await t.ask());
    await t.answer(token);
    assert.deepEqual([row(t).status, row(t).flagReason, row(t).answerText], ['needs_you', 'unverified_amount', null]);
    assert.doesNotMatch((await t.page(token)).text, /Rs 100/);
  }));
});

describe('ask the seller: limits, trap, validation', () => {
  it('accepts a same-origin answer POST with realistic headers (Origin, no Referer) and still refuses a bad Origin', () => run({ script: [finalAnswer('answered', 'We ship in 5 days.')] }, async (t) => {
    const token = t.tokenOf(await t.ask());
    const forged = await t.answer(token, { origin: 'https://evil.test', headers: { referer: 'https://evil.test/' } });
    assert.equal(forged.status, 403);
    assert.equal(row(t).status, 'pending');
    const ok = await t.answer(token, { origin: 'http://localhost', headers: { 'sec-fetch-site': 'same-origin' } });
    assert.equal(ok.status, 303);
    assert.equal(row(t).status, 'answered');
    assert.equal((await t.page(token)).headers.get('referrer-policy'), 'same-origin');
  }));

  it('still rejects a literal Origin: null on the answer POST, so the Origin check is not weakened', () => run({}, async (t) => {
    const nullOrigin = { origin: 'null', headers: { 'sec-fetch-site': 'same-origin' } };
    const token = t.tokenOf(await t.ask());
    assert.equal((await t.answer(token, nullOrigin)).status, 403);
    assert.equal(row(t).status, 'pending');
  }));

});

describe('ask the seller: tokens, privacy and output safety', () => {
  it('stores only the hash and an encrypted copy that round-trips, and logs neither the token nor any customer text', () => run({ script: [finalAnswer('answered', 'Secret answer text.')] }, async (t) => {
    const token = t.tokenOf(await t.ask());
    await t.answer(token);
    await t.page(token);
    assert.equal(row(t).tokenHash, hashStatusToken(token));
    assert.notEqual(row(t).tokenEnc, token);
    assert.equal(t.linkCipher.decrypt(row(t).tokenEnc), token);
    assert.equal(JSON.stringify(t.enquiryRepo.rows).includes(token), false);
    const logged = JSON.stringify([t.logs, t.serviceLogs.entries, t.warnings]);
    for (const secret of [token, ASK.question, 'Asha', '9876543210', '98765 43210', 'Secret answer text']) assert.equal(logged.includes(secret), false, secret);
  }));

  it('unknown, other-shop and malformed tokens return the same generic 404', () => run({}, async (t) => {
    const token = t.tokenOf(await t.ask());
    const other = t.repo.addShop({ slug: 'other-shop' });
    const bodies = new Set();
    for (const res of [await t.page('A'.repeat(43)), await t.page('short'), await t.request(`/s/${other.slug}/q/${token}`), await t.request('/s/no-such-shop/q/' + token)]) {
      assert.equal(res.status, 404);
      bodies.add(res.text.replace(/\s+/g, ' '));
    }
    assert.equal(bodies.size, 1);
    assert.equal((await t.answer('A'.repeat(43))).status, 404);
    assert.equal((await t.request(`/s/${other.slug}/q/${token}/answer`, { method: 'POST' })).status, 404);
    assert.equal(row(t).status, 'pending');
  }));

  it('escapes XSS payloads in the question, name, answer and seller reply, and shows no phone, UPI or contact email', () => run({
    script: [finalAnswer('answered', 'Hello <img src=x onerror=alert(1)> <script>alert(2)</script>')],
  }, async (t) => {
    const payload = '"><script>alert(1)</script><b onmouseover=alert(3)>';
    const token = t.tokenOf(await t.ask({ ...ASK, name: '<i>Asha</i>', question: payload }));
    await t.answer(token);
    Object.assign(row(t), { sellerReply: '<svg onload=alert(4)>', repliedAt: new Date().toISOString(), status: 'handled' });
    const page = await t.page(token);
    for (const raw of ['<script>alert', '<img src=x', '<b onmouseover', '<svg onload', '<i>Asha']) assert.equal(page.text.includes(raw), false, raw);
    assert.match(page.text, /&lt;script&gt;alert\(1\)/);
    assert.match(page.text, /&lt;svg onload=alert\(4\)&gt;/);
    for (const secret of [SECRET_EMAIL, SECRET_UPI, '919876543210', '9876543210', '919123456780', 'Asha']) assert.equal(page.text.includes(secret), false, secret);
  }));

  it('robots.txt disallows the private answer pages and the inbox', () => run({}, async (t) => {
    const res = await t.request('/robots.txt');
    assert.ok(res.text.includes('Disallow: /s/*/q/\n'));
    assert.ok(res.text.includes('Disallow: /enquiries\n'));
  }));

  it('the new strings exist in English, Gujarati and Hindi', async () => {
    const { PUBLIC_STRINGS } = await import('../../src/domain/publicStrings.js');
    for (const key of ['enquiryAiLabel', 'enquiryNeedsSeller', 'quoteEstimateNote', 'enquiryStatusNeedsYou']) {
      for (const language of ['en', 'gu', 'hi']) assert.ok(PUBLIC_STRINGS[language][key]?.length > 0, `${language}.${key}`);
    }
    assert.notEqual(PUBLIC_STRINGS.gu.enquiryAiLabel, PUBLIC_STRINGS.en.enquiryAiLabel);
    assert.notEqual(PUBLIC_STRINGS.hi.enquiryAiLabel, PUBLIC_STRINGS.en.enquiryAiLabel);
  });
});
