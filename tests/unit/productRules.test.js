import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  MAX_ALT_TEXT_LENGTH,
  MAX_DESCRIPTION_LENGTH,
  MAX_PRICE_PAISE,
  MAX_PRODUCT_STORY_LENGTH,
  MAX_TITLE_LENGTH,
  MIN_PRICE_PAISE,
  codePointLength,
  generateRequestSchema,
  generationStorySchema,
  normalizeStory,
  parsePriceRupees,
  priceInputSchema,
  productIdParamsSchema,
  productReviewSchema,
  storySchema,
  translationInputSchema,
} from '../../src/domain/productRules.js';

const full = (title = 't') => ({ title, description: 'd', alt_text: 'a' });
const empty = { title: '', description: '', alt_text: '' };
const review = (over = {}) => ({
  story: 'A story',
  price: '499.50',
  translations: { en: full(), gu: full(), hi: full() },
  approvedLanguages: ['en'],
  publish: false,
  ...over,
});

describe('story', () => {
  it('applies NFKC, unifies line breaks, strips controls and trims', () => {
    assert.equal(normalizeStory('  ｐｏｔ\r\nsecond\u0007 line\u0000  '), 'pot\nsecond line');
  });

  it('keeps zero-width joiners that Indic text needs', () => {
    assert.ok(normalizeStory('क्‍ष').includes('‍'));
  });

  it('allows exactly 1,500 characters, counted as code points', () => {
    assert.equal(MAX_PRODUCT_STORY_LENGTH, 1500);
    assert.equal(storySchema.safeParse('a'.repeat(1500)).success, true);
    assert.equal(storySchema.safeParse('a'.repeat(1501)).success, false);
    assert.equal(storySchema.safeParse('😀'.repeat(1500)).success, true);
    assert.equal(codePointLength('😀😀'), 2);
  });

  it('measures after normalization, so expansion cannot exceed the cap', () => {
    assert.equal(storySchema.safeParse('ﷺ'.repeat(100)).success, false);
  });

  it('generation needs a non-blank story, saving does not', () => {
    assert.equal(generationStorySchema.safeParse('   ').success, false);
    assert.equal(generationStorySchema.safeParse('hello').success, true);
    assert.equal(storySchema.parse('   '), '');
  });
});

describe('price', () => {
  it('stores integer paise from a rupee string', () => {
    assert.equal(parsePriceRupees('1'), 100);
    assert.equal(parsePriceRupees('499.50'), 49950);
    assert.equal(parsePriceRupees('0.1'), null);
    assert.equal(parsePriceRupees('1.1'), 110);
    assert.equal(parsePriceRupees('1000000'), 100_000_000);
    assert.ok(Number.isSafeInteger(parsePriceRupees('19.99')));
  });

  it('enforces the 1 to 1,000,000 rupee range at both ends', () => {
    assert.equal(MIN_PRICE_PAISE, 100);
    assert.equal(MAX_PRICE_PAISE, 100_000_000);
    assert.equal(parsePriceRupees('0.99'), null);
    assert.equal(parsePriceRupees('0'), null);
    assert.equal(parsePriceRupees('1000000.01'), null);
    assert.equal(parsePriceRupees('1000001'), null);
  });

  it('rejects exponents, negatives, three decimals, separators and junk', () => {
    for (const bad of ['1e3', '-5', '1.234', '1,000', 'abc', '₹100', 'NaN', 'Infinity', '0x10']) {
      assert.equal(parsePriceRupees(bad), null, bad);
    }
  });

  it('treats a blank field as no price yet and rejects non-strings', () => {
    assert.equal(priceInputSchema.parse(''), null);
    assert.equal(priceInputSchema.parse('  '), null);
    assert.equal(priceInputSchema.parse(' 250 '), 25000);
    assert.equal(priceInputSchema.safeParse(250).success, false);
    assert.equal(priceInputSchema.safeParse('9'.repeat(30)).success, false);
  });
});

