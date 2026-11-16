import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createTranslationDraftService } from '../../src/services/translationDraftService.js';
import { STORE_FORM, signupAndLogin, startAuthApp } from '../helpers/appHarness.js';
import { buildBudgetService, createLogCollector } from '../helpers/productFakes.js';

const GOOD = { en: { tagline: 'Made by hand', story: 'We make pots.\nIn Kutch.' }, hi: { tagline: 'हाथ से बना', story: 'हम बर्तन बनाते हैं।' } };
const USAGE = { inputTokens: 900, outputTokens: 700 };
const XSS = '<script>alert(1)</script>';
const CONTACT = { whatsappNumber: '98765 43210', whatsappEnabled: 'on', instagramHandle: '@clay.works', upiId: 'clay@bank' };
const NEW = '/store/new';
const OTHER_ORIGIN = 'http://evil.example';

function scriptedGenerator(script) {
  const queue = [...script];
  const calls = [];
  return {
    calls,
    model: 'claude-haiku-5-5',
    promptVersion: 'store-translation-v1',
    async translate(input) {
      calls.push(input);
      return queue.shift();
    },
  };
}

async function startOnboardingApp({ withAi = true, script = [{ ok: true, translations: GOOD, usage: USAGE }], budgetOptions } = {}) {
  const generator = scriptedGenerator(script);
  const lazy = { service: null };
  const translationDrafts = withAi ? { draft: (request) => lazy.service.draft(request) } : undefined;
  const app = await startAuthApp({ extraServices: { translationDrafts } });
  const { service: budgets } = buildBudgetService(budgetOptions);
  lazy.service = createTranslationDraftService({ translations: app.translationsRepo, budgets, generator, logger: createLogCollector() });
  return { app, generator };
}

async function withOnboarding(options, fn) {
  const { app, generator } = await startOnboardingApp(options);
  try {
    const cookie = await signupAndLogin(app, 'a@example.com');
    await fn({ app, cookie, generator });
  } finally {
    await app.close();
  }
}

const createStore = (app, cookie, extra = {}) => app.request(NEW, { method: 'POST', cookie, form: { ...STORE_FORM, ...extra } });
const withStore = (options, fn) =>
  withOnboarding(options, async (ctx) => {
    await createStore(ctx.app, ctx.cookie);
    await fn({ ...ctx, store: ctx.app.storesRepo.rows[0] });
  });
const seedRow = (app, storeId, language, extra = {}) =>
  app.translationsRepo.upsertMany(storeId, [{ language, tagline: 't', story: 's', source: 'ai', approved: false, ...extra }]);
const approvedByLanguage = (app) => Object.fromEntries(app.translationsRepo.rows.map((row) => [row.language, row.approved]));

describe('onboarding step 1: store creation', () => {
  it('creates with the defaults when tagline and colour are left out, and goes to step 2', () =>
    withOnboarding({}, async ({ app, cookie }) => {
      const res = await createStore(app, cookie);
      assert.equal(res.location, '/store/new/contact');
      assert.deepEqual([app.storesRepo.rows[0].tagline, app.storesRepo.rows[0].accentKey], ['', 'terracotta']);
    }));

  it('stores a tagline and colour when given', () =>
    withOnboarding({}, async ({ app, cookie }) => {
      await createStore(app, cookie, { tagline: 'Pots with soul', accentKey: 'plum' });
      assert.deepEqual([app.storesRepo.rows[0].tagline, app.storesRepo.rows[0].accentKey], ['Pots with soul', 'plum']);
    }));

  it('rejects bad values with a message, and rejects store_id and unknown keys', () =>
    withOnboarding({}, async ({ app, cookie }) => {
      const long = await createStore(app, cookie, { tagline: 'x'.repeat(121) });
      assert.equal(long.status, 400);
      assert.ok(long.text.includes('Enter a tagline of up to 120 characters.'));
      assert.equal((await createStore(app, cookie, { accentKey: 'pink' })).status, 400);
      assert.equal((await createStore(app, cookie, { store_id: 'x' })).status, 400);
      assert.equal((await createStore(app, cookie, { surprise: '1' })).status, 400);
      assert.equal(app.storesRepo.rows.length, 0);
    }));

  it('answers a taken slug with 409 and keeps what the owner typed', () =>
    withOnboarding({}, async ({ app, cookie }) => {
      await createStore(app, cookie);
      const other = await signupAndLogin(app, 'b@example.com');
      const res = await createStore(app, other, { tagline: 'Keep me', accentKey: 'teal' });
      assert.equal(res.status, 409);
      assert.ok(res.text.includes('value="Keep me"'));
      assert.match(res.text, /<option value="teal" selected>/);
    }));
});

