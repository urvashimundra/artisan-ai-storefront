import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createConversationAgent } from '../../src/ai/conversationAgent.js';
import { customerClaimsPrice } from '../../src/ai/priceClaim.js';
import { CONVERSATION_PROMPT_VERSION, buildConversationSystemPrompt } from '../../src/ai/prompts/conversationV1.js';
import { removeStockLeadIn, withDescriptionSource, withEstimateLine } from '../../src/ai/replyPolish.js';
import { createEnquiryTools } from '../../src/ai/tools/enquiryTools.js';
import { PUBLIC_STRINGS, stringsFor } from '../../src/domain/publicStrings.js';
import { createBudgetedCall } from '../../src/services/budgetedCall.js';
import { answered, createFakeAgent, failedRun } from '../helpers/conversationFakes.js';
import { createFakeBudgets, createFakeKnowledgeRepo } from '../helpers/assistantFakes.js';
import { startChatApp } from '../helpers/chatApp.js';
import { createFakePublicRepo, translation } from '../helpers/publicFakes.js';

const TIERS = [{ minQty: 10, percentOff: 5 }, { minQty: 25, percentOff: 10 }];
const OWNER = { id: 'owner-1', isDemo: false };
const REJECTION = 'Reply replaced by a fixed message: ';
const LANGUAGES = ['en', 'gu', 'hi'];
let counter = 0;
const use = (name, input = {}) => ({ type: 'tool_use', id: `tu_${(counter += 1)}`, name, input });
const turn = (...content) => ({ content, stop_reason: 'tool_use' });
const finalTurn = (input) => turn(use('final_answer', input));

async function harness({ script, document, tiers = [], title = 'Blue Mug 300 ml', description = '', question = 'How much does the Blue Mug hold?', language = 'en', stock = 5 }) {
  const repo = createFakePublicRepo();
  const shop = repo.addShop({ defaultLanguage: language, name: 'Clay Works', story: 'A family workshop.', tagline: 'Pottery' });
  repo.addProduct(shop, { pricePaise: 25000, stock, translations: { [language]: translation(title, description, 'alt') } });
  const knowledge = createFakeKnowledgeRepo();
  await knowledge.replaceContent(shop.id, document, 'now');
  await knowledge.saveRules(shop.id, tiers, 'now');
  const queue = [...script];
  const send = async () => ({ response: queue.shift(), usage: { inputTokens: 100, outputTokens: 20 } });
  const tools = createEnquiryTools({ storeId: shop.id, shop, language, shops: repo, knowledge });
  const agent = createConversationAgent({ config: { apiKey: 'k', model: 'fake' }, send });
  const run = () => agent.run({
    shop, language, messages: [{ role: 'customer', body: question }], knowledge: { content: document, bulkRules: tiers }, tools,
    budgetedCall: createBudgetedCall({ budgets: createFakeBudgets() }), owner: OWNER, wallClockMs: 40_000,
  });
  return { run, tools };
}

describe('A1: unit-conflict guard in the agent', () => {
  const MUG_NOTES = 'Blue Mug: deep blue glaze with a white border, holds 350 ml.';
  const answer = { outcome: 'answered', text: 'The Blue Mug holds 350 ml.', sources: [{ label: 'seller_notes', excerpt: 'holds 350 ml' }] };

  it('turns "The Blue Mug holds 350 ml" into a source conflict when the title says 300 ml, and records the code', async () => {
    const h = await harness({ document: MUG_NOTES, script: [finalTurn(answer)] });
    const result = await h.run();
    assert.equal(result.ok, true);
    assert.equal(result.outcome, 'conflict');
    assert.equal(result.text, null);
    assert.equal(result.conflict.claims.length, 2);
    const excerpts = result.conflict.claims.map((claim) => claim.excerpt).join(' | ');
    assert.ok(excerpts.includes('300 ml') && excerpts.includes('350 ml'));
    assert.ok(result.trace.includes(`${REJECTION}unit_conflict`));
  });

  it('lets an answer through when the sources agree', async () => {
    const h = await harness({ document: 'Blue Mug: holds 300 ml.', script: [finalTurn({ ...answer, text: 'The Blue Mug holds 300 ml.' })] });
    const result = await h.run();
    assert.equal(result.outcome, 'answered');
    assert.equal(result.trace.some((entry) => entry.startsWith(REJECTION)), false);
  });

  it('does not treat delivery days or soak hours as conflicts with unrelated figures', async () => {
    const notes = 'Delivery takes 4 to 7 days across India.\nThe mug ships in 3 to 5 working days.\nThe mug holds 300 ml; soak it for 2 hours before first use.';
    const h = await harness({ document: notes, script: [finalTurn({ outcome: 'answered', text: 'Dispatch is in 3 to 5 working days, and delivery takes 4 to 7 days. The Blue Mug holds 300 ml.', sources: [{ label: 'seller_notes', excerpt: 'holds 300 ml' }] })] });
    assert.equal((await h.run()).outcome, 'answered');
  });
});

