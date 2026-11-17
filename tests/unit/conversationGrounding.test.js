import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createConversationAgent } from '../../src/ai/conversationAgent.js';
import { createEnquiryTools } from '../../src/ai/tools/enquiryTools.js';
import { createBudgetedCall } from '../../src/services/budgetedCall.js';
import { createFakeBudgets, createFakeKnowledgeRepo } from '../helpers/assistantFakes.js';
import { createFakePublicRepo, translation } from '../helpers/publicFakes.js';

/*
 * Regression scenarios from the Module 7 production test of the Aranya Luxe storefront. The model is scripted (no live calls); what is
 * under test is everything around it: what the tools retrieve, what reaches the model, and what the backend accepts or refuses.
 */
const NOTE = 'This is an estimate. The seller will confirm.';
const OWNER = { id: 'owner-1', isDemo: false };
const TIERS = [{ minQty: 10, percentOff: 5 }, { minQty: 25, percentOff: 10 }];
const SOY = 'Hand-poured in a glass jar. 100% soy wax, 200 g, burns for about 45 hours.';
const CANDLES = [
  ['Cashmere Jar Candle', SOY, 89900, 12], ['Amber Noir Jar Candle', SOY, 99900, 8], ['Sandalwood Jar Candle', SOY, 94900, 5],
  ['Jasmine Dusk Jar Candle', SOY, 84900, 20], ['Rose Petal Pillar Candle', 'Slow-burning pillar candle, 150 g.', 64900, 7], ['Vanilla Chai Travel Tin', 'Pocket-sized travel candle in a tin.', 44900, 30],
];
let counter = 0;
const use = (name, input = {}) => ({ type: 'tool_use', id: `tu_${(counter += 1)}`, name, input });
const turn = (...content) => ({ content, stop_reason: 'tool_use' });
const finalTurn = (input) => turn(use('final_answer', input));
const said = (...bodies) => bodies.map((body, index) => ({ role: index % 2 === 0 ? 'customer' : 'assistant', body }));

async function shopFixture({ products = CANDLES, tiers = [], document = 'Gift wrapping is available on request.', language = 'en', history, translationsOf } = {}) {
  const repo = createFakePublicRepo();
  const shop = repo.addShop({ defaultLanguage: 'en', name: 'Aranya Luxe', story: 'Luxury candles from Gujarat.', tagline: 'Slow light' });
  const rows = products.map(([title, description, pricePaise, stock], index) => repo.addProduct(shop, {
    pricePaise, stock, createdAt: new Date(Date.UTC(2026, 10, 1) + (products.length - index) * 60_000).toISOString(),
    translations: translationsOf?.(title, description) ?? { en: translation(title, description, `${title} alt`) },
  }));
  const knowledge = createFakeKnowledgeRepo();
  await knowledge.replaceContent(shop.id, document, 'now');
  await knowledge.saveRules(shop.id, tiers, 'now');
  const requests = [];
  const queue = [];
  const send = async (request) => {
    requests.push(structuredClone(request));
    const step = queue.shift();
    if (!step) throw new Error('script exhausted');
    return { response: step, usage: { inputTokens: 100, outputTokens: 20 } };
  };
  const tools = createEnquiryTools({ storeId: shop.id, shop, language, shops: repo, knowledge });
  const agent = createConversationAgent({ config: { apiKey: 'k', model: 'fake-model' }, send });
  const run = (script, { historyOverride } = {}) => {
    queue.push(...script);
    return agent.run({
      shop, language, messages: historyOverride ?? history ?? said('Hello'), knowledge: { content: document, bulkRules: tiers }, tools, quoteNote: NOTE,
      budgetedCall: createBudgetedCall({ budgets: createFakeBudgets() }), owner: OWNER, wallClockMs: 40_000,
    });
  };
  return { shop, rows, repo, tools, requests, run };
}

