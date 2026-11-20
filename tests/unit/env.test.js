import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { EnvValidationError, loadEnv } from '../../src/config/env.js';

const run = promisify(execFile);
const SERVER_PATH = fileURLToPath(new URL('../../src/server.js', import.meta.url));
const REQUIRED_NAMES = ['BASE_URL', 'NODE_ENV', 'SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_URL'];
const MINIMAL = {
  NODE_ENV: 'test',
  BASE_URL: 'http://localhost:3000',
  SUPABASE_URL: 'https://project.supabase.test',
  SUPABASE_SERVICE_ROLE_KEY: 'service-key',
};

function failureOf(source) {
  try {
    loadEnv(source);
  } catch (error) {
    return error;
  }
  return assert.fail('expected loadEnv to throw');
}

describe('loadEnv', () => {
  it('applies defaults and leaves optional groups null', () => {
    const config = loadEnv(MINIMAL);
    assert.equal(config.port, 3000);
    assert.equal(config.trustProxy, 1);
    assert.deepEqual(config.supabase, { url: 'https://project.supabase.test', serviceRoleKey: 'service-key' });
    assert.equal(config.ai, null);
    assert.equal(config.smtp, undefined, 'the SMTP group no longer exists');
    assert.equal(config.ownerNotifyEmail, undefined);
  });

  it('rejects an http SUPABASE_URL and other non-https schemes', () => {
    for (const url of ['http://project.supabase.test', 'http://localhost:54321', 'data:text/plain,hi', 'ftp://x.test']) {
      assert.deepEqual(failureOf({ ...MINIMAL, SUPABASE_URL: url }).variables, ['SUPABASE_URL'], url);
    }
  });

  it('rejects a non-https BASE_URL outside localhost and 127.0.0.1', () => {
    for (const url of ['http://example.test', 'http://localhost.evil.test', 'http://[::1]:3000', 'data:text/plain,hi', 'ftp://localhost']) {
      assert.deepEqual(failureOf({ ...MINIMAL, BASE_URL: url }).variables, ['BASE_URL'], url);
    }
  });

  it('accepts https BASE_URL and http only on localhost or 127.0.0.1', () => {
    for (const url of ['https://theartisanstory.in', 'http://localhost:3000', 'http://127.0.0.1:3000']) {
      assert.equal(loadEnv({ ...MINIMAL, BASE_URL: url }).baseUrl, url);
    }
  });

  it('does not fail on an unknown NODE_ENV and treats it as production', () => {
    assert.equal(loadEnv({ ...MINIMAL, NODE_ENV: 'staging', BASE_URL: 'https://shop.example.test' }).nodeEnv, 'production');
    assert.equal(loadEnv({ ...MINIMAL, NODE_ENV: 'development' }).nodeEnv, 'development');
    assert.equal(loadEnv(MINIMAL).nodeEnv, 'test');
  });

  it('lists names only for missing required variables', () => {
    const error = failureOf({});
    assert.ok(error instanceof EnvValidationError);
    assert.deepEqual(error.variables.sort(), REQUIRED_NAMES);
  });

  it('never includes values in the error, even for invalid ones', () => {
    const secret = 'super-secret-value-123';
    const error = failureOf({ ...MINIMAL, PORT: secret, SUPABASE_URL: secret });
    assert.deepEqual(error.variables.sort(), ['PORT', 'SUPABASE_URL']);
    assert.doesNotMatch(error.message, new RegExp(secret));
    assert.doesNotMatch(JSON.stringify(error.variables), new RegExp(secret));
  });

  it('ignores the retired SMTP variables, and validates OWNER_NOTIFY_EMAIL on its own', () => {
    const config = loadEnv({ ...MINIMAL, SMTP_HOST: 'smtp.example.test', SMTP_PORT: 'x', MAIL_FROM: 'a@b.test', OWNER_NOTIFY_EMAIL: 'owner@example.test' });
    assert.equal(config.ownerNotifyEmail, 'owner@example.test');
    assert.deepEqual(failureOf({ ...MINIMAL, OWNER_NOTIFY_EMAIL: 'nope' }).variables, ['OWNER_NOTIFY_EMAIL']);
  });

  it('a lone CLAUDE_MODEL starts the ai group', () => {
    const error = failureOf({ ...MINIMAL, CLAUDE_MODEL: 'x' });
    assert.deepEqual(error.variables, ['ANTHROPIC_API_KEY']);
  });

  it('parses a complete ai group with the default model', () => {
    const config = loadEnv({ ...MINIMAL, ANTHROPIC_API_KEY: 'k' });
    assert.deepEqual(config.ai, { apiKey: 'k', model: 'claude-haiku-5-5' });
  });

  it('rejects a short DIAGNOSTICS_TOKEN and treats blank values as unset', () => {
    assert.deepEqual(failureOf({ ...MINIMAL, DIAGNOSTICS_TOKEN: 'short' }).variables, ['DIAGNOSTICS_TOKEN']);
    assert.equal(loadEnv({ ...MINIMAL, DIAGNOSTICS_TOKEN: '' }).diagnosticsToken, undefined);
  });

  it('requires Supabase from Module 1 on', () => {
    assert.deepEqual(failureOf({ NODE_ENV: 'test', BASE_URL: 'http://localhost:3000' }).variables.sort(), [
      'SUPABASE_SERVICE_ROLE_KEY',
      'SUPABASE_URL',
    ]);
  });

  it('ALLOWED_ORIGINS accepts bare origins and always includes the BASE_URL origin', () => {
    const config = loadEnv({
      ...MINIMAL,
      BASE_URL: 'https://app.example.test/some/path',
      ALLOWED_ORIGINS: 'https://theartisanstory.in, http://localhost:3000',
    });
    assert.deepEqual(config.allowedOrigins, [
      'https://app.example.test',
      'https://theartisanstory.in',
      'http://localhost:3000',
    ]);
    assert.deepEqual(loadEnv(MINIMAL).allowedOrigins, ['http://localhost:3000']);
  });

  it('rejects configured origins that are not bare origins', () => {
    const invalid = [
      'https://example.test/path',
      'https://example.test/',
      'https://example.test?x=1',
      'https://example.test#frag',
      'example.test',
      'ftp://example.test',
      'https://ok.test,https://bad.test/x',
    ];
    for (const value of invalid) {
      assert.deepEqual(failureOf({ ...MINIMAL, ALLOWED_ORIGINS: value }).variables, ['ALLOWED_ORIGINS'], value);
    }
  });

  it('derives cookie settings from BASE_URL, not NODE_ENV', () => {
    const https = loadEnv({ ...MINIMAL, NODE_ENV: 'development', BASE_URL: 'https://example.test' });
    assert.deepEqual(https.cookie, { name: '__Host-session', secure: true });
    const http = loadEnv({ ...MINIMAL, NODE_ENV: 'development', BASE_URL: 'http://localhost:3000' });
    assert.deepEqual(http.cookie, { name: 'session', secure: false });
  });

  it('production refuses an http BASE_URL, even on localhost, because emails and links are built from it', () => {
    assert.deepEqual(failureOf({ ...MINIMAL, NODE_ENV: 'production', BASE_URL: 'http://localhost:3000' }).variables, ['BASE_URL']);
    assert.deepEqual(failureOf({ ...MINIMAL, NODE_ENV: 'staging', BASE_URL: 'http://127.0.0.1:3000' }).variables, ['BASE_URL']);
    assert.equal(loadEnv({ ...MINIMAL, NODE_ENV: 'production', BASE_URL: 'https://shop.example.test' }).baseUrl, 'https://shop.example.test');
  });

  it('server process exits non-zero printing names only when env is missing', async () => {
    const env = { SystemRoot: process.env.SystemRoot, PATH: process.env.PATH, PORT: 'leaky-port-value' };
    await assert.rejects(run(process.execPath, [SERVER_PATH], { env }), (error) => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /NODE_ENV/);
      assert.match(error.stderr, /BASE_URL/);
      assert.doesNotMatch(error.stderr, /leaky-port-value/);
      return true;
    });
  });
});

