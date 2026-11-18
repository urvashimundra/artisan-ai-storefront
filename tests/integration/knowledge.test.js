import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createKnowledgeService } from '../../src/services/knowledgeService.js';
import { STORE_FORM, signupAndLogin, startAuthApp } from '../helpers/appHarness.js';
import { createFakeBudgets, createFakeKnowledgeRepo } from '../helpers/assistantFakes.js';

const RULES = { minQty1: '10', percentOff1: '5', minQty2: '25', percentOff2: '10' };

async function withApp(fn, { extractResult = { ok: true, tiers: [{ minQty: 10, percentOff: 5 }], usage: { inputTokens: 100, outputTokens: 20 } } } = {}) {
  const repo = createFakeKnowledgeRepo();
  const budgets = createFakeBudgets();
  const extractCalls = [];
  const extractor = { model: 'fake', promptVersion: 'v', extract: async (content) => (extractCalls.push(content), extractResult) };
  const knowledge = createKnowledgeService({ knowledge: repo, budgets, extractor, now: () => Date.parse('2026-11-16T10:00:00Z') });
  const app = await startAuthApp({ extraServices: { knowledge } });
  try {
    const cookieA = await signupAndLogin(app, 'a@example.com');
    await app.request('/store/new', { method: 'POST', form: STORE_FORM, cookie: cookieA });
    const cookieB = await signupAndLogin(app, 'b@example.com');
    await app.request('/store/new', { method: 'POST', form: { ...STORE_FORM, slug: 'other-shop', name: 'Other' }, cookie: cookieB });
    const [storeA, storeB] = app.storesRepo.rows;
    await fn({ app, repo, budgets, extractCalls, cookieA, cookieB, storeA, storeB });
  } finally {
    await app.close();
  }
}

const save = (app, cookie, form, path = '/store/knowledge', extra = {}) => app.request(path, { method: 'POST', form, cookie, ...extra });