describe('failure 1: product discovery returns the whole published catalogue', () => {
  it('a broad search (empty, or words no title contains) lists every published product with price, stock and description', async () => {
    const { tools } = await shopFixture();
    for (const query of [{}, { query: '' }, { query: 'scented candles as a gift' }]) {
      const { content } = await tools.run('search_products', query);
      assert.equal(content.products.length, CANDLES.length, JSON.stringify(query));
      for (const product of content.products) {
        assert.match(product.price, /^\{\{p\d+\.price\}\}$/);
        assert.ok(product.stock);
        assert.ok(typeof product.description === 'string' && product.description.length > 0, product.title);
      }
    }
  });

  it('returns more than the old twenty-product cap, up to the 48 the storefront shows', async () => {
    const many = Array.from({ length: 40 }, (_, index) => [`Candle number ${index + 1}`, 'A candle.', 10000 + index, 3]);
    const { tools } = await shopFixture({ products: many });
    assert.equal((await tools.run('search_products', {})).content.products.length, 40);
  });

  it('caps at the 48 products the storefront shows and says that more exist, instead of dropping them silently', async () => {
    const many = Array.from({ length: 55 }, (_, index) => [`Candle number ${index + 1}`, 'A candle.', 10000 + index, 3]);
    const { content } = await (await shopFixture({ products: many })).tools.run('search_products', {});
    assert.equal(content.products.length, 48);
    assert.equal(content.more_products_exist, true);
  });

  it('never lists a draft product or another shop\'s product, in a search or in the preloaded records', async () => {
    const h = await shopFixture();
    h.repo.addProduct(h.shop, { status: 'draft', translations: { en: translation('Secret Draft Candle', 'Not public.', 'alt') } });
    const other = h.repo.addShop({ slug: 'test-other' });
    h.repo.addProduct(other, { translations: { en: translation('Foreign Candle', 'Someone else.', 'alt') } });
    const listed = (await h.tools.run('search_products', {})).content.products.map((product) => product.title);
    assert.equal(listed.length, CANDLES.length);
    assert.ok(!listed.includes('Secret Draft Candle') && !listed.includes('Foreign Candle'));
    assert.deepEqual(await h.tools.recordsFor(['Foreign Candle and Secret Draft Candle'], null), []);
  });

  it('a specific search ranks the closer match first but never hides the others behind a hard filter', async () => {
    const { tools } = await shopFixture();
    const { content } = await tools.run('search_products', { query: 'Cashmere Jar Candles' });
    assert.equal(content.products[0].title, 'Cashmere Jar Candle');
  });

  it('lets the model list descriptive figures such as "100% soy wax, 200 g" without tripping the price guard', async () => {
    const h = await shopFixture();
    const text = 'Cashmere Jar Candle at {{p1.price}}: 100% soy wax, 200 g, about 45 hours of burn time. Amber Noir Jar Candle at {{p2.price}}: also 100% soy wax.';
    const result = await h.run([turn(use('search_products', {})), finalTurn({ outcome: 'answered', text, sources: [{ label: 'live_catalog' }] })]);
    assert.equal(result.ok, true, result.reason);
    assert.match(result.text, /₹899.00/);
    assert.match(result.text, /100% soy wax/);
  });

  it('still refuses a typed price, and a percentage used as a discount even when "100%" appears in a description', async () => {
    for (const text of ['The Cashmere Jar Candle costs 899 rupees.', 'Cashmere Jar Candle: {{p1.price}}. Take 100% off today!', 'Cashmere Jar Candle: {{p1.price}}, now 20% off.']) {
      const h = await shopFixture();
      const result = await h.run([turn(use('search_products', {})), finalTurn({ outcome: 'answered', text })]);
      assert.equal(result.reason, 'unverified_amount', text);
    }
  });
});

