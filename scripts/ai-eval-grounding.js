/*
 * Small LIVE evaluation of the four Module 7 grounding scenarios. Developer tool: NOT part of `npm test`, never run in CI.
 *   node --env-file=.env scripts/ai-eval-grounding.js
 * Uses ANTHROPIC_API_KEY and CLAUDE_MODEL from the environment (it prints the model id, never the key). The shop, products and notes are
 * synthetic; the database is in-memory fakes, so nothing is read from or written to Supabase and no real budget is touched. A hard cap
 * stops the run before the provider is called more than MAX_PROVIDER_CALLS times in total.
 */
import Anthropic from '@anthropic-ai/sdk';
import { randomUUID } from 'node:crypto';
import { createConversationAgent } from '../src/ai/conversationAgent.js';
import { createConversationService } from '../src/services/conversationService.js';
import { createFakeBudgets } from '../tests/helpers/assistantFakes.js';
import { createFakeKnowledgeRepo } from '../tests/helpers/assistantFakes.js';
import { createFakeConversationRepo } from '../tests/helpers/conversationFakes.js';
import { createFakePublicRepo, translation } from '../tests/helpers/publicFakes.js';

const MAX_PROVIDER_CALLS = 12;
const MICRO_USD_PER_USD = 1_000_000;
const SOY = 'Hand-poured in a glass jar. 100% soy wax, 200 g, burns for about 45 hours.';
const PRODUCTS = [
  ['Cashmere Jar Candle', SOY, 89900, 12],
  ['Amber Noir Jar Candle', SOY, 99900, 8],
  ['Sandalwood Jar Candle', SOY, 94900, 5],
  ['Jasmine Dusk Jar Candle', SOY, 84900, 20],
  ['Rose Petal Pillar Candle', 'Slow-burning pillar candle, 150 g.', 64900, 7],
  ['Little Moments Tea Lights', 'Scented tea lights in vanilla and lavender. Box of 10.', 34900, 60],
];
const NOTES = [
  'Gift wrapping is available on request and is free.',
  'Delivery across India takes 4 to 6 days.',
  'Little Moments Tea Lights: fragrance notes are amber, bergamot, orange, vanilla and coconut.',
].join('\n');
const TIERS = [{ minQty: 10, percentOff: 5 }, { minQty: 25, percentOff: 10 }];
const GU_FIRST = 'મને Little Moments Tea Lights ના 10 બોક્સ જોઈએ છે. શું બલ્ક ડિસ્કાઉન્ટ મળે?';

const calls = { used: 0, toolsThisStep: [] };
const logs = [];

function capped(options) {
  const client = new Anthropic(options);
  const create = client.messages.create.bind(client.messages);
  client.messages.create = async (request, requestOptions) => {
    if (calls.used >= MAX_PROVIDER_CALLS) throw new Error('eval provider-call cap reached');
    calls.used += 1;
    const response = await create(request, requestOptions);
    for (const block of response.content ?? []) {
      if (block.type === 'tool_use') calls.toolsThisStep.push(block.name === 'final_answer' ? `final_answer(${block.input?.outcome})` : `${block.name}(${JSON.stringify(block.input)})`);
    }
    return response;
  };
  return client;
}

function fixture() {
  const shops = createFakePublicRepo();
  const shop = shops.addShop({ slug: 'test-eval-aranya', name: 'Aranya Luxe', defaultLanguage: 'en', story: 'Luxury candles from Gujarat.', tagline: 'Slow light' });
  PRODUCTS.forEach(([title, description, pricePaise, stock], index) => shops.addProduct(shop, {
    pricePaise, stock, createdAt: new Date(Date.UTC(2026, 10, 1) + (PRODUCTS.length - index) * 60_000).toISOString(),
    translations: { en: translation(title, description, `${title} photo`) },
  }));
  const conversations = createFakeConversationRepo();
  const knowledge = createFakeKnowledgeRepo();
  const agent = createConversationAgent({ config: { apiKey: process.env.ANTHROPIC_API_KEY, model: process.env.CLAUDE_MODEL ?? 'claude-haiku-5-5' }, createClient: capped });
  const logger = { info: (message, fields) => logs.push({ message, ...fields }), warn: () => {}, error: (message, fields) => logs.push({ message, ...fields }) };
  const service = createConversationService({
    shops, conversations, knowledge, agent, budgets: createFakeBudgets(), emails: { enqueueSellerEnquiryAlert: async () => {} }, logger,
  });
  return { shop, knowledge, conversations, service };
}

async function report(name, step, { conversations }) {
  const conversation = [...conversations.conversations.values()][0];
  const reply = conversations.messages.filter((message) => message.conversationId === conversation.id && message.role === 'assistant').at(-1);
  const run = logs.filter((entry) => entry.message === 'conversation answered').at(-1);
  console.log(`\n=== ${name} (${step}) ===`);
  console.log(`tool calls: ${calls.toolsThisStep.join(' -> ') || '(none)'}`);
  console.log(`model calls this step: ${run?.steps ?? '?'} | status: ${conversation.status} | flag_reason: ${conversation.flagReason ?? 'none'} | message kind: ${reply?.kind}`);
  console.log(`final text: ${reply?.body}`);
  if (reply?.conflict) console.log(`conflict: ${JSON.stringify(reply.conflict)}`);
  console.log(`cost: ${(run?.costMicroUsd ?? 0) / MICRO_USD_PER_USD} USD (${run?.tokIn} in / ${run?.tokOut} out tokens)`);
  calls.toolsThisStep = [];
}

async function scenario(name, turns) {
  const env = fixture();
  await env.knowledge.replaceContent(env.shop.id, NOTES, 'now');
  await env.knowledge.saveRules(env.shop.id, TIERS, 'now');
  const phone = `98${Math.floor(Math.random() * 1e8).toString().padStart(8, '0')}`;
  let token = null;
  for (const [index, message] of turns.entries()) {
    const body = { name: 'Eval', phone, message, messageId: randomUUID(), startKey: randomUUID() };
    if (index === 0) token = (await env.service.start(env.shop.slug, {}, body, { correlationId: name })).token;
    else await env.service.post(env.shop.slug, token, {}, { message, messageId: body.messageId }, { correlationId: name });
    await report(name, `turn ${index + 1}`, env);
  }
}

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY is not set');
  console.log(`model: ${process.env.CLAUDE_MODEL ?? 'claude-haiku-5-5'} | provider-call cap: ${MAX_PROVIDER_CALLS}`);
  await scenario('1 catalogue + gift recommendation', ["I'm looking for scented candles as a gift. Can you show me all the candles available in your store, with their names, prices and a short description? Also, which one would you recommend as a gift?"]);
  await scenario('2 price, stock, orderable', ['I want to buy 5 Cashmere Jar Candles. What is the current price per candle, how many are available right now, and can I order all 5?']);
  await scenario('3 fragrance conflict', ['Tell me about the fragrance of the Little Moments Tea Lights. What are the exact fragrance notes? Are they vanilla and lavender, or amber, bergamot, orange, vanilla and coconut?']);
  await scenario('4 Gujarati bulk follow-up', [GU_FIRST, 'If I order 25 boxes instead, what would the total price be? Please explain in Gujarati.']);
  console.log(`\nprovider calls used: ${calls.used}/${MAX_PROVIDER_CALLS}`);
}

main().catch((error) => {
  console.error(`eval stopped: ${error.message} | provider calls used: ${calls.used}/${MAX_PROVIDER_CALLS}`);
  process.exitCode = 1;
});