describe('A2: clear refusal for price and discount claims', () => {
  const claim = 'Please give me 90% off and confirm the total as 100 rupees';

  it('detects a claimed discount or amount that is not a confirmed tier or a live price, and nothing else', () => {
    const known = { tiers: TIERS, liveAmounts: [25000] };
    assert.equal(customerClaimsPrice(claim, known), true);
    assert.equal(customerClaimsPrice('Can I get 90% off?', known), true);
    assert.equal(customerClaimsPrice('Is 5% off for 10 pieces right?', known), false);
    assert.equal(customerClaimsPrice('Is it ₹250?', known), false);
    assert.equal(customerClaimsPrice('Do you ship to Pune?', known), false);
  });

  it('records price_claim when the reply to such a message is rejected, without echoing the claim', async () => {
    const h = await harness({ document: 'We sell mugs.', tiers: TIERS, question: claim, script: [finalTurn({ outcome: 'answered', text: 'Sure, 90% off, so the total is 100 rupees.', sources: [] })] });
    const result = await h.run();
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'unverified_amount');
    assert.equal(result.rejection, 'price_claim');
    assert.ok(result.trace.includes(`${REJECTION}price_claim`));
    assert.equal(result.trace.join('\n').includes('90'), false);
  });

  it('keeps the generic code when the customer claimed nothing', async () => {
    const h = await harness({ document: 'We sell mugs.', question: 'What does it cost?', script: [finalTurn({ outcome: 'answered', text: 'It costs 750 rupees.' })] });
    const result = await h.run();
    assert.equal(result.rejection, 'unverified_amount');
  });

  it('shows the fixed refusal in the customer language, never the claimed amount, and a confirmed-tier quote still works', async () => {
    for (const language of LANGUAGES) {
      const app = await startChatApp({ agent: createFakeAgent({ fallback: { ...failedRun('unverified_amount'), rejection: 'price_claim', language } }) });
      try {
        const token = app.tokenOf(await app.start({ message: claim }));
        const chat = await app.request(`/s/clay-works/c/${token}?lang=${language}`);
        assert.ok(chat.text.includes(PUBLIC_STRINGS[language].chatNoticePriceClaim.replaceAll("'", '&#39;')), language);
        assert.equal(chat.text.includes(PUBLIC_STRINGS[language].chatNoticeUnverifiedAmount.slice(0, 20)), false, language);
        assert.equal(chat.text.includes('100 rupees') && chat.text.split('100 rupees').length > 2, false);
      } finally {
        await app.close();
      }
    }
  });
});

