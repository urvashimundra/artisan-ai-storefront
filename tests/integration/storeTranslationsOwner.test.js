import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createTranslationDraftService } from '../../src/services/translationDraftService.js';
import { STORE_FORM, signupAndLogin, startAuthApp } from '../helpers/appHarness.js';
import { buildBudgetService, createLogCollector } from '../helpers/productFakes.js';

const SETTINGS = { tagline: 'Hand made', story: 'Hand made pots.', accentKey: 'teal', whatsappNumber: '', instagramHandle: '', upiId: '' };
const GOOD = { en: { tagline: 'Made by hand', story: 'We make pots.' }, hi: { tagline: 'हाथ से बना', story: 'हम बर्तन बनाते हैं।' } };
const USAGE = { inputTokens: 900, outputTokens: 700 };

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

/** The real draft service over a scripted generator; it needs the same fake repository as the app, so it is attached lazily. */
async function startOwnerApp({ withAi = false, script = [], budgetOptions } = {}) {
  const generator = scriptedGenerator(script);
  const lazy = { service: null };
  const translationDrafts = withAi ? { draft: (request) => lazy.service.draft(request) } : undefined;
  const app = await startAuthApp({ extraServices: { translationDrafts } });
  const { service: budgets } = buildBudgetService(budgetOptions);
  lazy.service = createTranslationDraftService({ translations: app.translationsRepo, budgets, generator, logger: createLogCollector() });
  return { app, generator };
}

async function withOwner(options, fn) {
  const { app, generator } = await startOwnerApp(options);
  try {
    const cookie = await signupAndLogin(app, 'a@example.com');
    await app.request('/store/new', { method: 'POST', form: STORE_FORM, cookie });
    await fn({ app, cookie, generator, store: app.storesRepo.rows[0] });
  } finally {
    await app.close();
  }
}

const postTranslation = (app, cookie, form, extra = {}) => app.request('/store/settings/translations', { method: 'POST', form, cookie, ...extra });
const FORM = { language: 'en', tagline: 'Made by hand', story: 'We make pots in Kutch.', approved: 'on' };