describe('translation input', () => {
  it('enforces 100, 1,200 and 250 characters at the boundaries', () => {
    const ok = { title: 'a'.repeat(MAX_TITLE_LENGTH), description: 'a'.repeat(MAX_DESCRIPTION_LENGTH), alt_text: 'a'.repeat(MAX_ALT_TEXT_LENGTH) };
    assert.equal(translationInputSchema.safeParse(ok).success, true);
    for (const key of ['title', 'description', 'alt_text']) {
      assert.equal(translationInputSchema.safeParse({ ...ok, [key]: `${ok[key]}a` }).success, false, key);
    }
  });

  it('cleans single-line fields and keeps description paragraphs', () => {
    const parsed = translationInputSchema.parse({ title: ' A\nB\u0007 ', description: 'one\r\ntwo', alt_text: ' x ' });
    assert.deepEqual(parsed, { title: 'A B', description: 'one\ntwo', alt_text: 'x' });
  });

  it('rejects unknown keys', () => {
    assert.equal(translationInputSchema.safeParse({ ...full(), price: 5 }).success, false);
  });
});

describe('review form', () => {
  it('parses a valid review into paise and de-duplicated approvals', () => {
    const parsed = productReviewSchema.parse(review({ approvedLanguages: ['en', 'en', 'gu'] }));
    assert.equal(parsed.price, 49950);
    assert.deepEqual(parsed.approvedLanguages, ['en', 'gu']);
  });

  it('rejects client-controlled store_id, status, is_demo and any other key', () => {
    for (const extra of [{ store_id: 'x' }, { storeId: 'x' }, { status: 'published' }, { is_demo: true }, { ai_status: 'idle' }]) {
      assert.equal(productReviewSchema.safeParse(review(extra)).success, false, JSON.stringify(extra));
    }
    assert.equal(productReviewSchema.safeParse(review({ translations: { en: full(), gu: full(), hi: full(), fr: full() } })).success, false);
    assert.equal(productReviewSchema.safeParse(review({ translations: { en: full(), gu: full() } })).success, false);
  });

  it('refuses to approve an incomplete language and names it', () => {
    const incomplete = { en: full(), gu: { ...full(), alt_text: '' }, hi: full() };
    const result = productReviewSchema.safeParse(review({ translations: incomplete, approvedLanguages: ['gu'] }));
    assert.equal(result.success, false);
    assert.deepEqual(result.error.issues[0].path, ['translations', 'gu']);
    const draft = review({ translations: { en: full(), gu: empty, hi: full() }, approvedLanguages: ['en'] });
    assert.equal(productReviewSchema.safeParse(draft).success, true);
  });

  it('publishing requires a price', () => {
    assert.equal(productReviewSchema.safeParse(review({ price: '', publish: true })).success, false);
    assert.equal(productReviewSchema.safeParse(review({ price: '', publish: false })).success, true);
    assert.equal(productReviewSchema.safeParse(review({ publish: true })).success, true);
  });

  it('rejects an unknown approved language and an out-of-range price', () => {
    assert.equal(productReviewSchema.safeParse(review({ approvedLanguages: ['fr'] })).success, false);
    assert.equal(productReviewSchema.safeParse(review({ price: '1000001' })).success, false);
  });
});

describe('request schemas', () => {
  it('generate accepts only a story', () => {
    assert.equal(generateRequestSchema.safeParse({ story: 'x' }).success, true);
    assert.equal(generateRequestSchema.safeParse({ story: 'x', store_id: 'y' }).success, false);
    assert.equal(generateRequestSchema.safeParse({ story: '' }).success, false);
  });

  it('product id must be a UUID and nothing else is allowed', () => {
    assert.equal(productIdParamsSchema.safeParse({ id: '22222222-2222-4222-8222-222222222222' }).success, true);
    assert.equal(productIdParamsSchema.safeParse({ id: '1; drop table products' }).success, false);
    assert.equal(productIdParamsSchema.safeParse({ id: '22222222-2222-4222-8222-222222222222', x: 1 }).success, false);
  });
});