describe('shop notes page (owner)', () => {
  it('applies the owner guard stack and warns that customers can learn what is written', async () => {
    await withApp(async ({ app, cookieA }) => {
      assert.equal((await app.request('/store/knowledge')).location, '/login');
      assert.equal((await save(app, undefined, { content: 'x' })).location, '/login');
      const page = await app.request('/store/knowledge', { cookie: cookieA });
      assert.equal(page.status, 200);
      assert.equal(page.headers.get('cache-control'), 'no-store');
      assert.match(page.text, /Customers can read what you write here/);
      assert.match(page.text, /href="\/knowledge-template\.md" download/);
      assert.equal((await save(app, cookieA, { content: 'x' }, '/store/knowledge', { origin: 'https://evil.test' })).status, 403);
    });
  });

  it('saves the document for the session store only, and replacing it clears the confirmed rules and says so', async () => {
    await withApp(async ({ app, repo, cookieA, storeA, storeB }) => {
      assert.equal((await save(app, cookieA, { content: 'Delivery in 5 days. 10 or more: 5% off' })).location, '/store/knowledge?saved=document');
      assert.equal(repo.rows.get(storeA.id).content, 'Delivery in 5 days. 10 or more: 5% off');
      assert.equal(repo.rows.has(storeB.id), false);
      await save(app, cookieA, RULES, '/store/knowledge/rules');
      assert.equal(repo.rows.get(storeA.id).bulkRules.length, 2);
      const replaced = await save(app, cookieA, { content: 'New notes' });
      assert.equal(replaced.location, '/store/knowledge?saved=documentCleared');
      assert.deepEqual(repo.rows.get(storeA.id).bulkRules, []);
      const page = await app.request(replaced.location, { cookie: cookieA });
      assert.match(page.text, /bulk discounts were cleared/);
    });
  });

  it('Save stays on the notes page with a Saved notice, and the Claude search is enabled for the saved notes', async () => {
    await withApp(async ({ app, cookieA }) => {
      const saved = await save(app, cookieA, { content: '10 or more: 5% off' });
      assert.equal(saved.location, '/store/knowledge?saved=document');
      const page = await app.request(saved.location, { cookie: cookieA });
      assert.match(page.text, /<p class="notice" role="status" aria-live="polite">Saved\. Your shop notes are up to date\.<\/p>/);
      assert.match(page.text, /<button type="submit" class="button button-secondary"[^>]*>Find bulk discounts with Claude/);
      assert.doesNotMatch(page.text, /button-secondary"[^>]*disabled/);
    });
  });

  it('owner B never sees or changes owner A notes or rules', async () => {
    await withApp(async ({ app, repo, cookieA, cookieB, storeA, storeB }) => {
      await save(app, cookieA, { content: 'Secret policy of A' });
      await save(app, cookieA, RULES, '/store/knowledge/rules');
      const pageB = await app.request('/store/knowledge', { cookie: cookieB });
      assert.doesNotMatch(pageB.text, /Secret policy of A/);
      assert.doesNotMatch(pageB.text, /10 or more: 5% off/);
      await save(app, cookieB, { content: 'B notes' });
      assert.equal(repo.rows.get(storeA.id).content, 'Secret policy of A');
      assert.equal(repo.rows.get(storeA.id).bulkRules.length, 2);
      assert.equal(repo.rows.get(storeB.id).content, 'B notes');
    });
  });

  it('strict schemas reject a store id in the body', async () => {
    await withApp(async ({ app, repo, cookieA, storeA, storeB }) => {
      assert.equal((await save(app, cookieA, { content: 'x', store_id: storeB.id })).status, 400);
      assert.equal((await save(app, cookieA, { ...RULES, store_id: storeB.id }, '/store/knowledge/rules')).status, 400);
      assert.equal(repo.rows.has(storeA.id), false);
      assert.equal(repo.rows.has(storeB.id), false);
    });
  });

  it('refuses too long notes with an error and keeps what was typed', async () => {
    await withApp(async ({ app, repo, cookieA, storeA }) => {
      const res = await save(app, cookieA, { content: 'x'.repeat(20_001) });
      assert.equal(res.status, 400);
      assert.match(res.text, /role="alert"/);
      assert.match(res.text, /aria-invalid="true"/);
      assert.equal(repo.rows.has(storeA.id), false);
    });
  });

  it('validates tiers: limits and ordering, and keeps the typed values', async () => {
    await withApp(async ({ app, repo, cookieA, storeA }) => {
      for (const form of [{ minQty1: '1', percentOff1: '5' }, { minQty1: '10', percentOff1: '60' }, { minQty1: '10', percentOff1: '5', minQty2: '10', percentOff2: '6' },
        { minQty1: '30', percentOff1: '5', minQty2: '10', percentOff2: '6' }, { minQty1: '10' }]) {
        const res = await save(app, cookieA, form, '/store/knowledge/rules');
        assert.equal(res.status, 400, JSON.stringify(form));
        assert.match(res.text, /role="alert"/);
      }
      assert.equal(repo.rows.has(storeA.id), false);
    });
  });

  it('the Claude search only PREFILLS the form: nothing is saved or used until the owner saves', async () => {
    await withApp(async ({ app, repo, budgets, extractCalls, cookieA, storeA }) => {
      await save(app, cookieA, { content: '10 or more: 5% off' });
      const found = await save(app, cookieA, {}, '/store/knowledge/rules/find');
      assert.equal(found.status, 200);
      assert.match(found.text, /name="minQty1"[^>]*value="10"/);
      assert.match(found.text, /Nothing is used until you save/);
      assert.deepEqual(repo.rows.get(storeA.id).bulkRules, []);
      assert.equal(extractCalls.length, 1);
      assert.equal(budgets.reservations.length, 1);
      assert.equal(budgets.settled.length, 1);
    });
  });

  it('the Claude search needs saved notes, and honours the budget guard', async () => {
    await withApp(async ({ app, budgets, extractCalls, cookieA }) => {
      const noNotes = await save(app, cookieA, {}, '/store/knowledge/rules/find');
      assert.equal(noNotes.status, 400);
      assert.match(noNotes.text, /<p class="error-summary" role="alert" tabindex="-1" data-focus-alert id="find-error">Add your shop notes and save them first<\/p>/);
      assert.match(noNotes.text, /<button type="submit" class="button button-secondary" aria-describedby="find-error">Find bulk discounts with Claude/);
      assert.equal(extractCalls.length, 0);
      await save(app, cookieA, { content: 'notes' });
      budgets.exhausted = true;
      const res = await save(app, cookieA, {}, '/store/knowledge/rules/find');
      assert.equal(res.status, 429);
      assert.equal(extractCalls.length, 0);
    });
  });

  it('an empty or invalid extraction never prefills junk', async () => {
    await withApp(async ({ app, cookieA }) => {
      await save(app, cookieA, { content: 'no discounts here' });
      const res = await save(app, cookieA, {}, '/store/knowledge/rules/find');
      assert.match(res.text, /did not find a clear bulk discount/);
    }, { extractResult: { ok: true, tiers: [], usage: { inputTokens: 10, outputTokens: 5 } } });
    await withApp(async ({ app, cookieA }) => {
      await save(app, cookieA, { content: 'notes' });
      const res = await save(app, cookieA, {}, '/store/knowledge/rules/find');
      assert.equal(res.status, 502);
    }, { extractResult: { ok: false, usage: { inputTokens: 10, outputTokens: 5 } } });
  });

  it('is optional onboarding step 4: reached after step 3, skippable, and ends on the welcome dashboard', async () => {
    await withApp(async ({ app, repo, cookieA, storeA }) => {
      const afterLanguages = await app.request('/store/new/languages', { cookie: cookieA });
      assert.equal(afterLanguages.location, '/store/knowledge?step=4');
      const step = await app.request('/store/knowledge?step=4', { cookie: cookieA });
      assert.match(step.text, /Step 4 of 4/);
      assert.ok(step.text.includes('href="/dashboard?welcome=1">Skip, I will do this later'));
      assert.ok(step.text.includes('action="/store/knowledge?step=4"'));
      assert.doesNotMatch((await app.request('/store/knowledge', { cookie: cookieA })).text, /Step 4 of 4/);
      const saved = await save(app, cookieA, { content: 'Delivery in 5 days.' }, '/store/knowledge?step=4');
      assert.equal(saved.location, '/dashboard?welcome=1');
      assert.equal(repo.rows.get(storeA.id).content, 'Delivery in 5 days.');
      assert.match((await app.request('/store/new/contact', { cookie: cookieA })).text, /Step 2 of 4/);
    });
  });
});