describe('AI budget variables', () => {
  it('are optional and default to 1.00 / 0.50 / 5.00 USD in micro-USD', () => {
    assert.deepEqual(loadEnv(MINIMAL).aiBudget, {
      ownerDailyMicroUsd: 1_000_000,
      demoDailyMicroUsd: 500_000,
      globalDailyMicroUsd: 5_000_000,
    });
    assert.equal(loadEnv({ ...MINIMAL, AI_DAILY_BUDGET_USD: ' ' }).aiBudget.ownerDailyMicroUsd, 1_000_000);
  });

  it('parse provided decimal strings without starting the ai group', () => {
    const config = loadEnv({
      ...MINIMAL,
      AI_DAILY_BUDGET_USD: '2.5',
      AI_DEMO_DAILY_BUDGET_USD: '0.000001',
      AI_GLOBAL_DAILY_BUDGET_USD: '10',
    });
    assert.deepEqual(config.aiBudget, {
      ownerDailyMicroUsd: 2_500_000,
      demoDailyMicroUsd: 1,
      globalDailyMicroUsd: 10_000_000,
    });
    assert.equal(config.ai, null);
  });

  it('reject invalid values by name', () => {
    for (const name of ['AI_DAILY_BUDGET_USD', 'AI_DEMO_DAILY_BUDGET_USD', 'AI_GLOBAL_DAILY_BUDGET_USD']) {
      for (const bad of ['-1', 'abc', '1e3', '1.0000001']) {
        assert.deepEqual(failureOf({ ...MINIMAL, [name]: bad }).variables, [name], `${name}=${bad}`);
      }
    }
  });
});

