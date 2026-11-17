import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createClaudeProbe } from '../../src/ai/claudeProbe.js';
import { createSmtpProbe } from '../../src/email/smtpProbe.js';
import { createSupabaseProbe } from '../../src/repositories/supabaseProbe.js';
import { CHECK_NAMES, DEFAULT_CHECKS, createDiagnosticsService } from '../../src/services/diagnosticsService.js';
import { TEST_TOKEN, createFakeDiagnostics, startTestApp } from '../helpers/testApp.js';

const URL_PATH = '/internal/diagnostics';
const withToken = (token) => ({ headers: { 'x-diagnostics-token': token } });

describe('GET /internal/diagnostics access', () => {
  it('returns 404 when DIAGNOSTICS_TOKEN is unset, even with a header', async () => {
    const diagnostics = createFakeDiagnostics();
    const app = await startTestApp({ diagnostics });
    try {
      const res = await fetch(`${app.url}${URL_PATH}`, withToken(TEST_TOKEN));
      assert.equal(res.status, 404);
      assert.equal((await res.json()).error.code, 'NOT_FOUND');
      assert.equal(diagnostics.calls.length, 0);
    } finally {
      await app.close();
    }
  });

  it('returns 401 for missing and wrong tokens without running checks', async () => {
    const diagnostics = createFakeDiagnostics();
    const app = await startTestApp({ config: { diagnosticsToken: TEST_TOKEN }, diagnostics });
    try {
      const missing = await fetch(`${app.url}${URL_PATH}`);
      const wrong = await fetch(`${app.url}${URL_PATH}`, withToken('x'.repeat(TEST_TOKEN.length)));
      const short = await fetch(`${app.url}${URL_PATH}`, withToken('x'));
      assert.deepEqual([missing.status, wrong.status, short.status], [401, 401, 401]);
      assert.equal(diagnostics.calls.length, 0);
    } finally {
      await app.close();
    }
  });

  it('runs supabase and smtp-verify by default, claude only when requested', async () => {
    const diagnostics = createFakeDiagnostics();
    const app = await startTestApp({ config: { diagnosticsToken: TEST_TOKEN }, diagnostics });
    try {
      const byDefault = await fetch(`${app.url}${URL_PATH}`, withToken(TEST_TOKEN));
      const claude = await fetch(`${app.url}${URL_PATH}?checks=claude`, withToken(TEST_TOKEN));
      assert.equal(byDefault.status, 200);
      assert.equal(claude.status, 200);
      assert.deepEqual(diagnostics.calls, [['supabase', 'smtp-verify'], ['claude']]);
    } finally {
      await app.close();
    }
  });

  it('rejects unknown checks and unknown query keys with 400', async () => {
    const diagnostics = createFakeDiagnostics();
    const app = await startTestApp({ config: { diagnosticsToken: TEST_TOKEN }, diagnostics });
    try {
      const unknownCheck = await fetch(`${app.url}${URL_PATH}?checks=drop-tables`, withToken(TEST_TOKEN));
      const unknownKey = await fetch(`${app.url}${URL_PATH}?extra=1`, withToken(TEST_TOKEN));
      assert.equal(unknownCheck.status, 400);
      assert.equal(unknownKey.status, 400);
      assert.equal(diagnostics.calls.length, 0);
    } finally {
      await app.close();
    }
  });

  it('has its own strict limit of 5 per minute', async () => {
    const app = await startTestApp({ config: { diagnosticsToken: TEST_TOKEN }, diagnostics: createFakeDiagnostics() });
    try {
      const statuses = [];
      for (let attempt = 0; attempt < 6; attempt += 1) {
        statuses.push((await fetch(`${app.url}${URL_PATH}`, withToken('wrong'))).status);
      }
      assert.deepEqual(statuses, [401, 401, 401, 401, 401, 429]);
    } finally {
      await app.close();
    }
  });
});