describe('shop settings: translated tagline and story (owner side)', () => {
  it('shows the default text and one editable block per other language, without a draft button when AI is off', () =>
    withOwner({}, async ({ app, cookie }) => {
      const { text, status } = await app.request('/store/settings', { cookie });
      assert.equal(status, 200);
      assert.ok(text.includes('Tagline (Gujarati)') && text.includes('Hand made pots.'));
      for (const language of ['en', 'hi']) {
        assert.ok(text.includes(`name="language" value="${language}"`));
        assert.ok(text.includes(`id="tr-${language}-approved"`));
      }
      assert.ok(!text.includes('value="gu"'));
      assert.ok(!text.includes('Draft translations with Claude'));
      assert.equal((await app.request('/store/settings/translations/draft', { method: 'POST', cookie })).status, 404);
    }));

  it('saves one language as owner text, scoped to the session store, and shows it again', () =>
    withOwner({}, async ({ app, cookie, store }) => {
      const res = await postTranslation(app, cookie, FORM);
      assert.equal(res.status, 303);
      assert.equal(res.location, '/store/settings?saved=translation');
      assert.deepEqual(app.translationsRepo.rows.map((row) => [row.storeId, row.language, row.source, row.approved]), [[store.id, 'en', 'owner', true]]);
      const page = await app.request(res.location, { cookie });
      assert.ok(page.text.includes('Your translation was saved.'));
      assert.ok(page.text.includes('We make pots in Kutch.'));
      assert.match(page.text, /id="tr-en-approved"[^>]* checked/);
    }));

  it('escapes script payloads in saved translations and in re-displayed input', () =>
    withOwner({}, async ({ app, cookie }) => {
      const payload = '</textarea><script>alert(1)</script>';
      await postTranslation(app, cookie, { ...FORM, story: payload });
      const page = (await app.request('/store/settings', { cookie })).text;
      assert.ok(!page.includes('<script>alert'));
      assert.ok(page.includes('&lt;/textarea&gt;&lt;script&gt;'));
      const bad = await postTranslation(app, cookie, { ...FORM, tagline: `${'x'.repeat(121)}<script>alert(2)</script>` });
      assert.equal(bad.status, 400);
      assert.ok(!bad.text.includes('<script>alert'));
    }));

  it('rejects over-long text with a message and keeps the typed text, and saves nothing', () =>
    withOwner({}, async ({ app, cookie }) => {
      const res = await postTranslation(app, cookie, { ...FORM, tagline: 'y'.repeat(121) });
      assert.equal(res.status, 400);
      assert.ok(res.text.includes('Check the lengths: tagline up to 120, story up to 2000 characters.'));
      assert.ok(res.text.includes('y'.repeat(121)));
      assert.equal(app.translationsRepo.rows.length, 0);
    }));

  it('never reads store_id from input: it is rejected, and the session store is used', () =>
    withOwner({}, async ({ app, cookie }) => {
      const other = '22222222-2222-4222-8222-222222222222';
      assert.equal((await postTranslation(app, cookie, { ...FORM, store_id: other })).status, 400);
      assert.equal((await postTranslation(app, cookie, { ...FORM, storeId: other })).status, 400);
      assert.equal(app.translationsRepo.rows.length, 0);
    }));

  it('refuses the shop default language and unknown languages', () =>
    withOwner({}, async ({ app, cookie }) => {
      assert.equal((await postTranslation(app, cookie, { ...FORM, language: 'gu' })).status, 400);
      assert.equal((await postTranslation(app, cookie, { ...FORM, language: 'fr' })).status, 400);
      assert.equal(app.translationsRepo.rows.length, 0);
    }));

  it('accepts a full Gujarati story larger than the global 10 kb form limit', () =>
    withOwner({}, async ({ app, cookie }) => {
      const story = 'અ'.repeat(2000);
      assert.equal((await postTranslation(app, cookie, { ...FORM, language: 'hi', story })).status, 303);
      assert.equal(app.translationsRepo.rows[0].story, story);
    }));

  it('applies the owner guard: login, Origin check and no-store', () =>
    withOwner({}, async ({ app, cookie }) => {
      assert.equal((await postTranslation(app, undefined, FORM)).location, '/login');
      assert.equal((await postTranslation(app, cookie, FORM, { origin: 'https://evil.example' })).status, 403);
      assert.equal(app.translationsRepo.rows.length, 0);
      assert.equal((await app.request('/store/settings', { cookie })).headers.get('cache-control'), 'no-store');
    }));

  it('owner A cannot read or change owner B translations', async () => {
    const app = await startAuthApp();
    try {
      const cookieA = await signupAndLogin(app, 'a@example.com');
      await app.request('/store/new', { method: 'POST', form: STORE_FORM, cookie: cookieA });
      const cookieB = await signupAndLogin(app, 'b@example.com');
      await app.request('/store/new', { method: 'POST', form: { ...STORE_FORM, slug: 'other-shop', name: 'Other' }, cookie: cookieB });
      const [storeA, storeB] = app.storesRepo.rows;
      await postTranslation(app, cookieA, { ...FORM, story: 'A-PRIVATE-TEXT' });
      await postTranslation(app, cookieB, { ...FORM, story: 'B-PRIVATE-TEXT' });
      assert.ok(!(await app.request('/store/settings', { cookie: cookieB })).text.includes('A-PRIVATE-TEXT'));
      assert.ok(!(await app.request('/store/settings', { cookie: cookieA })).text.includes('B-PRIVATE-TEXT'));
      const rowOf = (store) => app.translationsRepo.rows.find((row) => row.storeId === store.id);
      assert.equal(rowOf(storeA).story, 'A-PRIVATE-TEXT');
      assert.equal(rowOf(storeB).story, 'B-PRIVATE-TEXT');
    } finally {
      await app.close();
    }
  });

  it('changing the default tagline withdraws every translation', () =>
    withOwner({}, async ({ app, cookie }) => {
      await postTranslation(app, cookie, FORM);
      assert.equal(app.translationsRepo.rows[0].approved, true);
      const res = await app.request('/store/settings', { method: 'POST', form: { ...SETTINGS, tagline: 'A new tagline' }, cookie });
      assert.equal(res.status, 303);
      assert.equal(app.translationsRepo.rows[0].approved, false);
    }));
});