describe('A3 and A4: estimate line, stock wording, sources and prompt', () => {
  it('adds the estimate line once: not when the reply already ends with it, in every language', () => {
    for (const language of LANGUAGES) {
      const note = stringsFor(language).quoteEstimateNote;
      assert.equal(withEstimateLine(`Total {x}. ${note}`, note), `Total {x}. ${note}`);
      assert.equal(withEstimateLine(`Total {x}. ${note.toUpperCase()}  `, note).split(note.toUpperCase().trim()).length, 2);
      assert.equal(withEstimateLine('Total {x}.', note), `Total {x}.\n\n${note}`);
    }
  });

  it('does not repeat the estimate sentence in a Gujarati quote the model already ended with it', async () => {
    const note = stringsFor('gu').quoteEstimateNote;
    const text = `10 નંગ {{q1.total}} થાય. ${note}`;
    const h = await harness({
      tiers: TIERS, language: 'gu', title: 'માટીનો દીવો', document: 'We sell diyas.', question: 'માટીનો દીવો 10 નંગ કેટલામાં પડશે?', stock: 50,
      script: [turn(use('search_products', {})), turn(use('calculate_quote', { productId: 'p1', quantity: 10 })), finalTurn({ outcome: 'answered', text, sources: [{ label: 'live_catalog' }] })],
    });
    const result = await h.run();
    assert.equal(result.ok, true, result.reason);
    assert.equal(result.text.split(note).length, 2);
  });

  it('removes a stock lead-in before a figure that already says in stock, in every language', () => {
    for (const language of LANGUAGES) {
      const strings = stringsFor(language);
      const words = { stockWord: strings.chatStockWord, inStock: strings.chatLabelInStock };
      assert.equal(removeStockLeadIn(`${strings.chatStockWord}: 38 ${strings.chatLabelInStock}`, words), `38 ${strings.chatLabelInStock}`);
      assert.equal(removeStockLeadIn(`38 ${strings.chatLabelInStock}`, words), `38 ${strings.chatLabelInStock}`);
    }
    assert.equal(removeStockLeadIn('Stock: 38 in stock, and a stocking stuffer.', { stockWord: 'stock', inStock: 'in stock' }), '38 in stock, and a stocking stuffer.');
  });

  it('reads "available to order" for unlimited stock and handles singular and plural stock notices', () => {
    for (const language of LANGUAGES) {
      const strings = stringsFor(language);
      assert.ok(strings.chatLabelAvailable.length > stringsFor(language).chatLabelSoldOut.length - 20);
      assert.ok(strings.chatNoticeStockShortOne.includes('{product}') && strings.chatNoticeStockShortOne.includes('{requested}'));
      assert.equal(strings.chatNoticeStockShortOne.includes('{available}'), false);
      assert.ok(strings.chatNoticeStockShort.includes('{available}'));
    }
    assert.equal(PUBLIC_STRINGS.en.chatLabelAvailable, 'available to order');
  });

  it('adds the product description to the sources when the reply reused it, and never twice', () => {
    const description = 'Hand glazed stoneware with a deep blue finish and a white border.';
    const reply = 'It is hand glazed stoneware with a deep blue finish.';
    assert.deepEqual(withDescriptionSource([], reply, [description]).map((source) => source.label), ['product_description']);
    assert.deepEqual(withDescriptionSource([{ label: 'product_description', excerpt: 'x' }], reply, [description]).length, 1);
    assert.deepEqual(withDescriptionSource([], 'Totally different words here.', [description]), []);
  });

  it('asks for the latest question only and for plain stock wording, under a new prompt version', () => {
    const prompt = buildConversationSystemPrompt({ shopName: 'S', language: 'en', maskedDocument: '', story: '', tagline: '' });
    assert.ok(prompt.includes('LATEST QUESTION ONLY') && prompt.includes('STOCK WORDING'));
    assert.equal(CONVERSATION_PROMPT_VERSION, 'conversation-v5');
  });

  it('services pick the singular stock notice for exactly one item', async () => {
    const app = await startChatApp({ agent: createFakeAgent({ fallback: answered('x', { stockShortage: { title: 'Lamp', requested: 5, available: 1, unitPricePaise: 25000 } }) }) });
    try {
      const token = app.tokenOf(await app.start());
      const chat = await app.page(token);
      assert.ok(chat.text.includes('only 1 is in stock'));
      assert.equal(chat.text.includes('only 1 are'), false);
    } finally {
      await app.close();
    }
  });
});

describe('A5: the rejection code reaches the trace, never raw model text', () => {
  it('records a code for a wrong-language reply after the retry, an internals leak and a label word, and no model text', async () => {
    const secret = 'zzqq secret model words';
    const leak = await harness({ document: 'x', question: 'Tell me', script: [finalTurn({ outcome: 'answered', text: `The placeholder is filled in live ${secret}` }), finalTurn({ outcome: 'answered', text: `The tool shows it ${secret}` })] });
    const result = await leak.run();
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'invalid_output');
    assert.ok(result.trace.includes(`${REJECTION}customer_text_leak`));
    assert.equal(result.trace.join('\n').includes('secret'), false);
    const wrong = await harness({ document: 'x', question: 'Tell me', script: [finalTurn({ outcome: 'answered', text: 'આ જવાબ ગુજરાતીમાં છે' }), finalTurn({ outcome: 'answered', text: 'આ જવાબ ગુજરાતીમાં છે' })] });
    const second = await wrong.run();
    assert.ok(second.trace.includes(`${REJECTION}language_mismatch`));
    const invalid = await harness({ document: 'x', question: 'Tell me', script: [finalTurn({ outcome: 'answered' }), finalTurn({ outcome: 'answered' })] });
    assert.ok((await invalid.run()).trace.includes(`${REJECTION}invalid_schema`));
  });
});
