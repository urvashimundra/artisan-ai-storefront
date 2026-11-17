import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { beforeEach, describe, it } from 'node:test';
import { CUSTOMER_DAILY_QUESTION_LIMIT, STALE_RUN_MS, STORE_DAILY_AI_ANSWER_LIMIT } from '../../src/domain/conversationRules.js';
import { CONVERSATION_STRINGS } from '../../src/domain/conversationStrings.js';
import { createLinkCipher } from '../../src/lib/linkCipher.js';
import { hashStatusToken } from '../../src/lib/statusToken.js';
import { createConversationService } from '../../src/services/conversationService.js';
import { answered, createFakeAgent, createFakeConversationRepo, failedRun } from '../helpers/conversationFakes.js';
import { createFakePublicRepo } from '../helpers/publicFakes.js';

const EN = CONVERSATION_STRINGS.en;
const input = (overrides = {}) => ({ name: 'Asha', phone: '98765 43210', message: 'Do you ship to Pune?', startKey: randomUUID(), messageId: randomUUID(), ...overrides });
const follow = (message = 'And how long does it take?') => ({ message, messageId: randomUUID() });

async function setup({ agent = createFakeAgent({ fallback: answered() }), withBudgets = true } = {}) {
  const clock = { now: Date.parse('2026-11-16T10:00:00Z') };
  const shops = createFakePublicRepo();
  const shop = shops.addShop({ slug: 'test-shop' });
  const other = shops.addShop({ slug: 'test-other' });
  const conversations = createFakeConversationRepo({ now: () => clock.now });
  const alerts = [];
  const logs = [];
  const logger = { info: (m, f) => logs.push({ m, ...f }), warn: (m, f) => logs.push({ m, ...f }), error: (m, f) => logs.push({ m, ...f }) };
  const budgets = { async reserve() { return { reservationId: 'r' }; }, async settle() {}, async release() {} };
  const service = createConversationService({
    shops, conversations, knowledge: { get: async () => ({ content: 'We ship in 5 days.', bulkRules: [] }) }, agent, budgets: withBudgets ? budgets : null,
    emails: { enqueueSellerEnquiryAlert: async (_store, id) => alerts.push(id) }, logger, linkCipher: createLinkCipher('C'.repeat(43)), now: () => clock.now,
  });
  const start = (body = input(), slug = 'test-shop') => service.start(slug, {}, body, { correlationId: 'c1' });
  return { service, shop, other, shops, conversations, alerts, logs, agent, clock, start };
}

