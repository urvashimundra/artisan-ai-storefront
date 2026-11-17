import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { RETENTION_MONTHS } from '../../src/domain/conversationRules.js';
import { createOutboxWorker } from '../../src/email/outboxWorker.js';
import { createConversationRetention } from '../../src/services/conversationRetention.js';
import { createFakeContacts, createFakeOutbox, createFakeRelay } from '../helpers/emailFakes.js';

const START = Date.UTC(2026, 10, 17, 9, 0, 0);
const DAY = 86_400_000;
const logs = () => { const lines = []; return { lines, info: (m, f) => lines.push({ m, ...f }), warn: (m, f) => lines.push({ m, ...f }) }; };

describe('conversation retention job', () => {
  it('purges in batches until a batch is not full, and logs counts only', async () => {
    const calls = [];
    const results = [{ conversations: 200, legacyEnquiries: 1, usageRows: 3 }, { conversations: 7, legacyEnquiries: 0, usageRows: 0 }];
    const log = logs();
    const retention = createConversationRetention({ conversations: { purgeExpired: async (options) => (calls.push(options), results.shift()) }, logger: log });
    const total = await retention.run();
    assert.deepEqual(total, { conversations: 207, legacyEnquiries: 1, usageRows: 3 });
    assert.deepEqual(calls, [{ limit: 200, includeLegacy: false }, { limit: 200, includeLegacy: false }]);
    assert.deepEqual(log.lines, [{ m: 'conversation retention run', conversations: 207, legacyEnquiries: 1, usageRows: 3 }]);
  });

  it('never deletes un-copied legacy enquiries and stops after five batches per run', async () => {
    let calls = 0;
    const retention = createConversationRetention({ conversations: { purgeExpired: async (options) => { calls += 1; assert.equal(options.includeLegacy, false); return { conversations: 200, legacyEnquiries: 0, usageRows: 0 }; } }, logger: logs() });
    await retention.run();
    assert.equal(calls, 5);
  });

  it('is quiet when there is nothing to delete', async () => {
    const log = logs();
    await createConversationRetention({ conversations: { purgeExpired: async () => ({ conversations: 0, legacyEnquiries: 0, usageRows: 0 }) }, logger: log }).run();
    assert.deepEqual(log.lines, []);
  });

  it('uses 12 months in the database function', () => {
    const sql = readFileSync(new URL('../../db/migrations/013_conversations.sql', import.meta.url), 'utf8');
    assert.ok(sql.includes(`interval '${RETENTION_MONTHS} months'`));
  });
});

describe('the email worker runs the retention daily and survives its failure', () => {
  function worker(conversationRetention) {
    const clock = { now: START };
    const log = logs();
    const w = createOutboxWorker({
      outbox: createFakeOutbox({ clock }), contacts: createFakeContacts({ clock }), relay: createFakeRelay(), baseUrl: 'https://shop.example.test', logger: log,
      conversationRetention, clock: () => clock.now,
    });
    return { w, clock, log };
  }

  it('runs once a day, not on every tick', async () => {
    let runs = 0;
    const { w, clock } = worker({ run: async () => { runs += 1; } });
    await w.runOnce();
    await w.runOnce();
    assert.equal(runs, 1);
    clock.now += DAY + 1000;
    await w.runOnce();
    assert.equal(runs, 2);
  });

  it('logs a failed purge as a warning with a code only, and still completes the run', async () => {
    const { w, log } = worker({ run: async () => { throw Object.assign(new Error('secret detail 9876543210'), { code: 'DATABASE_ERROR' }); } });
    await w.runOnce();
    const warning = log.lines.find((line) => line.m === 'conversation retention failed');
    assert.deepEqual(warning, { m: 'conversation retention failed', code: 'DATABASE_ERROR' });
    assert.ok(!JSON.stringify(log.lines).includes('9876543210'));
  });

  it('works unchanged without a conversation retention (older wiring)', async () => {
    const { w } = worker(null);
    await w.runOnce();
  });
});
