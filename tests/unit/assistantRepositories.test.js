import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createEnquiryRepository } from '../../src/repositories/enquiryRepository.js';
import { createKnowledgeRepository } from '../../src/repositories/knowledgeRepository.js';

const STORE = '11111111-1111-4111-8111-111111111111';
const ID = '22222222-2222-4222-8222-222222222222';
const NOW = '2026-11-16T10:00:00.000Z';

/** Chainable, thenable recorder standing in for the supabase-js builder. */
function recordingClient(data = []) {
  const log = [];
  return {
    log,
    from(table) {
      const entry = { table, calls: [] };
      log.push(entry);
      const proxy = new Proxy(() => {}, {
        get: (_target, name) => {
          if (name === 'then') return (resolve) => resolve({ data, error: null, count: 0 });
          if (name === 'maybeSingle' || name === 'single') return async () => ({ data: Array.isArray(data) ? null : data, error: null });
          return (...args) => (entry.calls.push([name, ...args]), proxy);
        },
      });
      return proxy;
    },
  };
}

const named = (entry, name) => entry.calls.filter(([called]) => called === name);
const scopedByStore = (entry) => named(entry, 'eq').some(([, column, value]) => column === 'store_id' && value === STORE);

describe('knowledge repository', () => {
  it('scopes every read and write by store_id and clears the tiers when the document is replaced', async () => {
    const client = recordingClient();
    const repo = createKnowledgeRepository({ client });
    await repo.get(STORE);
    await repo.replaceContent(STORE, 'notes', NOW);
    await repo.saveRules(STORE, [{ minQty: 10, percentOff: 5 }], NOW);
    assert.ok(client.log.every((entry) => entry.table === 'store_knowledge'));
    assert.ok(scopedByStore(client.log[0]));
    const [upsert] = named(client.log[1], 'upsert');
    assert.deepEqual(upsert[1], { store_id: STORE, content: 'notes', bulk_rules: [], updated_at: NOW });
    assert.ok(scopedByStore(client.log[2]));
  });

  it('refuses a missing or malformed store id before any query runs', async () => {
    const client = recordingClient();
    const repo = createKnowledgeRepository({ client });
    await assert.rejects(() => repo.get(undefined), TypeError);
    await assert.rejects(() => repo.get('abc'), TypeError);
    assert.equal(client.log.length, 0);
  });
});

describe('enquiry repository', () => {
  it('scopes every query by store_id, never selects token_hash, and selects token_enc only for the seller detail', async () => {
    const client = recordingClient();
    const repo = createEnquiryRepository({ client });
    await repo.findByTokenHash(STORE, 'a'.repeat(64));
    await repo.listForOwner(STORE, { status: 'needs_you' });
    await repo.findForOwner(STORE, ID);
    await repo.countByStatus(STORE, 'needs_you');
    await repo.countByPhoneSince(STORE, '919876543210', NOW);
    await repo.countClaimedSince(STORE, NOW);
    for (const entry of client.log) assert.ok(scopedByStore(entry), JSON.stringify(entry.calls));
    const selects = client.log.map((entry) => String(named(entry, 'select')[0]?.[1] ?? ''));
    assert.ok(selects.every((columns) => !columns.includes('token_hash')));
    assert.ok(!selects[0].includes('token_enc') && !selects[1].includes('token_enc'));
    assert.ok(selects[2].includes('token_enc'));
  });

  it('every state change is a conditional update scoped by store and id', async () => {
    const client = recordingClient([{ id: ID }]);
    const repo = createEnquiryRepository({ client });
    assert.equal(await repo.claim(STORE, ID, NOW), true);
    await repo.finish(STORE, ID, { status: 'answered', answerText: 'a', flagReason: null, trace: [] }, NOW);
    await repo.failStuck(STORE, ID, NOW, NOW);
    await repo.saveReply(STORE, ID, 'reply', NOW);
    await repo.markHandled(STORE, ID, NOW);
    for (const entry of client.log) {
      assert.ok(scopedByStore(entry));
      assert.ok(named(entry, 'eq').some(([, column, value]) => column === 'id' && value === ID));
    }
    assert.ok(named(client.log[0], 'eq').some(([, column, value]) => column === 'status' && value === 'pending'));
    assert.ok(named(client.log[1], 'eq').some(([, column, value]) => column === 'status' && value === 'answering'));
  });

  it('reports false when the conditional update changed nothing', async () => {
    const repo = createEnquiryRepository({ client: recordingClient([]) });
    assert.equal(await repo.claim(STORE, ID, NOW), false);
  });
});