describe('onboarding step 2: contact', () => {
  it('saves contact fields only: store text, colour and approved translations stay as they were', () =>
    withStore({}, async ({ app, cookie, store }) => {
      await seedRow(app, store.id, 'en', { approved: true, source: 'owner' });
      const keep = ({ tagline, story, accentKey, name, slug }) => ({ tagline, story, accentKey, name, slug });
      const before = keep(store);
      const res = await app.request('/store/new/contact', { method: 'POST', cookie, form: CONTACT });
      assert.equal(res.location, '/store/new/languages');
      const saved = app.storesRepo.rows[0];
      assert.deepEqual([saved.whatsappNumber, saved.whatsappEnabled, saved.instagramHandle, saved.upiId], ['919876543210', true, 'clay.works', 'clay@bank']);
      assert.deepEqual(keep(saved), before);
      assert.equal(app.translationsRepo.rows[0].approved, true);
      assert.ok(!app.translationsRepo.calls.includes('unapproveAll'));
    }));

  it('uses the shared validation: opt-in needs a number, bad handle and UPI are explained, input is echoed', () =>
    withStore({}, async ({ app, cookie }) => {
      const noNumber = await app.request('/store/new/contact', { method: 'POST', cookie, form: { whatsappEnabled: 'on' } });
      assert.equal(noNumber.status, 400);
      assert.ok(noNumber.text.includes('To use the WhatsApp button, a number is required.'));
      assert.match(noNumber.text, /id="whatsappEnabled"[^>]* checked/);
      const bad = await app.request('/store/new/contact', { method: 'POST', cookie, form: { instagramHandle: 'no spaces', upiId: 'bad' } });
      assert.ok(bad.text.includes('Enter 1 to 30 letters') && bad.text.includes('Enter a UPI ID like name@bank'));
      assert.ok(bad.text.includes('value="no spaces"'));
      assert.equal(app.storesRepo.rows[0].whatsappEnabled, false);
    }));

  it('rejects store_id and unknown keys; the page offers Skip for now and the existing copy', () =>
    withStore({}, async ({ app, cookie }) => {
      assert.equal((await app.request('/store/new/contact', { method: 'POST', cookie, form: { store_id: 'x' } })).status, 400);
      assert.equal((await app.request('/store/new/contact', { method: 'POST', cookie, form: { tagline: 'x' } })).status, 400);
      const page = await app.request('/store/new/contact', { cookie });
      assert.ok(page.text.includes('<a href="/store/new/languages">Skip for now</a>'));
      assert.ok(page.text.includes('Customers can see this number when they tap the WhatsApp button'));
      assert.ok(page.text.includes('It is never shown on your shop page.'));
    }));
});

