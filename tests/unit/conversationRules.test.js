import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  CUSTOMER_DAILY_QUESTION_LIMIT, FLAG_REASONS, MAX_ASSISTANT_MESSAGE_LENGTH, MAX_CONVERSATION_MESSAGES, MAX_MESSAGE_LENGTH, MAX_NAME_LENGTH,
  MAX_PREVIEW_LENGTH, MAX_SELLER_MESSAGE_LENGTH, MESSAGE_KINDS, MESSAGE_ROLES, OUTCOMES, REASON_OUTCOMES, RETENTION_MONTHS, SELLER_MESSAGE_HEADROOM,
  STALE_RUN_MS, STORE_DAILY_AI_ANSWER_LIMIT, CONVERSATION_STATUSES, inboxFilter, isStaleRun, messageSchema, persistenceError, refusalError,
  sellerReplySchema, startSchema,
} from '../../src/domain/conversationRules.js';

const migration = readFileSync(fileURLToPath(new URL('../../db/migrations/013_conversations.sql', import.meta.url)), 'utf8');
const ID = '2b1f0d1e-5c1a-4f1e-8a55-1f4f5b0c9a11';
const OTHER_ID = '3c2a1e2f-6d2b-4a2f-9b66-2a5a6c1d0b22';
const valid = { name: ' Asha  Patel ', phone: '98765 43210', message: 'Do you ship to Pune?', startKey: ID, messageId: OTHER_ID };

describe('conversation limits mirror the migration', () => {
  it('has the agreed numbers', () => {
    assert.equal(CUSTOMER_DAILY_QUESTION_LIMIT, 6);
    assert.equal(STORE_DAILY_AI_ANSWER_LIMIT, 200);
    assert.equal(MAX_CONVERSATION_MESSAGES, 200);
    assert.equal(RETENTION_MONTHS, 12);
    assert.ok(STALE_RUN_MS > 40_000);
  });

  it('matches the SQL constants and check constraints', () => {
    assert.ok(migration.includes(`c_limit CONSTANT integer := ${CUSTOMER_DAILY_QUESTION_LIMIT};`));
    assert.ok(migration.includes(`c_limit CONSTANT integer := ${STORE_DAILY_AI_ANSWER_LIMIT};`));
    assert.ok(migration.includes(`c_customer_max_count CONSTANT integer := ${MAX_CONVERSATION_MESSAGES - 2};`));
    assert.ok(migration.includes(`message_count >= ${MAX_CONVERSATION_MESSAGES + SELLER_MESSAGE_HEADROOM}`));
    assert.ok(migration.includes(`interval '${RETENTION_MONTHS} months'`));
    assert.ok(migration.includes(`char_length(customer_name) BETWEEN 1 AND ${MAX_NAME_LENGTH}`));
    assert.ok(migration.includes(`char_length(body) <= ${MAX_MESSAGE_LENGTH})`));
    assert.ok(migration.includes(`char_length(body) <= ${MAX_SELLER_MESSAGE_LENGTH})`));
    assert.ok(migration.includes(`char_length(body) BETWEEN 1 AND ${MAX_ASSISTANT_MESSAGE_LENGTH}`));
    assert.ok(migration.includes(`char_length(last_preview) <= ${MAX_PREVIEW_LENGTH}`));
    assert.ok(migration.includes(`BETWEEN 1 AND ${MAX_CONVERSATION_MESSAGES + SELLER_MESSAGE_HEADROOM}`));
  });

  it('matches the SQL value lists', () => {
    for (const value of [...FLAG_REASONS, ...CONVERSATION_STATUSES, ...MESSAGE_ROLES, ...MESSAGE_KINDS]) assert.ok(migration.includes(`'${value}'`), value);
  });
});

describe('outcome taxonomy', () => {
  it('maps every flag reason to a stored kind and a finish result', () => {
    assert.deepEqual(Object.keys(REASON_OUTCOMES).sort(), [...FLAG_REASONS].sort());
    for (const { kind, result } of Object.values(REASON_OUTCOMES)) {
      assert.ok(MESSAGE_KINDS.includes(kind));
      assert.ok(['escalated', 'failed'].includes(result));
    }
  });

  it('never says a message was saved when it was not', () => {
    for (const name of ['rejected', 'persistence_failed', 'customer_limit', 'busy', 'conversation_full']) assert.equal(OUTCOMES[name].saved, false, name);
    for (const name of ['saved', 'answered', 'seller', 'ai_unavailable', 'store_limit', 'budget', 'provider_limit', 'timeout', 'network']) {
      assert.equal(OUTCOMES[name].saved, true, name);
    }
  });

  it('turns refusals into distinct errors, unknown ones into a generic 503', () => {
    assert.equal(refusalError('customer_limit').httpStatus, 429);
    assert.equal(refusalError('busy').code, 'CONVERSATION_BUSY');
    assert.equal(refusalError('conversation_full').code, 'CONVERSATION_FULL');
    assert.equal(refusalError('not_found').httpStatus, 404);
    assert.equal(refusalError('surprise').httpStatus, 503);
    assert.equal(persistenceError().code, 'PERSISTENCE_FAILED');
  });
});

describe('input schemas', () => {
  it('accepts a valid start and normalises it', () => {
    const parsed = startSchema.parse(valid);
    assert.equal(parsed.name, 'Asha Patel');
    assert.match(parsed.phone, /^[0-9]{10,15}$/);
  });

  it('rejects unknown keys, a store id, bad ids, bad numbers and long messages', () => {
    assert.throws(() => startSchema.parse({ ...valid, storeId: ID }));
    assert.throws(() => startSchema.parse({ ...valid, startKey: 'x' }));
    assert.throws(() => startSchema.parse({ ...valid, phone: '12' }));
    assert.throws(() => startSchema.parse({ ...valid, message: 'a'.repeat(MAX_MESSAGE_LENGTH + 1) }));
    assert.throws(() => startSchema.parse({ ...valid, message: '   ' }));
    assert.throws(() => messageSchema.parse({ message: 'hi', messageId: ID, conversationId: ID }));
    assert.throws(() => sellerReplySchema.parse({ reply: 'hi', messageId: ID, storeId: ID }));
  });

  it('counts code points, so Gujarati and Hindi are measured fairly', () => {
    assert.ok(messageSchema.safeParse({ message: 'ક'.repeat(MAX_MESSAGE_LENGTH), messageId: ID }).success);
    assert.ok(!messageSchema.safeParse({ message: 'ક'.repeat(MAX_MESSAGE_LENGTH + 1), messageId: ID }).success);
  });
});

describe('helpers', () => {
  it('validates inbox filters and detects stale runs', () => {
    assert.equal(inboxFilter('needs_you'), 'needs_you');
    assert.equal(inboxFilter('bogus'), null);
    const now = Date.now();
    assert.equal(isStaleRun({ aiRunStartedAt: null }, now), false);
    assert.equal(isStaleRun({ aiRunStartedAt: new Date(now - STALE_RUN_MS - 1).toISOString() }, now), true);
    assert.equal(isStaleRun({ aiRunStartedAt: new Date(now - 1000).toISOString() }, now), false);
  });
});
