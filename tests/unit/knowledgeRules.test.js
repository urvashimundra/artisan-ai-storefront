import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ZodError } from 'zod';
import {
  MAX_KNOWLEDGE_LENGTH, bestTier, calculateQuote, knowledgeSchema, nextTier, parseRulesForm, rulesFormValues, tiersSchema,
} from '../../src/domain/knowledgeRules.js';

const TIERS = [{ minQty: 10, percentOff: 5 }, { minQty: 25, percentOff: 10 }];

describe('knowledge document schema', () => {
  it('accepts up to 20,000 code points (Gujarati counted per character) and rejects more', () => {
    assert.equal(knowledgeSchema.parse({ content: 'અ'.repeat(MAX_KNOWLEDGE_LENGTH) }).content.length, MAX_KNOWLEDGE_LENGTH);
    assert.throws(() => knowledgeSchema.parse({ content: 'x'.repeat(MAX_KNOWLEDGE_LENGTH + 1) }), ZodError);
    assert.equal(knowledgeSchema.parse({ content: '' }).content, '');
  });

  it('rejects unknown keys such as a store id', () => {
    assert.throws(() => knowledgeSchema.parse({ content: 'x', store_id: 'abc' }), ZodError);
  });
});

describe('bulk tiers', () => {
  it('limits: at most 5, quantity 2 to 1000, percent 1 to 50, strictly increasing', () => {
    const tier = (minQty, percentOff) => ({ minQty, percentOff });
    assert.ok(tiersSchema.safeParse([]).success);
    assert.ok(tiersSchema.safeParse([tier(2, 1), tier(1000, 50)]).success);
    for (const bad of [[tier(1, 5)], [tier(1001, 5)], [tier(2, 0)], [tier(2, 51)], [tier(2.5, 5)], [tier(5, 5), tier(5, 6)], [tier(9, 5), tier(3, 6)],
      [2, 3, 4, 5, 6, 7].map((n) => tier(n, 5)), [{ minQty: 5, percentOff: 5, extra: 1 }]]) {
      assert.equal(tiersSchema.safeParse(bad).success, false, JSON.stringify(bad));
    }
  });

  it('parses the form, skips empty rows and rejects half-filled rows, junk and unknown keys', () => {
    assert.deepEqual(parseRulesForm({ minQty1: '10', percentOff1: '5', minQty2: '', percentOff2: '', minQty3: '25', percentOff3: '10' }), TIERS);
    assert.deepEqual(parseRulesForm({}), []);
    assert.throws(() => parseRulesForm({ minQty1: '10', percentOff1: '' }), ZodError);
    assert.throws(() => parseRulesForm({ minQty1: 'ten', percentOff1: '5' }), ZodError);
    assert.throws(() => parseRulesForm({ minQty1: '10', percentOff1: '5', store_id: 'x' }), ZodError);
    assert.throws(() => parseRulesForm({ minQty1: '25', percentOff1: '5', minQty2: '10', percentOff2: '6' }), ZodError);
    assert.deepEqual(rulesFormValues(TIERS), { minQty1: '10', percentOff1: '5', minQty2: '25', percentOff2: '10' });
  });

  it('picks the highest tier reached and the next one above', () => {
    assert.equal(bestTier(TIERS, 9), null);
    assert.equal(bestTier(TIERS, 10).percentOff, 5);
    assert.equal(bestTier(TIERS, 24).percentOff, 5);
    assert.equal(bestTier(TIERS, 25).percentOff, 10);
    assert.equal(nextTier(TIERS, 9).minQty, 10);
    assert.equal(nextTier(TIERS, 25), null);
  });
});

describe('quote arithmetic (integer paise)', () => {
  it('applies only the confirmed tier at the exact boundary', () => {
    const below = calculateQuote({ unitPricePaise: 25000, quantity: 9, tiers: TIERS, stock: null });
    assert.equal(below.discountPaise, 0);
    assert.equal(below.totalPaise, 225000);
    const at = calculateQuote({ unitPricePaise: 25000, quantity: 10, tiers: TIERS, stock: null });
    assert.equal(at.subtotalPaise, 250000);
    assert.equal(at.discountPercent, 5);
    assert.equal(at.discountPaise, 12500);
    assert.equal(at.totalPaise, 237500);
  });

  it('rounds the discount down to whole paise', () => {
    const quote = calculateQuote({ unitPricePaise: 333, quantity: 10, tiers: [{ minQty: 2, percentOff: 7 }], stock: null });
    assert.equal(quote.subtotalPaise, 3330);
    assert.equal(quote.discountPaise, 233);
    assert.equal(quote.totalPaise, 3097);
    assert.ok(Number.isInteger(quote.discountPaise) && Number.isInteger(quote.totalPaise));
  });

  it('reports whether stock covers the quantity and never mutates tiers', () => {
    assert.equal(calculateQuote({ unitPricePaise: 100, quantity: 6, tiers: [], stock: 5 }).stockCovers, false);
    assert.equal(calculateQuote({ unitPricePaise: 100, quantity: 5, tiers: [], stock: 5 }).stockCovers, true);
    assert.equal(calculateQuote({ unitPricePaise: 100, quantity: 50, tiers: [], stock: null }).stockCovers, true);
  });

  it('rejects an out-of-range quantity or price', () => {
    for (const quantity of [0, 1001, 1.5]) assert.throws(() => calculateQuote({ unitPricePaise: 100, quantity, tiers: [], stock: null }), RangeError);
    assert.throws(() => calculateQuote({ unitPricePaise: 1.5, quantity: 2, tiers: [], stock: null }), RangeError);
  });
});

describe('quote tiers at every threshold', () => {
  const percentAt = (quantity, tiers = TIERS) => calculateQuote({ unitPricePaise: 25000, quantity, tiers, stock: null }).discountPercent;

  it('gives the right percentage immediately below, at and above each threshold', () => {
    const expected = [[1, 0], [9, 0], [10, 5], [11, 5], [24, 5], [25, 10], [26, 10], [1000, 10]];
    for (const [quantity, percent] of expected) assert.equal(percentAt(quantity), percent, `quantity ${quantity}`);
  });

  it('does not depend on the order of the tiers', () => {
    const shuffled = [TIERS[1], TIERS[0]];
    for (const quantity of [9, 10, 24, 25, 26]) assert.equal(percentAt(quantity, shuffled), percentAt(quantity), `quantity ${quantity}`);
    assert.equal(nextTier(shuffled, 9).minQty, 10);
    assert.equal(nextTier(shuffled, 10).minQty, 25);
  });

  it('keeps integer paise and rounds down at each threshold', () => {
    for (const quantity of [9, 10, 24, 25, 26]) {
      const quote = calculateQuote({ unitPricePaise: 333, quantity, tiers: TIERS, stock: null });
      assert.equal(quote.subtotalPaise - quote.discountPaise, quote.totalPaise);
      assert.ok(Number.isInteger(quote.discountPaise) && Number.isInteger(quote.totalPaise));
      assert.equal(quote.discountPaise, Math.floor((333 * quantity * quote.discountPercent) / 100));
    }
  });
});