describe('diagnostics service and probes (fakes only)', () => {
  it('reports unconfigured checks and never includes provider error text', async () => {
    const service = createDiagnosticsService({
      probes: {
        supabase: async () => {
          throw Object.assign(new Error('provider body: key=sk-ant-LEAK'), { name: 'StorageApiError' });
        },
      },
    });
    const result = await service.run(['supabase', 'claude']);
    assert.equal(result.ok, false);
    assert.deepEqual(result.checks.map(({ name, ok, reason }) => ({ name, ok, reason })), [
      { name: 'supabase', ok: false, reason: 'StorageApiError' },
      { name: 'claude', ok: false, reason: 'not_configured' },
    ]);
    assert.doesNotMatch(JSON.stringify(result), /LEAK|provider body/);
  });

  it('supabase probe lists buckets through the injected client', async () => {
    let called = false;
    const createClient = () => ({ storage: { listBuckets: async () => ((called = true), { data: [], error: null }) } });
    await createSupabaseProbe({ config: { url: 'https://x.test', serviceRoleKey: 'k' }, createClient })();
    assert.equal(called, true);
    const failing = () => ({ storage: { listBuckets: async () => ({ data: null, error: { message: 'secret detail' } }) } });
    await assert.rejects(
      createSupabaseProbe({ config: { url: 'https://x.test', serviceRoleKey: 'k' }, createClient: failing })(),
      { code: 'SUPABASE_STORAGE_ERROR' },
    );
  });

  it('claude probe makes one call with max_tokens 16 and no retries', async () => {
    const seen = [];
    const createClient = (options) => ({
      messages: { create: async (params) => (seen.push({ options, params }), {}) },
    });
    await createClaudeProbe({ config: { apiKey: 'k', model: 'claude-haiku-5-5' }, createClient })();
    assert.equal(seen.length, 1);
    assert.equal(seen[0].params.max_tokens, 16);
    assert.equal(seen[0].options.maxRetries, 0);
    assert.ok(seen[0].options.timeout > 0);
  });

  it('smtp verify never sends mail; sendTest sends exactly one', async () => {
    const events = [];
    const createTransport = (options) => {
      assert.ok(options.connectionTimeout > 0);
      return {
        verify: async () => events.push('verify'),
        sendMail: async (message) => events.push(`send:${message.to}`),
        close: () => events.push('close'),
      };
    };
    const config = { host: 'h', port: 587, user: 'u', pass: 'p', from: 'f@x.test', ownerNotifyEmail: 'o@x.test' };
    const probe = createSmtpProbe({ config, createTransport });
    await probe.verify();
    assert.deepEqual(events, ['verify', 'close']);
    events.length = 0;
    await probe.sendTest();
    assert.deepEqual(events, ['send:o@x.test', 'close']);
  });

  it('smtp failure returns only the safe reason, with no detail field and no credentials', async () => {
    const config = { host: 'h', port: 465, user: 'me@x.test', pass: 'hunter2', from: 'f@x.test', ownerNotifyEmail: 'o@x.test' };
    const failure = Object.assign(new Error('connect failed for me@x.test pass hunter2'), { code: 'ESOCKET', address: '10.0.0.1' });
    const createTransport = () => ({ verify: async () => { throw failure; }, close: () => {} });
    const probe = createSmtpProbe({ config, createTransport });
    const service = createDiagnosticsService({ probes: { 'smtp-verify': probe.verify } });
    const { checks } = await service.run(['smtp-verify']);
    assert.equal(checks[0].reason, 'ESOCKET');
    assert.ok(!('detail' in checks[0]));
    assert.deepEqual(Object.keys(checks[0]).sort(), ['durationMs', 'name', 'ok', 'reason']);
    assert.doesNotMatch(JSON.stringify(checks), /hunter2|me@x.test|10.0.0.1/);
  });
});

describe('relay-send check is opt-in', () => {
  it('is never in the default set and runs only when requested by name', async () => {
    const diagnostics = createFakeDiagnostics();
    const app = await startTestApp({ config: { diagnosticsToken: TEST_TOKEN }, diagnostics });
    try {
      const relay = await fetch(`${app.url}${URL_PATH}?checks=relay-send`, withToken(TEST_TOKEN));
      assert.equal(relay.status, 200);
      assert.deepEqual(diagnostics.calls, [['relay-send']]);
      assert.ok(!DEFAULT_CHECKS.includes('relay-send'));
      assert.ok(CHECK_NAMES.includes('relay-send'));
    } finally {
      await app.close();
    }
  });

  it('keeps only allow-listed, type-checked detail fields from a probe result', async () => {
    const probes = {
      'relay-send': async () => ({ messageId: 'm-1', replyToAccepted: false, httpStatus: 200, body: 'raw provider text' }),
    };
    const service = createDiagnosticsService({ probes });
    const { checks } = await service.run(['relay-send']);
    assert.deepEqual(Object.keys(checks[0]).sort(), ['durationMs', 'httpStatus', 'messageId', 'name', 'ok', 'replyToAccepted']);
    assert.doesNotMatch(JSON.stringify(checks), /raw provider text/);
  });

  it('drops detail fields with the wrong type or range', async () => {
    const probes = {
      'relay-send': async () => ({ messageId: 42, replyToAccepted: 'yes', httpStatus: 999 }),
    };
    const { checks } = await createDiagnosticsService({ probes }).run(['relay-send']);
    assert.deepEqual(Object.keys(checks[0]).sort(), ['durationMs', 'name', 'ok']);
  });
});
