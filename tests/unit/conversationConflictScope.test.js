import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createConversationAgent } from '../../src/ai/conversationAgent.js';
import { createEnquiryTools } from '../../src/ai/tools/enquiryTools.js';
import { createBudgetedCall } from '../../src/services/budgetedCall.js';
import { createFakeBudgets, createFakeKnowledgeRepo } from '../helpers/assistantFakes.js';
import { createFakePublicRepo, translation } from '../helpers/publicFakes.js';

/*
 * A source conflict escalates only when the customer's latest message depends on the contested fact. The model is scripted (no live calls).
 */
const OWNER = { id: 'owner-1', isDemo: false };
const TIERS = [{ minQty: 10, percentOff: 5 }, { minQty: 25, percentOff: 10 }];
const NOTES = 'Little Moments Tea Lights: fragrance notes are amber, bergamot, orange, vanilla and coconut.\nGift wrapping is available on request.';
const PRODUCTS = [
  ['Little Moments Tea Lights', 'Scented tea lights in vanilla and lavender. Box of 10.', 34900, 40],
  ['Rose Petal Pillar Candle', 'Slow-burning pillar candle, 150 g.', 64900, 7],
  ['Vanilla Chai Travel Tin', 'Pocket-sized travel candle in a tin.', 44900, 30],
];
const NOTICE = 'Tea Lights fragrance differs between notes and description';
const CONFLICT = {
  topic: 'Fragrance of Little Moments Tea Lights',
  claims: [
    { label: 'seller_notes', excerpt: 'fragrance notes are amber, bergamot, orange, vanilla and coconut' },
    { label: 'product_description', excerpt: 'Scented tea lights in vanilla and lavender' },
  ],
};
let counter = 0;
const use = (name, input = {}) => ({ type: 'tool_use', id: `tu_${(counter += 1)}`, name, input });
const turn = (...content) => ({ content, stop_reason: 'tool_use' });
const finalTurn = (input) => turn(use('final_answer', input));
const asked = (body) => [{ role: 'customer', body }];

async function fixture({ language = 'en' } = {}) {
  const repo = createFakePublicRepo();
  const shop = repo.addShop({ defaultLanguage: 'en', name: 'Aranya Luxe', story: 'Candles from Gujarat.', tagline: 'Slow light' });
  PRODUCTS.forEach(([title, description, pricePaise, stock], index) => repo.addProduct(shop, {
    pricePaise, stock, createdAt: new Date(Date.UTC(2026, 10, 1) + (PRODUCTS.length - index) * 60_000).toISOString(), translations: { en: translation(title, description, `${title} alt`) },
  }));
  const knowledge = createFakeKnowledgeRepo();
  await knowledge.replaceContent(shop.id, NOTES, 'now');
  await knowledge.saveRules(shop.id, TIERS, 'now');
  const requests = [];
  const queue = [];
  const send = async (request) => {
    requests.push(structuredClone(request));
    return { response: queue.shift(), usage: { inputTokens: 100, outputTokens: 20 } };
  };
  const tools = createEnquiryTools({ storeId: shop.id, shop, language, shops: repo, knowledge, labelPlaceholders: true });
  const agent = createConversationAgent({ config: { apiKey: 'k', model: 'fake-model' }, send });
  const run = (script, message) => {
    queue.push(...script);
    return agent.run({
      shop, language, messages: asked(message), knowledge: { content: NOTES, bulkRules: TIERS }, tools,
      budgetedCall: createBudgetedCall({ budgets: createFakeBudgets() }), owner: OWNER, wallClockMs: 40_000,
    });
  };
  return { requests, run };
}

const quoteTurns = (final) => [turn(use('calculate_quote', { productId: 'p1', quantity: 25 })), finalTurn(final)];