describe('failure 2: live price and stock for a named product', () => {
  it('finds the product when the customer uses the plural, and in any language the shop translated the title into', async () => {
    const gu = (title) => ({ en: translation(title, SOY, 'alt'), gu: translation(`${title} (ગુ)`, 'ગ્લાસ જારમાં હાથે બનાવેલી મીણબત્તી.', 'alt') });
    const { tools } = await shopFixture({ language: 'gu', translationsOf: (title) => gu(title) });
    const { content } = await tools.run('search_products', { query: 'Cashmere Jar Candles' });
    assert.equal(content.products[0].title, 'Cashmere Jar Candle (ગુ)');
  });

  it('answers price, stock and "can I order 5" from live data when stock covers it', async () => {
    const h = await shopFixture();
    const text = 'The Cashmere Jar Candle is {{p1.price}} each. 12 are available right now, so you can order all 5: {{q1.total}} for 5.';
    const result = await h.run([
      turn(use('search_products', { query: 'Cashmere Jar Candles' })), turn(use('calculate_quote', { productId: 'p1', quantity: 5 })),
      finalTurn({ outcome: 'answered', text, sources: [{ label: 'live_catalog' }] }),
    ], { historyOverride: said('I want to buy 5 Cashmere Jar Candles. What is the price, how many are available, can I order all 5?') });
    assert.equal(result.ok, true, result.reason);
    assert.match(result.text, /₹899.00 each/);
    assert.match(result.text, /₹4,495.00/);
  });

  it('when stock is short it reports the live stock and price instead of the generic "not found", and still escalates', async () => {
    const h = await shopFixture({ products: [['Cashmere Jar Candle', SOY, 89900, 3]] });
    const result = await h.run([
      turn(use('search_products', {})), turn(use('calculate_quote', { productId: 'p1', quantity: 5 })),
      finalTurn({ outcome: 'answered', text: 'Yes, 5 are available for {{q1.total}}.' }),
    ]);
    assert.equal(result.outcome, 'needs_seller');
    assert.deepEqual(result.stockShortage, { title: 'Cashmere Jar Candle', requested: 5, available: 3, unitPricePaise: 89900 });
  });
});

describe('failure 3: contradicting written sources are shown to the model and escalated', () => {
  const NOTES = 'Little Moments Tea Lights: fragrance notes are amber, bergamot, orange, vanilla and coconut.\nGift wrapping is available on request.';
  const TEA = ['Little Moments Tea Lights', 'Scented tea lights in vanilla and lavender. Box of 10.', 34900, 40];

  it('puts the description of a product the customer names in front of the model BEFORE its first call, next to the notes', async () => {
    const h = await shopFixture({ products: [TEA], document: NOTES });
    const ask = 'Tell me about the fragrance of the Little Moments Tea Lights. Are they vanilla and lavender, or amber, bergamot, orange, vanilla and coconut?';
    await h.run([finalTurn({ outcome: 'needs_seller', text: 'Not sure.' })], { historyOverride: said(ask) });
    const first = h.requests[0].messages[0].content;
    assert.match(first, /<product_records>/);
    assert.match(first, /vanilla and lavender/);
    assert.match(h.requests[0].system, /amber, bergamot, orange, vanilla and coconut/);
  });

  it('accepts the conflict with the description quote even though the model never called check_product, and keeps both values for the seller', async () => {
    const h = await shopFixture({ products: [TEA], document: NOTES });
    const result = await h.run([finalTurn({ outcome: 'conflict', conflict: { topic: 'Fragrance notes of Little Moments Tea Lights', affects_question: 'exact fragrance notes', claims: [
      { label: 'seller_notes', excerpt: 'fragrance notes are amber, bergamot, orange, vanilla and coconut' },
      { label: 'product_description', excerpt: 'Scented tea lights in vanilla and lavender' },
    ] } })], { historyOverride: said('What are the exact fragrance notes of the Little Moments Tea Lights?') });
    assert.equal(result.outcome, 'conflict');
    assert.deepEqual(result.conflict.claims.map((claim) => claim.label), ['seller_notes', 'product_description']);
  });

  it('refuses a conflict whose quote is not really in the sources', async () => {
    const h = await shopFixture({ products: [TEA], document: NOTES });
    const bad = { outcome: 'conflict', conflict: { topic: 'Fragrance', affects_question: 'What fragrance', claims: [{ label: 'seller_notes', excerpt: 'fragrance notes are amber, bergamot, orange, vanilla and coconut' }, { label: 'product_description', excerpt: 'smells of fresh rain' }] } };
    const result = await h.run([finalTurn(bad), finalTurn(bad)], { historyOverride: said('What fragrance?') });
    assert.equal(result.reason, 'invalid_output');
  });
});

