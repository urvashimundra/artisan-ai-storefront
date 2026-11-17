import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { descriptiveFigures } from '../../src/ai/knowledgeSources.js';
import { resolveMoney } from '../../src/ai/moneyPlaceholders.js';
import { detectIndicLanguage } from '../../src/ai/scriptCheck.js';
import { MAX_NAMED_PRODUCTS, namedEntries, rankByQuery, termsOf } from '../../src/domain/productSearch.js';

const entry = (titles, description = '') => ({ titles: [].concat(titles), description });
const CATALOGUE = [
  entry('Cashmere Jar Candle', 'Soy wax candle in a glass jar.'),
  entry(['Little Moments Tea Lights', 'લિટલ મોમેન્ટ્સ ટી લાઇટ્સ'], 'Scented tea lights, box of 10.'),
  entry('Brass Diya', 'A hand-cast brass lamp.'),
];

describe('product search words', () => {
  it('lower-cases, drops filler and strips English plurals only', () => {
    assert.deepEqual(termsOf('Show me the Candles, boxes and glasses'), ['candle', 'box', 'glass']);
    assert.deepEqual(termsOf('ટી લાઇટ્સ'), ['ટી', 'લાઇટ્સ']);
    assert.deepEqual(termsOf(undefined), []);
  });
});

describe('ranking a query against the catalogue', () => {
  it('finds a title in the plural, singular or in any translated title', () => {
    for (const query of ['Cashmere Jar Candles', 'cashmere jar candle', 'a jar candle please']) {
      assert.equal(rankByQuery(CATALOGUE, query).entries[0], CATALOGUE[0], query);
    }
    assert.equal(rankByQuery(CATALOGUE, 'લિટલ મોમેન્ટ્સ').entries[0], CATALOGUE[1]);
    assert.equal(rankByQuery(CATALOGUE, 'tea light').entries[0], CATALOGUE[1]);
  });

  it('matches the description when no title matches, and ranks title matches above description matches', () => {
    const { entries } = rankByQuery(CATALOGUE, 'brass lamp');
    assert.equal(entries[0], CATALOGUE[2]);
    assert.equal(rankByQuery([entry('Gift box', 'a candle'), entry('Candle', '')], 'candle').entries[0].titles[0], 'Candle');
  });

  it('with no usable words every product matches; with words that match nothing the WHOLE catalogue comes back, flagged', () => {
    for (const query of [undefined, '', '   ', 'the of and']) assert.deepEqual(rankByQuery(CATALOGUE, query), { entries: CATALOGUE, matched: true });
    assert.deepEqual(rankByQuery(CATALOGUE, 'bicycle helmet'), { entries: CATALOGUE, matched: false });
  });
});

describe('products a conversation names', () => {
  it('names a product by most of its title in any customer message, in any language', () => {
    assert.deepEqual(namedEntries(CATALOGUE, ['I want 5 cashmere jar candles']), [CATALOGUE[0]]);
    assert.deepEqual(namedEntries(CATALOGUE, ['મને લિટલ મોમેન્ટ્સ ટી લાઇટ્સ જોઈએ છે']), [CATALOGUE[1]]);
    assert.deepEqual(namedEntries(CATALOGUE, ['What is the price of the brass diya?', 'and the candle?']), [CATALOGUE[2]]);
  });

  it('does not name a product from one generic word, and never names more than a few', () => {
    assert.deepEqual(namedEntries(CATALOGUE, ['do you have any candles?']), []);
    const many = Array.from({ length: 10 }, (_, index) => entry(`Soy Candle ${index}`));
    assert.equal(namedEntries(many, ['soy candle']).length, MAX_NAMED_PRODUCTS);
  });
});

describe('descriptive figures versus prices and discounts', () => {
  const refs = new Map([['p1.price', 89900]]);
  const ask = (text, texts = ['Soy wax candle. 100% soy wax, 200 g, burns about 45 hours. Save 20% on the festival set.']) =>
    resolveMoney(text, { refs, allowedPercents: [5], allowedNumbers: [12], descriptive: descriptiveFigures(texts), maxLength: 3000 });

  it('reads the plain figures a text states, but not currency amounts, placeholders or a written offer', () => {
    assert.deepEqual(descriptiveFigures(['Weighs 200 g. ₹499 only. {{d1.amount}}. 100% soy wax. Save 20%.']), { numbers: [200, 100, 20], percents: [100] });
  });

  it('lets an answer repeat "100% soy wax, 200 g, 45 hours" as written', () => {
    assert.equal(ask('At {{p1.price}}: 100% soy wax, 200 g, burns about 45 hours.').ok, true);
  });

  it('still refuses figures no source states, a source figure used as a price, and any discount that is not confirmed', () => {
    for (const text of [
      'At {{p1.price}}: 300 g.', 'It costs 200.', 'Price 200 for you.', 'The jar is {{p1.price}}, now 100% off.', 'Take 20% off.', 'Save 20% on the festival set.', 'Special: 7% discount.',
    ]) assert.equal(ask(text).ok, false, text);
  });

  it('confirmed percentages and tool figures keep working next to descriptive ones', () => {
    assert.equal(ask('12 are in stock with 5% off, 100% soy wax.').ok, true);
  });
});

describe('which language a customer is writing in', () => {
  it('detects Gujarati and Devanagari messages even with a Latin product name inside, and leaves Latin text alone', () => {
    assert.equal(detectIndicLanguage('મને Little Moments Tea Lights ના 10 બોક્સ જોઈએ છે'), 'gu');
    assert.equal(detectIndicLanguage('मुझे दस डिब्बे चाहिए'), 'hi');
    assert.equal(detectIndicLanguage('I want ten boxes'), null);
    assert.equal(detectIndicLanguage('12345 ?!'), null);
    assert.equal(detectIndicLanguage(''), null);
  });
});