describe('shop settings: Draft translations with Claude', () => {
  it('makes no AI call on page views or manual saves, only on the owner button', () =>
    withOwner({ withAi: true, script: [{ ok: true, translations: GOOD, usage: USAGE }] }, async ({ app, cookie, generator }) => {
      const page = await app.request('/store/settings', { cookie });
      assert.ok(page.text.includes('Draft translations with Claude'));
      await postTranslation(app, cookie, FORM);
      await app.request('/store/settings', { method: 'POST', form: SETTINGS, cookie });
      assert.equal(generator.calls.length, 0);
      const res = await app.request('/store/settings/translations/draft', { method: 'POST', cookie });
      assert.equal(res.status, 303);
      assert.equal(generator.calls.length, 1);
    }));

  it('saves unapproved AI drafts that replace the other languages, and labels them', () =>
    withOwner({ withAi: true, script: [{ ok: true, translations: GOOD, usage: USAGE }] }, async ({ app, cookie, generator, store }) => {
      const { approved: _omitted, ...unapproved } = FORM;
      assert.equal((await postTranslation(app, cookie, unapproved)).status, 303);
      assert.equal(app.translationsRepo.rows[0].approved, false);
      const res = await app.request('/store/settings/translations/draft', { method: 'POST', cookie });
      assert.equal(res.location, '/store/settings?saved=drafts');
      assert.deepEqual(generator.calls[0], { tagline: '', story: store.story, targets: ['en', 'hi'] });
      assert.deepEqual(app.translationsRepo.rows.map((row) => [row.language, row.source, row.approved]), [['en', 'ai', false], ['hi', 'ai', false]]);
      const page = (await app.request(res.location, { cookie })).text;
      assert.ok(page.includes('AI draft, not yet approved'));
      assert.ok(page.includes('They are not public until you read them and tick Approve.'));
      assert.doesNotMatch(page, /id="tr-en-approved"[^>]* checked/);
    }));

  it('shows a clear message and calls nothing when the budget is exhausted', () =>
    withOwner({ withAi: true, script: [], budgetOptions: { ownerRemaining: 0 } }, async ({ app, cookie, generator }) => {
      const res = await app.request('/store/settings/translations/draft', { method: 'POST', cookie });
      assert.equal(res.status, 429);
      assert.match(res.text, /role="alert"/);
      assert.equal(generator.calls.length, 0);
      assert.equal(app.translationsRepo.rows.length, 0);
    }));

  it('shows a clear error after invalid output is retried once, and saves nothing', () =>
    withOwner(
      { withAi: true, script: [{ ok: false, reason: 'invalid_output', usage: USAGE }, { ok: false, reason: 'invalid_output', usage: USAGE }] },
      async ({ app, cookie, generator }) => {
        const res = await app.request('/store/settings/translations/draft', { method: 'POST', cookie });
        assert.equal(res.status, 502);
        assert.ok(res.text.includes('The AI did not produce usable translations.'));
        assert.equal(generator.calls.length, 2);
        assert.equal(app.translationsRepo.rows.length, 0);
      },
    ));
});