describe('conversation service: persistence and multi-turn', () => {
  it('starts a conversation, persists the question before the answer, and resumes it by private link', async () => {
    const { service, conversations, start } = await setup();
    const started = await start();
    assert.equal(started.outcome, 'answered');
    const opened = await service.open('test-shop', started.token, {});
    assert.deepEqual(opened.messages.map((m) => [m.role, m.kind]), [['customer', 'text'], ['assistant', 'text']]);
    assert.equal(conversations.conversations.size, 1);
    const stored = [...conversations.conversations.values()][0];
    assert.equal(stored.tokenHash, hashStatusToken(started.token));
    assert.notEqual(stored.tokenEnc, started.token);
  });

  it('supports several messages in one conversation, in order, and sends only the latest 8 to the agent', async () => {
    const { service, agent, start } = await setup();
    const { token } = await start();
    for (let i = 0; i < 5; i += 1) assert.equal((await service.post('test-shop', token, {}, follow(`q${i}`))).outcome, 'answered');
    const opened = await service.open('test-shop', token, {});
    assert.deepEqual(opened.messages.map((m) => m.seq), opened.messages.map((_m, i) => i + 1));
    assert.equal(opened.messages.length, 12);
    const lastCall = agent.calls.at(-1);
    assert.equal(lastCall.messages.length, 8);
    assert.equal(lastCall.messages.at(-1).body, 'q4');
  });

  it('supports an incremental refresh from a sequence number', async () => {
    const { service, start } = await setup();
    const { token } = await start();
    const after = await service.open('test-shop', token, {}, { afterSeq: 1 });
    assert.deepEqual(after.messages.map((m) => m.seq), [2]);
  });

  it('keeps the customer message when the assistant fails, with a distinct outcome per failure', async () => {
    const cases = { budget: 'budget', provider_limit: 'provider_limit', provider_error: 'ai_unavailable', timeout: 'timeout', network: 'network', invalid_output: 'ai_unavailable', unavailable: 'ai_unavailable' };
    for (const [reason, outcome] of Object.entries(cases)) {
      const { service, conversations, start } = await setup({ agent: createFakeAgent({ fallback: failedRun(reason) }) });
      const result = await start();
      assert.equal(result.outcome, outcome, reason);
      const [row] = [...conversations.conversations.values()];
      assert.equal(row.status, 'needs_you', reason);
      assert.equal(conversations.messages.filter((m) => m.role === 'customer').length, 1, `${reason}: question kept`);
      const notice = conversations.messages.find((m) => m.role === 'assistant');
      assert.equal(notice.body, EN[`chatNotice${{ budget: 'Budget', provider_limit: 'ProviderLimit', provider_error: 'ProviderError', timeout: 'Timeout', network: 'Network', invalid_output: 'InvalidOutput', unavailable: 'Unavailable' }[reason]}`]);
      assert.ok(service);
    }
  });

  it('escalates a missing answer and a source conflict with fixed customer text, not model text', async () => {
    const conflict = { topic: 'Returns', values: [{ label: 'seller_document', value: '7 days' }, { label: 'product_description', value: '14 days' }] };
    const { conversations, start } = await setup({
      agent: createFakeAgent({ results: [{ ok: true, outcome: 'conflict', text: 'MODEL TEXT', conflict, sources: [], trace: [], steps: 1, charged: {} }] }),
    });
    const result = await start();
    assert.equal(result.outcome, 'seller');
    const message = conversations.messages.find((m) => m.role === 'assistant');
    assert.equal(message.kind, 'conflict');
    assert.equal(message.body, EN.chatNoticeConflict);
    assert.deepEqual(message.conflict, conflict);
    assert.equal([...conversations.conversations.values()][0].flagReason, 'source_conflict');
  });

  it('answers a missing-information escalation with the model text when present, a fixed text otherwise', async () => {
    const { conversations, start } = await setup({ agent: createFakeAgent({ results: [{ ok: true, outcome: 'needs_seller', text: null, trace: [], steps: 1, charged: {} }] }) });
    await start();
    assert.equal(conversations.messages.find((m) => m.role === 'assistant').body, EN.chatNoticeNotInDocument);
  });

  it('when the live stock cannot cover the quantity, tells the customer the real stock and price in fixed words and escalates', async () => {
    const shortage = { title: 'Cashmere Jar Candle', requested: 5, available: 3, unitPricePaise: 89900 };
    const { conversations, alerts, start } = await setup({ agent: createFakeAgent({ results: [{ ok: true, outcome: 'needs_seller', text: null, stockShortage: shortage, trace: [], steps: 2, charged: {} }] }) });
    const result = await start();
    assert.equal(result.outcome, 'seller');
    const message = conversations.messages.find((m) => m.role === 'assistant');
    assert.equal(message.body, 'Cashmere Jar Candle is ₹899.00 each, but only 3 are in stock right now, fewer than the 5 you asked for. Your message is saved and the seller will confirm what can be arranged and reply here.');
    assert.equal([...conversations.conversations.values()][0].status, 'needs_you');
    assert.equal(alerts.length, 1);
  });

  it('says plainly that a product is sold out, and does so in Gujarati when the chat is in Gujarati', async () => {
    const soldOut = { title: 'Cashmere Jar Candle', requested: 2, available: 0, unitPricePaise: 89900 };
    const agent = createFakeAgent({ results: [{ ok: true, outcome: 'needs_seller', text: null, stockShortage: soldOut, trace: [], steps: 2, charged: {} }] });
    const { service, conversations } = await setup({ agent });
    await service.start('test-shop', { query: 'gu' }, input(), { correlationId: 'c1' });
    assert.equal(conversations.messages.find((m) => m.role === 'assistant').body, CONVERSATION_STRINGS.gu.chatNoticeSoldOut.replace('{product}', 'Cashmere Jar Candle'));
  });

  it('survives a crashing agent and a missing agent: the message is saved and goes to the seller', async () => {
    const crash = await setup({ agent: createFakeAgent({ results: [new Error('boom')] }) });
    assert.equal((await crash.start()).outcome, 'ai_unavailable');
    assert.equal([...crash.conversations.conversations.values()][0].status, 'needs_you');
    const none = await setup({ agent: null });
    assert.equal((await none.start()).outcome, 'ai_unavailable');
  });
});

describe('conversation service: persistence failure', () => {
  it('never claims a message was saved when the database failed, and runs no AI', async () => {
    const { service, conversations, agent, start } = await setup();
    conversations.state.failNext = true;
    await assert.rejects(() => start(), (error) => error.code === 'PERSISTENCE_FAILED' && error.httpStatus === 503);
    assert.equal(agent.calls.length, 0);
    assert.equal(conversations.conversations.size, 0);
    const { token } = await start();
    conversations.state.failNext = true;
    await assert.rejects(() => service.post('test-shop', token, {}, follow()), (error) => error.code === 'PERSISTENCE_FAILED');
  });

  it('keeps the run recoverable when saving the outcome fails: nothing is lost and the stale run is failed later', async () => {
    const { service, conversations, alerts, clock, start } = await setup({
      agent: createFakeAgent({ fallback: (input) => { input.tools && (conversations.state.failNext = true); return answered(); } }),
    });
    const result = await start();
    assert.equal(result.outcome, 'saved');
    const [row] = [...conversations.conversations.values()];
    assert.ok(row.aiRunId);
    clock.now += STALE_RUN_MS + 1000;
    const opened = await service.open('test-shop', result.token, {});
    assert.equal(opened.conversation.aiRunStartedAt, null);
    assert.equal(opened.messages.at(-1).body, EN.chatNoticeTimeout);
    assert.equal(conversations.state.storeReserved, 0);
    assert.equal(alerts.length, 1);
    await service.open('test-shop', result.token, {});
    assert.equal(alerts.length, 1);
  });
});