describe('catalogue question with one contested product', () => {
  const LIST = 'We have Little Moments Tea Lights, Rose Petal Pillar Candle and Vanilla Chai Travel Tin. Gift wrapping is available on request.';

  it('lists every product, omits the contested attribute, records the seller notice and does not escalate', async () => {
    const h = await fixture();
    const result = await h.run([turn(use('search_products', {})), finalTurn({ outcome: 'answered', text: LIST, seller_notice: NOTICE })], 'What candles do you sell, any gift ideas?');
    assert.equal(result.ok, true);
    assert.equal(result.outcome, 'answered');
    for (const title of ['Little Moments Tea Lights', 'Rose Petal Pillar Candle', 'Vanilla Chai Travel Tin']) assert.ok(result.text.includes(title), title);
    assert.ok(!/lavender|amber|bergamot/i.test(result.text));
    assert.equal(result.conflict, null);
    assert.equal(result.trace.at(-1), `Assistant note for you: ${NOTICE}`);
  });

  it('drops a notice that carries an amount, and never puts the notice in the customer text', async () => {
    const h = await fixture();
    const result = await h.run([finalTurn({ outcome: 'answered', text: LIST, seller_notice: 'Price is Rs 500 in the notes' })], 'What candles do you sell?');
    assert.equal(result.ok, true);
    assert.ok(!result.text.includes('Price is'));
    assert.ok(!result.trace.some((entry) => entry.includes('Assistant note')));
  });

  it('keeps the notice entry even when the tool trace is full', async () => {
    const h = await fixture();
    const searches = Array.from({ length: 5 }, () => turn(use('search_products', {})));
    const result = await h.run([...searches, finalTurn({ outcome: 'answered', text: LIST, seller_notice: NOTICE })], 'What candles do you sell?');
    assert.ok(result.trace.length <= 12);
    assert.equal(result.trace.at(-1), `Assistant note for you: ${NOTICE}`);
  });
});

describe('affects_question', () => {
  const ASK = 'What are the exact fragrance notes of the Little Moments Tea Lights?';

  it('still escalates a question about the contested fact, with both quotes', async () => {
    const h = await fixture();
    const result = await h.run([finalTurn({ outcome: 'conflict', conflict: { ...CONFLICT, affects_question: 'EXACT  fragrance notes' } })], ASK);
    assert.equal(result.outcome, 'conflict');
    assert.deepEqual(result.conflict.claims.map((claim) => claim.label), ['seller_notes', 'product_description']);
  });

  it('rejects a fabricated or non-matching affects_question and fails safely after one retry', async () => {
    for (const affects of ['the burn time of the candles', 'fragrance notes of the Rose Petal Pillar Candle', 'ab']) {
      const h = await fixture();
      const bad = finalTurn({ outcome: 'conflict', conflict: { ...CONFLICT, affects_question: affects } });
      const result = await h.run([bad, bad], ASK);
      assert.equal(result.ok, false, affects);
      assert.equal(result.reason, 'invalid_output');
    }
  });

  it('tells the model to answer or use needs_seller, and accepts the answer that follows', async () => {
    const h = await fixture();
    const bad = finalTurn({ outcome: 'conflict', conflict: { ...CONFLICT, affects_question: 'burn time' } });
    const note = 'The shop information does not say how long the candles burn.';
    const result = await h.run([bad, finalTurn({ outcome: 'needs_seller', text: note })], 'How long do the candles last?');
    assert.equal(result.outcome, 'needs_seller');
    const retry = JSON.stringify(h.requests[1].messages.at(-1));
    assert.match(retry, /LATEST message/);
    assert.match(retry, /needs_seller/);
  });

  it('a 25-box quote with an unrelated conflict shows the total', async () => {
    const h = await fixture();
    const text = '25 boxes: {{label.total}} {{q1.total}}, with {{label.discount}} {{q1.discount}}.';
    const result = await h.run(quoteTurns({ outcome: 'answered', text, seller_notice: NOTICE }), 'How much for 25 boxes of Little Moments Tea Lights?');
    assert.equal(result.ok, true, result.reason);
    assert.equal(result.outcome, 'answered');
    assert.match(result.text, /total ₹7,852.50/);
    assert.match(result.text, /discount ₹872.50/);
  });
});