describe('shop settings: editing the default-language story', () => {
  const saveSettings = (app, cookie, overrides) => app.request('/store/settings', { method: 'POST', form: { ...SETTINGS, ...overrides }, cookie });

  it('shows the story in an editable field with the current text', () =>
    withOwner({}, async ({ app, cookie }) => {
      const { text } = await app.request('/store/settings', { cookie });
      assert.match(text, /<textarea id="story" name="story"[^>]*>Hand made pots\.<\/textarea>/);
    }));

  it('updates the story scoped to the session store, and withdraws translations first', () =>
    withOwner({}, async ({ app, cookie, store }) => {
      await postTranslation(app, cookie, FORM);
      assert.equal(app.translationsRepo.rows[0].approved, true);
      const res = await saveSettings(app, cookie, { tagline: '', story: 'A brand new story.' });
      assert.equal(res.status, 303);
      assert.equal(store.story, 'A brand new story.');
      assert.equal(app.translationsRepo.rows[0].approved, false);
    }));

  it('does not unapprove when the story and tagline are unchanged', () =>
    withOwner({}, async ({ app, cookie, store }) => {
      await postTranslation(app, cookie, FORM);
      await saveSettings(app, cookie, { tagline: '', story: store.story });
      assert.equal(app.translationsRepo.rows[0].approved, true);
    }));

  it('rejects an empty or over-long story and keeps the typed text, saving nothing', () =>
    withOwner({}, async ({ app, cookie, store }) => {
      const long = await saveSettings(app, cookie, { story: 'y'.repeat(2001) });
      assert.equal(long.status, 400);
      assert.ok(long.text.includes('id="story-error"') && long.text.includes('y'.repeat(2001)));
      assert.equal((await saveSettings(app, cookie, { story: '   ' })).status, 400);
      assert.equal(store.story, 'Hand made pots.');
    }));

  it('escapes the story and rejects a store_id in the form', () =>
    withOwner({}, async ({ app, cookie, store }) => {
      const bad = await saveSettings(app, cookie, { story: '</textarea><script>alert(1)</script>', tagline: 'x'.repeat(121) });
      assert.ok(!bad.text.includes('<script>alert'));
      assert.equal((await saveSettings(app, cookie, { store_id: '22222222-2222-4222-8222-222222222222' })).status, 400);
      assert.equal(store.story, 'Hand made pots.');
    }));

  it('accepts a 2000-character Gujarati story, larger than the global 10 kb form limit', () =>
    withOwner({}, async ({ app, cookie, store }) => {
      const story = 'અ'.repeat(2000);
      assert.equal((await saveSettings(app, cookie, { story })).status, 303);
      assert.equal(store.story, story);
    }));

  it('owner A editing a story never changes owner B', async () => {
    const app = await startAuthApp();
    try {
      const cookieA = await signupAndLogin(app, 'a@example.com');
      await app.request('/store/new', { method: 'POST', form: STORE_FORM, cookie: cookieA });
      const cookieB = await signupAndLogin(app, 'b@example.com');
      await app.request('/store/new', { method: 'POST', form: { ...STORE_FORM, slug: 'other-shop', name: 'Other' }, cookie: cookieB });
      await saveSettings(app, cookieA, { story: 'Only A' });
      const [storeA, storeB] = app.storesRepo.rows;
      assert.equal(storeA.story, 'Only A');
      assert.equal(storeB.story, STORE_FORM.story);
    } finally {
      await app.close();
    }
  });
});

describe('shop settings: drafts skip approved owner text', () => {
  it('tells the owner which language was skipped and keeps the approved text', () =>
    withOwner({ withAi: true, script: [{ ok: true, translations: { hi: GOOD.hi }, usage: USAGE }] }, async ({ app, cookie, generator }) => {
      await postTranslation(app, cookie, FORM);
      const res = await app.request('/store/settings/translations/draft', { method: 'POST', cookie });
      assert.equal(res.location, '/store/settings?saved=drafts&skipped=en');
      assert.deepEqual(generator.calls[0].targets, ['hi']);
      const page = (await app.request(res.location, { cookie })).text;
      assert.ok(page.includes('Skipped English: you already approved your own text there'));
      assert.equal(app.translationsRepo.rows.find((row) => row.language === 'en').story, FORM.story);
    }));

  it('says nothing was drafted when every language is protected, and calls no AI', () =>
    withOwner({ withAi: true, script: [] }, async ({ app, cookie, generator }) => {
      await postTranslation(app, cookie, FORM);
      await postTranslation(app, cookie, { ...FORM, language: 'hi' });
      const res = await app.request('/store/settings/translations/draft', { method: 'POST', cookie });
      assert.equal(res.location, '/store/settings?saved=skipped&skipped=en,hi');
      assert.equal(generator.calls.length, 0);
      assert.ok((await app.request(res.location, { cookie })).text.includes('Nothing was drafted. Skipped English and Hindi'));
    }));

  it('ignores a forged skipped list in the URL beyond real language names', () =>
    withOwner({}, async ({ app, cookie }) => {
      const page = (await app.request('/store/settings?saved=skipped&skipped=<script>,en', { cookie })).text;
      assert.ok(!page.includes('<script>,'));
      assert.ok(page.includes('Skipped English'));
    }));
});