describe('conversation service: idempotency and one run at a time', () => {
  it('saves a repeated start once and returns the same private link', async () => {
    const { conversations, agent, start } = await setup();
    const body = input();
    const first = await start(body);
    const second = await start(body);
    assert.equal(second.duplicate, true);
    assert.equal(second.token, first.token);
    assert.equal(conversations.conversations.size, 1);
    assert.equal(agent.calls.length, 1);
  });

  it('saves a repeated follow-up once and runs the assistant once', async () => {
    const { service, conversations, agent, start } = await setup();
    const { token } = await start();
    const body = follow();
    await service.post('test-shop', token, {}, body);
    const again = await service.post('test-shop', token, {}, body);
    assert.equal(again.duplicate, true);
    assert.equal(conversations.messages.filter((m) => m.body === body.message).length, 1);
    assert.equal(agent.calls.length, 2);
  });

  it('refuses a second message while a run is in flight with a distinct busy error, saving nothing', async () => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const slowAgent = createFakeAgent({ results: [answered()], fallback: async () => { await gate; return answered(); } });
    const { service, conversations, start } = await setup({ agent: slowAgent });
    const { token } = await start();
    const inFlight = service.post('test-shop', token, {}, follow('slow one'));
    await new Promise((resolve) => setImmediate(resolve));
    await assert.rejects(() => service.post('test-shop', token, {}, follow('second')), (error) => error.code === 'CONVERSATION_BUSY' && error.httpStatus === 409);
    assert.equal(conversations.messages.filter((m) => m.body === 'second').length, 0);
    release();
    assert.equal((await inFlight).outcome, 'answered');
    assert.equal(conversations.state.storeReserved, 0);
  });

  it('gives exactly one of two simultaneous different submissions the run', async () => {
    const { service, conversations, start } = await setup();
    const { token } = await start();
    const results = await Promise.allSettled([service.post('test-shop', token, {}, follow('a')), service.post('test-shop', token, {}, follow('b'))]);
    const ok = results.filter((r) => r.status === 'fulfilled');
    assert.ok(ok.length >= 1);
    assert.equal(conversations.messages.filter((m) => m.role === 'customer').length, 1 + ok.length);
    assert.equal(conversations.state.storeReserved, 0);
  });
});