describe('EMAIL_RELAY_URL', () => {
  it('defaults to the hosting relay on loopback', () => {
    assert.equal(loadEnv(MINIMAL).emailRelayUrl, 'http://127.0.0.1:2525');
    assert.equal(loadEnv({ ...MINIMAL, EMAIL_RELAY_URL: '  ' }).emailRelayUrl, 'http://127.0.0.1:2525');
  });

  it('accepts a bare http origin on localhost or 127.0.0.1', () => {
    for (const url of ['http://localhost:2525', 'http://127.0.0.1:9000', 'http://127.0.0.1:2525/']) {
      assert.equal(loadEnv({ ...MINIMAL, EMAIL_RELAY_URL: url }).emailRelayUrl, url);
    }
  });

  it('rejects anything that is not http on localhost or 127.0.0.1, naming the variable only', () => {
    const invalid = [
      'https://127.0.0.1:2525',
      'http://relay.example.test:2525',
      'http://localhost.evil.test:2525',
      'http://[::1]:2525',
      'http://127.0.0.1:2525/api/email/send',
      'http://127.0.0.1:2525?x=1',
      'http://127.0.0.1:2525#frag',
      'http://user:pass@127.0.0.1:2525',
      'ftp://127.0.0.1',
      'not a url',
    ];
    for (const url of invalid) {
      assert.deepEqual(failureOf({ ...MINIMAL, EMAIL_RELAY_URL: url }).variables, ['EMAIL_RELAY_URL'], url);
    }
  });
});

describe('CONTACT_INBOX_EMAIL and EMAIL_WORKER_ENABLED', () => {
  it('are optional: no inbox, worker on', () => {
    const config = loadEnv(MINIMAL);
    assert.equal(config.contactInboxEmail, undefined);
    assert.equal(config.emailWorkerEnabled, true);
  });

  it('accept a valid address and a true or false switch', () => {
    const config = loadEnv({ ...MINIMAL, CONTACT_INBOX_EMAIL: 'inbox@example.test', EMAIL_WORKER_ENABLED: 'false' });
    assert.equal(config.contactInboxEmail, 'inbox@example.test');
    assert.equal(config.emailWorkerEnabled, false);
  });

  it('reject a bad address or switch, naming the variable only', () => {
    assert.deepEqual(failureOf({ ...MINIMAL, CONTACT_INBOX_EMAIL: 'not-an-email' }).variables, ['CONTACT_INBOX_EMAIL']);
    assert.deepEqual(failureOf({ ...MINIMAL, EMAIL_WORKER_ENABLED: 'yes' }).variables, ['EMAIL_WORKER_ENABLED']);
    assert.ok(!failureOf({ ...MINIMAL, CONTACT_INBOX_EMAIL: 'not-an-email' }).message.includes('not-an-email'));
  });
});