describe('contested facts are never volunteered', () => {
  it('rejects an answer that states the fact the model itself named in seller_notice, then accepts one that omits it', async () => {
    const h = await fixture();
    const notice = 'Tea Lights fragrance notes are amber, bergamot and vanilla in notes but lavender in description';
    const volunteered = finalTurn({ outcome: 'answered', text: 'The Little Moments Tea Lights have fragrance notes are amber, bergamot and vanilla.', seller_notice: notice });
    const omitted = finalTurn({ outcome: 'answered', text: 'The Little Moments Tea Lights come in a box of 10.', seller_notice: notice });
    const result = await h.run([volunteered, omitted], 'Tell me about the tea lights');
    assert.equal(result.ok, true, `${result.reason} ${result.detail}`);
    assert.ok(!/amber/.test(result.text));
    assert.match(JSON.stringify(h.requests[1].messages.at(-1)), /Never state a contested fact/);
  });

  it('the system rules forbid stating a contested fact, even incidentally, and limit volunteering to what was asked', async () => {
    const h = await fixture();
    await h.run([finalTurn({ outcome: 'needs_seller', text: 'Not sure about that.' })], 'Hello');
    assert.match(h.requests[0].system, /Never state a contested fact, not even in passing/);
    assert.match(h.requests[0].system, /Only volunteer facts the customer asked about/);
    assert.match(h.requests[0].system, /do NOT escalate/);
  });
});

describe('labels come from the customer language strings', () => {
  it('Gujarati labels are the Gujarati strings', async () => {
    const h = await fixture({ language: 'gu' });
    const text = '૨૫ બોક્સ: {{label.total}} {{q1.total}}, {{label.discount}} {{q1.discount}}.';
    const result = await h.run(quoteTurns({ outcome: 'answered', language: 'gu', text }), 'Little Moments Tea Lights ના 25 બોક્સની કુલ કિંમત કેટલી થશે?');
    assert.equal(result.ok, true, result.reason);
    assert.match(result.text, /કુલ ₹7,852.50, છૂટ ₹872.50/);
  });

  it('Hindi labels are the Hindi strings, including the stock wording a tool supplies', async () => {
    const h = await fixture({ language: 'hi' });
    const text = 'जी हाँ, यह उपलब्ध है: 40 {{label.in_stock}}, {{label.unit_price}} {{p1.price}}।';
    const result = await h.run([turn(use('search_products', {})), finalTurn({ outcome: 'answered', language: 'hi', text })], 'क्या Little Moments Tea Lights मिलेंगे?');
    assert.equal(result.ok, true, result.reason);
    assert.match(result.text, /40 स्टॉक में, प्रति नग कीमत ₹349.00/);
  });

  it('flags English label words in a Gujarati or Hindi reply, and unknown label placeholders', async () => {
    const cases = [['gu', 'કુલ કિંમત: Total {{q1.total}} છે.'], ['hi', 'यह Unit price {{q1.unit_price}} है।'], ['gu', '{{label.shipping}} {{q1.total}} છે.']];
    for (const [language, text] of cases) {
      const h = await fixture({ language });
      const bad = finalTurn({ outcome: 'answered', language, text });
      const result = await h.run([turn(use('calculate_quote', { productId: 'p1', quantity: 25 })), bad, bad], 'Little Moments Tea Lights');
      assert.equal(result.reason, 'invalid_output', text);
    }
  });

  it('English replies resolve the label placeholders to the English strings', async () => {
    const h = await fixture();
    const result = await h.run(quoteTurns({ outcome: 'answered', text: 'Quote: {{label.total}} {{q1.total}}.' }), 'Price for 25 Little Moments Tea Lights?');
    assert.match(result.text, /Quote: total ₹7,852.50/);
  });
});