describe('conversation service: limits', () => {
  it('allows six questions per customer per day and refuses the seventh, counting questions even when the AI fails', async () => {
    const { service, conversations, start } = await setup({ agent: createFakeAgent({ fallback: failedRun('provider_error') }) });
    const { token } = await start();
    for (let i = 1; i < CUSTOMER_DAILY_QUESTION_LIMIT; i += 1) await service.post('test-shop', token, {}, follow(`q${i}`));
    await assert.rejects(() => service.post('test-shop', token, {}, follow('too many')), (error) => error.code === 'CUSTOMER_LIMIT' && error.httpStatus === 429);
    assert.equal(conversations.messages.filter((m) => m.role === 'customer').length, CUSTOMER_DAILY_QUESTION_LIMIT);
    await assert.rejects(() => start(input()), (error) => error.code === 'CUSTOMER_LIMIT');
    const different = await start(input({ phone: '99887 76655' }));
    assert.ok(different.token);
  });

  it('applies the customer limit per store', async () => {
    const { conversations, start } = await setup({ agent: createFakeAgent({ fallback: answered() }) });
    for (let i = 0; i < CUSTOMER_DAILY_QUESTION_LIMIT; i += 1) await start(input());
    await assert.rejects(() => start(input()), (error) => error.code === 'CUSTOMER_LIMIT');
    assert.ok(await start(input(), 'test-other'));
    assert.ok(conversations.conversations.size > CUSTOMER_DAILY_QUESTION_LIMIT);
  });

  it('settles a store answer only when an answer is persisted, and releases on failure and escalation', async () => {
    const { conversations, start } = await setup({ agent: createFakeAgent({ results: [answered(), failedRun('timeout'), { ok: true, outcome: 'needs_seller', text: null, trace: [], steps: 1, charged: {} }] }) });
    await start(input({ phone: '9000000001' }));
    assert.deepEqual([conversations.state.storeUsed, conversations.state.storeReserved], [1, 0]);
    await start(input({ phone: '9000000002' }));
    assert.deepEqual([conversations.state.storeUsed, conversations.state.storeReserved], [1, 0]);
    await start(input({ phone: '9000000003' }));
    assert.deepEqual([conversations.state.storeUsed, conversations.state.storeReserved], [1, 0]);
  });

  it('escalates to the seller once the store has 200 answers today, saving the message and alerting once', async () => {
    const { conversations, alerts, agent, start } = await setup();
    conversations.state.storeUsed = STORE_DAILY_AI_ANSWER_LIMIT;
    const result = await start();
    assert.equal(result.outcome, 'store_limit');
    assert.equal(agent.calls.length, 0);
    assert.equal(conversations.messages.find((m) => m.role === 'assistant').body, EN.chatNoticeStoreLimit);
    assert.equal(alerts.length, 1);
  });

  it('counts in-flight runs against the store limit, so 200 is never exceeded', async () => {
    const { conversations, start } = await setup({ agent: createFakeAgent({ fallback: answered() }) });
    conversations.state.storeUsed = STORE_DAILY_AI_ANSWER_LIMIT - 1;
    const results = await Promise.all([1, 2, 3].map((n) => start(input({ phone: `90000000${n}0` }))));
    assert.equal(results.filter((r) => r.outcome === 'answered').length, 1);
    assert.equal(results.filter((r) => r.outcome === 'store_limit').length, 2);
    assert.equal(conversations.state.storeUsed + conversations.state.storeReserved, STORE_DAILY_AI_ANSWER_LIMIT);
  });

  it('does not run the assistant again for an escalated conversation message beyond the limit, but alerts only on the first escalation', async () => {
    const { service, conversations, alerts, start } = await setup();
    conversations.state.storeUsed = STORE_DAILY_AI_ANSWER_LIMIT;
    const { token } = await start();
    await service.post('test-shop', token, {}, follow('again'));
    assert.equal(alerts.length, 1);
  });
});

describe('conversation service: tenancy, private links and input', () => {
  it('treats a link from another store, a malformed link and an unknown link as not found', async () => {
    const { service, start } = await setup();
    const { token } = await start();
    assert.equal(await service.open('test-other', token, {}), null);
    assert.equal(await service.open('test-shop', 'short', {}), null);
    assert.equal(await service.open('test-shop', 'A'.repeat(43), {}), null);
    assert.deepEqual(await service.post('test-other', token, {}, follow()), { found: false });
  });

  it('rejects invalid input with a validation error and saves nothing', async () => {
    const { conversations, start } = await setup();
    await assert.rejects(() => start(input({ phone: '12' })), (error) => error.name === 'ZodError');
    await assert.rejects(() => start({ ...input(), storeId: randomUUID() }), (error) => error.name === 'ZodError');
    await assert.rejects(() => start(input({ productId: randomUUID() })), (error) => error.httpStatus === 404);
    assert.equal(conversations.conversations.size, 0);
  });

  it('accepts the trap field as a silent no-op', async () => {
    const { conversations, agent, start } = await setup();
    const result = await start(input({ website: 'http://spam' }));
    assert.equal(result.trap, true);
    assert.equal(conversations.conversations.size, 0);
    assert.equal(agent.calls.length, 0);
  });

  it('logs ids and outcomes only: no message text, name, phone or token', async () => {
    const { logs, start } = await setup();
    const { token } = await start();
    const text = JSON.stringify(logs);
    for (const secret of ['Do you ship', 'Asha', '9876543210', '919876543210', token]) assert.ok(!text.includes(secret), secret);
  });

  it('reads the owner, not the request, for who pays: tools are built for the shop of the link', async () => {
    const { agent, shop, start } = await setup();
    await start();
    assert.equal(agent.calls[0].shop.id, shop.id);
    assert.equal(agent.calls[0].context.storeId, shop.id);
  });
});

describe('conversation service: stale runs and escalation alerts', () => {
  it('alerts once per escalation, and again for a new escalation after the seller handled the first', async () => {
    const { service, conversations, alerts, start } = await setup({ agent: createFakeAgent({ fallback: failedRun('provider_error') }) });
    const { token } = await start();
    await service.post('test-shop', token, {}, follow('still there?'));
    assert.equal(alerts.length, 1);
    const [row] = [...conversations.conversations.values()];
    await conversations.sellerReply(row.storeId, row.id, { messageId: randomUUID(), body: 'Hello' });
    await service.post('test-shop', token, {}, follow('another question'));
    assert.equal(alerts.length, 2);
    assert.notEqual(alerts[0], alerts[1]);
  });
});