describe('failure 4: multi-turn bulk quote, answered in Gujarati', () => {
  const BOX = ['Little Moments Tea Lights', 'Scented tea lights. Box of 10.', 34900, 60];
  const GU_FIRST = 'મને Little Moments Tea Lights ના 10 બોક્સ જોઈએ છે. શું બલ્ક ડિસ્કાઉન્ટ મળે?';
  const GU_SECOND = 'જો હું 25 બોક્સ મંગાવું તો કુલ કિંમત કેટલી થશે? કૃપા કરીને ગુજરાતીમાં સમજાવો.';
  const history = said(GU_FIRST, 'તમને 5% ડિસ્કાઉન્ટ મળશે.', GU_SECOND);

  it('keeps the earlier turns and the product they named, without the follow-up naming it again', async () => {
    const h = await shopFixture({ products: [BOX], tiers: TIERS, history });
    await h.run([finalTurn({ outcome: 'needs_seller', text: 'ખબર નથી.', language: 'gu' })]);
    const first = h.requests[0].messages[0].content;
    assert.ok(first.indexOf(GU_FIRST) < first.indexOf(GU_SECOND));
    assert.match(first, /<product_records>[\s\S]*Little Moments Tea Lights/);
    assert.equal(h.tools.refs.get('p1.price'), 34900);
  });

  it('computes from the confirmed tiers and replies in Gujarati even though the page language is English', async () => {
    const h = await shopFixture({ products: [BOX], tiers: TIERS, history });
    const answer = '25 બોક્સનો કુલ ભાવ {{q1.total}} થશે, જેમાં 10% ડિસ્કાઉન્ટ આવી ગયું છે.';
    const result = await h.run([
      turn(use('calculate_quote', { productId: 'p1', quantity: 25 })),
      finalTurn({ outcome: 'answered', language: 'gu', text: answer, sources: [{ label: 'live_catalog' }] }),
    ]);
    assert.equal(result.ok, true, result.reason);
    assert.match(result.text, /₹7,852.50/);
    assert.match(h.requests[0].system, /Gujarati/);
  });

  it('refuses a Gujarati answer that declares English, or an English answer that declares Gujarati', async () => {
    for (const [declared, body] of [['en', '25 બોક્સનો કુલ ભાવ {{q1.total}} થશે.'], ['gu', 'The total for 25 boxes is {{q1.total}}.']]) {
      const h = await shopFixture({ products: [BOX], tiers: TIERS, history });
      const bad = finalTurn({ outcome: 'answered', language: declared, text: body });
      const result = await h.run([turn(use('calculate_quote', { productId: 'p1', quantity: 25 })), bad, bad]);
      assert.equal(result.reason, 'invalid_output', declared);
    }
  });

  it('with no confirmed discount it quotes the plain price honestly and escalates in Gujarati instead of inventing one', async () => {
    const h = await shopFixture({ products: [BOX], tiers: [], history });
    const note = '25 બોક્સનો કુલ ભાવ {{q1.total}} છે. કોઈ પુષ્ટિ થયેલ બલ્ક ડિસ્કાઉન્ટ નથી; વેચનાર તેની પુષ્ટિ કરશે.';
    const result = await h.run([turn(use('calculate_quote', { productId: 'p1', quantity: 25 })), finalTurn({ outcome: 'needs_seller', language: 'gu', text: note })]);
    assert.equal(result.outcome, 'needs_seller');
    assert.match(result.text, /₹8,725.00/);
    const invented = await shopFixture({ products: [BOX], tiers: [], history });
    const lie = await invented.run([turn(use('calculate_quote', { productId: 'p1', quantity: 25 })), finalTurn({ outcome: 'answered', language: 'gu', text: '25 બોક્સ પર 10% ડિસ્કાઉન્ટ મળશે, કુલ {{q1.total}}.' })]);
    assert.equal(lie.reason, 'unverified_amount');
  });
});

describe('unknown information still escalates, with a specific reason', () => {
  it('needs_seller must say what is missing; an empty one is rejected and retried', async () => {
    const h = await shopFixture();
    const result = await h.run([finalTurn({ outcome: 'needs_seller' }), finalTurn({ outcome: 'needs_seller', text: 'The shop information does not say whether the candles can be engraved.' })]);
    assert.equal(result.outcome, 'needs_seller');
    assert.match(result.text, /engraved/);
  });

  it('a product that does not exist returns an honest tool error', async () => {
    const { tools } = await shopFixture();
    const { content } = await tools.run('check_product', { productId: 'p99' });
    assert.equal(content.error, 'This product is not available in this shop.');
  });
});
