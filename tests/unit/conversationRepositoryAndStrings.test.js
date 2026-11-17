import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { FLAG_REASONS } from '../../src/domain/conversationRules.js';
import { CONVERSATION_STRINGS, NOTICE_KEYS, TRANSLATION_REVIEW } from '../../src/domain/conversationStrings.js';
import { createConversationRepository } from '../../src/repositories/conversationRepository.js';

const STORE = '11111111-1111-4111-8111-111111111111';
const CONV = '22222222-2222-4222-8222-222222222222';
const MSG = '33333333-3333-4333-8333-333333333333';
const RUN = '44444444-4444-4444-8444-444444444444';

function recordingClient({ rpcResult = { ok: true, changed: true }, rpcError = null, rows = [] } = {}) {
  const log = [];
  return {
    log,
    rpc(name, args) {
      log.push({ rpc: name, args });
      return Promise.resolve({ data: rpcResult, error: rpcError });
    },
    from(table) {
      const entry = { table, calls: [] };
      log.push(entry);
      const proxy = new Proxy(() => {}, {
        get: (_t, name) => {
          if (name === 'then') return (resolve) => resolve({ data: rows, error: null, count: 0 });
          if (name === 'maybeSingle') return async () => ({ data: null, error: null });
          return (...args) => (entry.calls.push([name, ...args]), proxy);
        },
      });
      return proxy;
    },
  };
}

describe('conversation repository', () => {
  it('sends store id first to every database function and maps the result', async () => {
    const client = recordingClient({ rpcResult: { ok: true, changed: true, duplicate: false, conversation_id: CONV, run_id: RUN, escalated: false, escalation_count: 0 } });
    const repo = createConversationRepository({ client });
    const started = await repo.start(STORE, { productId: null, language: 'en', name: 'A', phone: '9876543210', tokenHash: 'a'.repeat(64), tokenEnc: null, startKey: MSG, messageId: MSG, body: 'hi', limitNotice: 'n' });
    assert.equal(started.runId, RUN);
    assert.equal(started.conversationId, CONV);
    await repo.postMessage(STORE, CONV, { messageId: MSG, body: 'hi', limitNotice: 'n' });
    await repo.finishRun(STORE, CONV, RUN, { outcome: 'answered', kind: 'text', body: 'ok', flagReason: null });
    await repo.sellerReply(STORE, CONV, { messageId: MSG, body: 'ok' });
    assert.ok(client.log.every((entry) => entry.args.p_store_id === STORE));
    assert.deepEqual(client.log.map((entry) => entry.rpc), ['conversation_start', 'conversation_post_message', 'conversation_finish_run', 'conversation_seller_reply']);
  });

  it('never accepts a missing or malformed store id', async () => {
    const client = recordingClient();
    const repo = createConversationRepository({ client });
    await assert.rejects(() => repo.postMessage(undefined, CONV, {}), TypeError);
    await assert.rejects(() => repo.findByTokenHash('x', 'h'), TypeError);
    await assert.rejects(() => repo.listMessages('', CONV), TypeError);
    assert.equal(client.log.length, 0);
  });

  it('scopes every table read by store_id and never selects token_hash', async () => {
    const client = recordingClient();
    const repo = createConversationRepository({ client });
    await repo.findByTokenHash(STORE, 'a'.repeat(64));
    await repo.findForOwner(STORE, CONV);
    await repo.listMessages(STORE, CONV);
    await repo.recentMessages(STORE, CONV);
    await repo.listForOwner(STORE, { filter: 'unanswered' });
    await repo.countNeedsYou(STORE);
    await repo.markHandled(STORE, CONV, new Date().toISOString());
    for (const entry of client.log) {
      assert.ok(entry.calls.some(([name, column, value]) => name === 'eq' && ['store_id', 'id'].includes(column) && value === STORE), `${entry.table} scoped`);
      assert.ok(!entry.calls.some(([name, columns]) => name === 'select' && /token_hash/.test(String(columns))), 'token_hash not selected');
    }
  });

  it('throws a generic database error, without provider text, when the function fails', async () => {
    const client = recordingClient({ rpcError: { code: '57014', message: 'secret relation detail' } });
    const repo = createConversationRepository({ client });
    await assert.rejects(() => repo.postMessage(STORE, CONV, { messageId: MSG, body: 'x', limitNotice: 'n' }), (error) => {
      assert.equal(error.code, 'DATABASE_ERROR');
      assert.doesNotMatch(JSON.stringify(error), /secret/);
      return true;
    });
  });

  it('rejects an unexpected result shape', async () => {
    const repo = createConversationRepository({ client: recordingClient({ rpcResult: { nonsense: 1 } }) });
    await assert.rejects(() => repo.postMessage(STORE, CONV, { messageId: MSG, body: 'x', limitNotice: 'n' }));
  });
});

describe('conversation strings', () => {
  const keys = (language) => Object.keys(CONVERSATION_STRINGS[language]).sort();
  const placeholders = (text) => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();

  it('has identical keys in English, Gujarati and Hindi, none empty', () => {
    assert.deepEqual(keys('gu'), keys('en'));
    assert.deepEqual(keys('hi'), keys('en'));
    for (const language of ['en', 'gu', 'hi']) for (const [key, text] of Object.entries(CONVERSATION_STRINGS[language])) assert.ok(text.trim().length > 0, `${language}.${key}`);
  });

  it('keeps the same placeholders in every language', () => {
    for (const key of keys('en')) {
      for (const language of ['gu', 'hi']) assert.deepEqual(placeholders(CONVERSATION_STRINGS[language][key]), placeholders(CONVERSATION_STRINGS.en[key]), `${language}.${key}`);
    }
  });

  it('actually translates: Gujarati and Hindi differ from English and use their own script', () => {
    for (const key of keys('en')) {
      assert.notEqual(CONVERSATION_STRINGS.gu[key], CONVERSATION_STRINGS.en[key], `gu.${key}`);
      assert.notEqual(CONVERSATION_STRINGS.hi[key], CONVERSATION_STRINGS.en[key], `hi.${key}`);
    }
    assert.match(CONVERSATION_STRINGS.gu.chatSend, /[઀-૿]/);
    assert.match(CONVERSATION_STRINGS.hi.chatSend, /[ऀ-ॿ]/);
  });

  it('marks Gujarati and Hindi as pending native-speaker review and never as approved', () => {
    assert.equal(TRANSLATION_REVIEW.en, 'approved');
    assert.equal(TRANSLATION_REVIEW.gu, 'pending');
    assert.equal(TRANSLATION_REVIEW.hi, 'pending');
    assert.ok(CONVERSATION_STRINGS.gu.chatReviewNotice && CONVERSATION_STRINGS.hi.chatReviewNotice);
  });

  it('has a customer notice for every flag reason', () => {
    assert.deepEqual(Object.keys(NOTICE_KEYS).sort(), [...FLAG_REASONS].sort());
    for (const key of Object.values(NOTICE_KEYS)) assert.ok(CONVERSATION_STRINGS.en[key], key);
  });

  it('never tells the customer a failed message was sent or saved', () => {
    assert.match(CONVERSATION_STRINGS.en.chatErrNotSaved, /NOT saved/);
    assert.match(CONVERSATION_STRINGS.en.chatErrRejected, /Nothing was sent/);
    assert.doesNotMatch(CONVERSATION_STRINGS.en.chatErrCustomerLimit, /saved|sent/i);
  });
});
