import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { STEP_LINKS, buildProgress } from '../../src/domain/onboardingProgress.js';
import { contactSchema, newStoreSchema } from '../../src/domain/shopFields.js';

const STORE = { whatsappNumber: '919876543210', whatsappEnabled: true };
const build = (overrides) =>
  buildProgress({ store: STORE, translationRows: [{ approved: true }], productCount: 1, canDraft: true, ...overrides });
const doneByKey = (progress) => Object.fromEntries(progress.steps.map((step) => [step.key, step.done]));

describe('buildProgress', () => {
  it('is complete only when every step is done', () => {
    const progress = build({});
    assert.equal(progress.complete, true);
    assert.deepEqual(doneByKey(progress), { shop: true, languages: true, whatsapp: true, product: true });
  });

  it('covers every combination of the three open steps', () => {
    for (let mask = 0; mask < 8; mask += 1) {
      const languages = Boolean(mask & 1);
      const whatsapp = Boolean(mask & 2);
      const product = Boolean(mask & 4);
      const progress = build({
        translationRows: [{ approved: false }, { approved: languages }],
        store: { whatsappNumber: whatsapp ? '919876543210' : null, whatsappEnabled: whatsapp },
        productCount: product ? 2 : 0,
      });
      assert.deepEqual(doneByKey(progress), { shop: true, languages, whatsapp, product });
      assert.equal(progress.complete, mask === 7);
    }
  });

  it('needs both the number and the opt-in for WhatsApp', () => {
    assert.equal(doneByKey(build({ store: { whatsappNumber: '919876543210', whatsappEnabled: false } })).whatsapp, false);
    assert.equal(doneByKey(build({ store: { whatsappNumber: null, whatsappEnabled: true } })).whatsapp, false);
  });

  it('links to the resumable routes and falls back to settings without Claude', () => {
    const links = Object.fromEntries(build({ canDraft: true }).steps.map((step) => [step.key, step.href]));
    assert.deepEqual(links, { shop: null, languages: STEP_LINKS.languages, whatsapp: STEP_LINKS.contact, product: STEP_LINKS.product });
    assert.equal(build({ canDraft: false }).steps[1].href, '/store/settings');
  });

  it('leaves the product step out when products are not available', () => {
    const progress = build({ productCount: null });
    assert.ok(!progress.steps.some((step) => step.key === 'product'));
    assert.equal(progress.complete, true);
  });
});

describe('creation and contact schemas', () => {
  const BASE = { name: 'Clay', slug: 'clay', defaultLanguage: 'en', story: 'Pots.' };

  it('defaults the optional tagline and colour', () => {
    const parsed = newStoreSchema.parse(BASE);
    assert.equal(parsed.tagline, '');
    assert.equal(parsed.accentKey, 'terracotta');
    assert.deepEqual(newStoreSchema.parse({ ...BASE, tagline: ' Hand made ', accentKey: 'teal' }), { ...parsed, tagline: 'Hand made', accentKey: 'teal' });
  });

  it('rejects a long tagline, an unknown colour, store_id and unknown keys', () => {
    for (const bad of [{ tagline: 'x'.repeat(121) }, { accentKey: 'pink' }, { store_id: 'a' }, { extra: 1 }]) {
      assert.equal(newStoreSchema.safeParse({ ...BASE, ...bad }).success, false, JSON.stringify(bad));
    }
  });

  it('requires a number for the WhatsApp opt-in and rejects unknown keys', () => {
    assert.equal(contactSchema.safeParse({ whatsappNumber: '', whatsappEnabled: 'on', instagramHandle: '', upiId: '' }).success, false);
    assert.equal(contactSchema.safeParse({ whatsappNumber: '98765 43210', whatsappEnabled: 'on', instagramHandle: '@a.b', upiId: '' }).success, true);
    assert.equal(contactSchema.safeParse({ whatsappNumber: '', instagramHandle: '', upiId: '', store_id: 'x' }).success, false);
  });
});