describe('onboarding step 3: languages', () => {
  it('GET never calls Claude: it shows the auto-submit form and the skip link', () =>
    withStore({}, async ({ app, cookie, generator }) => {
      const page = await app.request('/store/new/languages', { cookie });
      assert.equal(page.status, 200);
      assert.equal(generator.calls.length, 0);
      assert.ok(page.text.includes(' data-autosubmit>'));
      assert.ok(page.text.includes('Write my translations with Claude'));
      assert.ok(page.text.includes('Skip, I will do this later'));
      assert.ok(page.text.includes('<script src="/js/autosubmit.js" defer></script>'));
      assert.ok(page.text.includes('aria-live="polite"'));
    }));

  it('POST drafts once, saves unapproved drafts and redirects to the review view', () =>
    withStore({}, async ({ app, cookie, generator, store }) => {
      const res = await app.request('/store/new/languages', { method: 'POST', cookie });
      assert.equal(res.status, 303);
      assert.equal(generator.calls.length, 1);
      const saved = app.translationsRepo.rows.map((row) => [row.storeId, row.language, row.approved]);
      assert.deepEqual(saved, [[store.id, 'en', false], [store.id, 'hi', false]]);
      const review = await app.request(res.location, { cookie });
      assert.ok(!review.text.includes('data-autosubmit'));
      assert.ok(review.text.includes('Approve all and finish') && review.text.includes('Edit in Shop settings'));
      assert.ok(review.text.includes('<span class="chip">Draft</span>'));
      assert.ok(review.text.includes('lang="hi"') && review.text.includes('class="pre-line"'));
      assert.equal(generator.calls.length, 1);
    }));

  it('GET with existing drafts shows the review and never auto-submits or calls Claude', () =>
    withStore({}, async ({ app, cookie, generator, store }) => {
      await seedRow(app, store.id, 'en');
      for (const path of ['/store/new/languages', '/store/new/languages?drafted=1']) {
        const page = await app.request(path, { cookie });
        assert.ok(page.text.includes('Approve all and finish'));
        assert.ok(!page.text.includes('data-autosubmit') && !page.text.includes('autosubmit.js'));
      }
      assert.equal(generator.calls.length, 0);
    }));

  it('after a failure the store is kept and the page offers Try again and Skip, without auto-submit', () =>
    withStore({ script: [], budgetOptions: { ownerRemaining: 0 } }, async ({ app, cookie, generator }) => {
      const res = await app.request('/store/new/languages', { method: 'POST', cookie });
      assert.equal(res.status, 429);
      assert.match(res.text, /role="alert"/);
      assert.ok(res.text.includes('Try again') && res.text.includes('Skip, I will do this later'));
      assert.ok(!res.text.includes('data-autosubmit') && !res.text.includes('autosubmit.js'));
      assert.equal(generator.calls.length, 0);
      assert.equal(app.storesRepo.rows.length, 1);
    }));

  it('redirects to the dashboard when drafting is not configured', () =>
    withStore({ withAi: false }, async ({ app, cookie }) => {
      const routes = [['GET', '/store/new/languages'], ['POST', '/store/new/languages'], ['POST', '/store/new/languages/approve']];
      for (const [method, path] of routes) {
        const res = await app.request(path, { method, cookie });
        assert.deepEqual([res.status, res.location], [303, '/dashboard?welcome=1'], path);
      }
    }));

  it('escapes script payloads in draft text on the review view and the dashboard', () =>
    withStore({}, async ({ app, cookie, store }) => {
      await seedRow(app, store.id, 'en', { tagline: XSS, story: XSS, approved: true });
      const review = await app.request('/store/new/languages', { cookie });
      assert.ok(!review.text.includes(XSS) && review.text.includes('&lt;script&gt;'));
      const dashboard = await app.request('/dashboard?welcome=1', { cookie });
      assert.ok(!dashboard.text.includes(XSS));
    }));
});

