import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createContactRepository } from '../../src/repositories/contactRepository.js';
import { createEmailOutboxRepository } from '../../src/repositories/emailOutboxRepository.js';

const ID = '3f2b8c1e-5a4d-4b7e-9c10-1d2e3f4a5b6c';

function recordingClient({ rpc = { data: null, error: null }, query = { data: null, count: 0, error: null } } = {}) {
  const calls = [];
  const chain = (name) => new Proxy({}, {
    get: (_, method) => {
      if (method === 'then') return (resolve) => resolve(query);
      if (method === 'single') return () => Promise.resolve(query);
      return (...args) => { calls.push([name, method, ...args]); return chain(name); };
    },
  });
  return { calls, rpc: async (fn, args) => { calls.push(['rpc', fn, args]); return rpc; }, from: (table) => { calls.push(['from', table]); return chain(table); } };
}

describe('email outbox repository', () => {
  it('enqueue calls email_enqueue with every field and parses the outcome', async () => {
    const client = recordingClient({ rpc: { data: 'queued', error: null } });
    const outbox = createEmailOutboxRepository({ client });
    const result = await outbox.enqueue({ storeId: null, kind: 'contact_inbox', toEmail: 'i@example.test', language: 'en', subject: 'S', body: 'B', replyTo: 'v@example.test', dedupeKey: 'k' });
    assert.equal(result, 'queued');
    assert.deepEqual(client.calls[0], ['rpc', 'email_enqueue', {
      p_store_id: null, p_kind: 'contact_inbox', p_to_email: 'i@example.test', p_language: 'en', p_subject: 'S', p_body: 'B', p_payload: {}, p_reply_to: 'v@example.test', p_dedupe_key: 'k',
    }]);
  });

  it('rejects an unexpected enqueue result and maps database errors to a safe AppError', async () => {
    await assert.rejects(createEmailOutboxRepository({ client: recordingClient({ rpc: { data: 'weird', error: null } }) }).enqueue({ kind: 'order_placed', toEmail: 'a@b.test', language: 'en', subject: '', body: '', dedupeKey: 'k', storeId: null }), { code: 'DATABASE_ERROR' });
    await assert.rejects(createEmailOutboxRepository({ client: recordingClient({ rpc: { data: null, error: { code: 'XX000', message: 'secret provider text' } } }) }).claimDue(1, 1), (error) => error.code === 'DATABASE_ERROR' && !error.message.includes('secret'));
  });

  it('claimDue parses rows into camelCase and finish returns the new status', async () => {
    const row = { id: ID, store_id: null, kind: 'order_placed', to_email: 'a@b.test', language: 'gu', subject: '', body: '', payload: { reference: 'AS1' }, reply_to: null, attempts: 1, status: 'sending' };
    const client = recordingClient({ rpc: { data: [row], error: null } });
    const [claimed] = await createEmailOutboxRepository({ client }).claimDue(10, 300);
    assert.deepEqual(claimed, { id: ID, storeId: null, kind: 'order_placed', toEmail: 'a@b.test', language: 'gu', subject: '', body: '', payload: { reference: 'AS1' }, replyTo: null, attempts: 1 });
    assert.deepEqual(client.calls[0], ['rpc', 'claim_due_emails', { p_limit: 10, p_lease_seconds: 300 }]);
    const finish = recordingClient({ rpc: { data: 'dead', error: null } });
    assert.equal(await createEmailOutboxRepository({ client: finish }).finish(ID, { sent: false, errorCode: 'RELAY_REJECTED' }), 'dead');
    assert.deepEqual(finish.calls[0][2], { p_id: ID, p_sent: false, p_error_code: 'RELAY_REJECTED', p_retry_seconds: null });
  });

  it('retention is one delete limited to sent and dead rows before the cutoff', async () => {
    const client = recordingClient({ query: { count: 3, error: null } });
    assert.equal(await createEmailOutboxRepository({ client }).deleteFinishedBefore('2026-10-01T00:00:00.000Z'), 3);
    assert.deepEqual(client.calls, [
      ['from', 'email_outbox'],
      ['email_outbox', 'delete', { count: 'exact' }],
      ['email_outbox', 'in', 'status', ['sent', 'dead']],
      ['email_outbox', 'lt', 'created_at', '2026-10-01T00:00:00.000Z'],
    ]);
  });
});

describe('contact repository', () => {
  it('inserts only name, email and message and returns the id', async () => {
    const client = recordingClient({ query: { data: { id: ID, created_at: '2026-11-17T00:00:00Z' }, error: null } });
    const saved = await createContactRepository({ client }).insert({ name: 'A', email: 'a@b.test', message: 'm' });
    assert.deepEqual(saved, { id: ID, createdAt: '2026-11-17T00:00:00Z' });
    assert.deepEqual(client.calls[1], ['contact_messages', 'insert', { name: 'A', email: 'a@b.test', message: 'm' }]);
  });

  it('counts messages from an address since a time, escaping LIKE wildcards', async () => {
    const client = recordingClient({ query: { count: 2, error: null } });
    assert.equal(await createContactRepository({ client }).countSince('a_b%@example.test', '2026-11-17T00:00:00Z'), 2);
    const ilike = client.calls.find((call) => call[1] === 'ilike');
    assert.equal(ilike[2], 'email');
    assert.equal(ilike[3], 'a\\_b\\%@example.test');
  });
});
