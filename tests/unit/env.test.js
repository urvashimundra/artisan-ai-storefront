import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { EnvValidationError, loadEnv } from '../../src/config/env.js';

const run = promisify(execFile);
const SERVER_PATH = fileURLToPath(new URL('../../src/server.js', import.meta.url));
const MINIMAL = { NODE_ENV: 'test', BASE_URL: 'http://localhost:3000' };

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
    assert.equal(config.supabase, null);
    assert.equal(config.ai, null);
    assert.equal(config.smtp, null);
  });

  it('lists names only for missing required variables', () => {
    const error = failureOf({});
    assert.ok(error instanceof EnvValidationError);
    assert.deepEqual(error.variables.sort(), ['BASE_URL', 'NODE_ENV']);
  });

  it('never includes values in the error, even for invalid ones', () => {
    const secret = 'super-secret-value-123';
    const error = failureOf({ ...MINIMAL, PORT: secret, SUPABASE_URL: `https://${secret}.example` });
    assert.ok(error.variables.includes('PORT'));
    assert.ok(error.variables.includes('SUPABASE_SERVICE_ROLE_KEY'));
    assert.doesNotMatch(error.message, new RegExp(secret));
    assert.doesNotMatch(JSON.stringify(error.variables), new RegExp(secret));
  });

  it('requires the whole group once any member is present', () => {
    const error = failureOf({ ...MINIMAL, SMTP_HOST: 'smtp.example.test' });
    assert.deepEqual(error.variables.sort(), [
      'MAIL_FROM',
      'OWNER_NOTIFY_EMAIL',
      'SMTP_PASS',
      'SMTP_PORT',
      'SMTP_USER',
    ]);
  });

  it('a lone CLAUDE_MODEL starts the ai group', () => {
    const error = failureOf({ ...MINIMAL, CLAUDE_MODEL: 'x' });
    assert.deepEqual(error.variables.sort(), ['AI_DAILY_BUDGET_USD', 'ANTHROPIC_API_KEY']);
  });

  it('parses a complete ai group with the default model', () => {
    const config = loadEnv({ ...MINIMAL, ANTHROPIC_API_KEY: 'k', AI_DAILY_BUDGET_USD: '2.5' });
    assert.deepEqual(config.ai, { apiKey: 'k', model: 'claude-haiku-5-5', dailyBudgetUsd: 2.5 });
  });

  it('rejects a short DIAGNOSTICS_TOKEN and treats blank values as unset', () => {
    assert.deepEqual(failureOf({ ...MINIMAL, DIAGNOSTICS_TOKEN: 'short' }).variables, ['DIAGNOSTICS_TOKEN']);
    assert.equal(loadEnv({ ...MINIMAL, SUPABASE_URL: '  ', DIAGNOSTICS_TOKEN: '' }).supabase, null);
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