describe('onboarding: approve all', () => {
  const approve = (app, cookie) => app.request('/store/new/languages/approve', { method: 'POST', cookie });

  it('approves only non-default rows that have a story, is idempotent, and lands on the welcome dashboard', () =>
    withStore({}, async ({ app, cookie, store }) => {
      await seedRow(app, store.id, 'en');
      await seedRow(app, store.id, 'gu');
      await seedRow(app, store.id, 'hi', { story: '' });
      const res = await approve(app, cookie);
      assert.equal(res.location, '/dashboard?welcome=1');
      const expected = { en: true, gu: false, hi: false };
      assert.deepEqual(approvedByLanguage(app), expected);
      await approve(app, cookie);
      assert.deepEqual(approvedByLanguage(app), expected);
      const dashboard = await app.request(res.location, { cookie });
      assert.ok(dashboard.text.includes('Your shop is ready.') && dashboard.text.includes('View your shop (opens in a new tab)'));
    }));

  it("never touches another owner's store", () =>
    withStore({}, async ({ app, cookie, store }) => {
      const other = await signupAndLogin(app, 'b@example.com');
      await app.request(NEW, { method: 'POST', cookie: other, form: { ...STORE_FORM, slug: 'other-shop' } });
      const otherStore = app.storesRepo.rows[1];
      await seedRow(app, store.id, 'en');
      await seedRow(app, otherStore.id, 'en');
      await approve(app, other);
      const state = app.translationsRepo.rows.map((row) => [row.storeId === store.id, row.approved]);
      assert.deepEqual(state, [[true, false], [false, true]]);
    }));
});

describe('onboarding: guards', () => {
  const GETS = ['/store/new/contact', '/store/new/languages'];
  const POSTS = ['/store/new/contact', '/store/new/languages', '/store/new/languages/approve'];
  const ROUTES = [...GETS.map((path) => ['GET', path]), ...POSTS.map((path) => ['POST', path])];

  it('redirects visitors without a session to the login page', () =>
    withOnboarding({}, async ({ app }) => {
      for (const [method, path] of ROUTES) {
        const res = await app.request(path, { method });
        assert.equal(res.status, 303, path);
        assert.match(res.location, /^\/login/, path);
      }
    }));

  it('redirects owners without a store to /store/new', () =>
    withOnboarding({}, async ({ app, cookie }) => {
      for (const [method, path] of ROUTES) assert.equal((await app.request(path, { method, cookie })).location, NEW, path);
    }));

  it('applies the Origin check to every POST and sends no-store headers', () =>
    withStore({}, async ({ app, cookie, generator }) => {
      for (const path of POSTS) assert.equal((await app.request(path, { method: 'POST', cookie, origin: OTHER_ORIGIN })).status, 403, path);
      assert.equal(generator.calls.length, 0);
      for (const path of GETS) assert.equal((await app.request(path, { cookie })).headers.get('cache-control'), 'no-store', path);
    }));
});

describe('shop settings page and dashboard card', () => {
  it('groups settings under three headings with landmarks, a top shop link and status chips', () =>
    withStore({}, async ({ app, cookie, store }) => {
      await seedRow(app, store.id, 'en', { approved: true });
      const { text } = await app.request('/store/settings', { cookie });
      for (const id of ['identity-heading', 'contact-heading', 'translations-heading']) {
        assert.ok(text.includes(`<h2 id="${id}">`) && text.includes(`aria-labelledby="${id}"`), id);
      }
      assert.ok(text.indexOf('View your shop (opens in a new tab)') < text.indexOf('id="identity-heading"'));
      assert.ok(text.includes('<span class="chip chip-approved">Approved</span>'));
      assert.ok(text.includes('<span class="chip">Draft</span>'));
      assert.ok(text.includes('Save English') && text.includes('Save Hindi'));
    }));

  it('shows the checklist as text, and hides it once every step is done', () =>
    withStore({}, async ({ app, cookie, store }) => {
      const open = await app.request('/dashboard', { cookie });
      assert.ok(open.text.includes('Finish setting up'));
      assert.ok(open.text.includes('Shop created: <strong>Done</strong>'));
      assert.ok(open.text.includes('Translations approved: <strong>To do</strong>'));
      assert.ok(open.text.includes('href="/store/new/languages"') && open.text.includes('href="/store/new/contact"'));
      await app.request('/store/new/contact', { method: 'POST', cookie, form: CONTACT });
      await seedRow(app, store.id, 'en', { approved: true });
      const done = await app.request('/dashboard', { cookie });
      assert.ok(!done.text.includes('Finish setting up'));
    }));
});
