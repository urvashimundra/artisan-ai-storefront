import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { DEMO_STORE, SeedError, readSeedEnv, runSeed } from '../../scripts/seed-demo.js';
import { createJobQueue } from '../../src/lib/password.js';
import { PASSWORD, cookieFrom, startAuthApp } from '../helpers/appHarness.js';
import { buildFakeServices } from '../helpers/fakes.js';

const run = promisify(execFile);
const SEED_PATH = fileURLToPath(new URL('../../scripts/seed-demo.js', import.meta.url));
const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const DEMO_EMAIL = 'demo@example.com';
const DEMO_PASSWORD = 'demo-password-long-enough';

function seedDeps(services) {
  const lines = [];
  return {
    lines,
    deps: {
      email: DEMO_EMAIL,
      password: DEMO_PASSWORD,
      owners: services.ownersRepo,
      auth: services.auth,
      stores: services.stores,
      log: (line) => lines.push(line),
    },
  };
}

describe('seed script', () => {
  it('does not run when imported, and never touches the network or prints anything', async () => {
    const env = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot };
    const { stdout, stderr } = await run(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(pathToFileURL(SEED_PATH).href)})`], { env, cwd: ROOT });
    assert.equal(stdout, '');
    assert.equal(stderr, '');
  });

  it('creates a demo owner through the normal hashing service and one demo store through the store service', async () => {
    let hashRuns = 0;
    const real = createJobQueue();
    const queue = { run: (task) => (hashRuns += 1, real.run(task)) };
    const services = await buildFakeServices({ passwordOptions: { queue } });
    hashRuns = 0;
    const { deps, lines } = seedDeps(services);
    await runSeed(deps);
    assert.equal(hashRuns, 1);
    assert.equal(services.ownersRepo.rows.length, 1);
    assert.equal(services.ownersRepo.rows[0].isDemo, true);
    assert.match(services.ownersRepo.rows[0].passwordHash, /^scrypt\$16\$1\$1\$/);
    assert.equal(services.storesRepo.rows.length, 1);
    assert.equal(services.storesRepo.rows[0].slug, DEMO_STORE.slug);
    assert.equal(services.storesRepo.rows[0].ownerId, services.ownersRepo.rows[0].id);
    assert.deepEqual(lines, ['Demo owner created.', 'Demo store created.']);
  });

  it('is idempotent: a second run changes nothing and never rewrites the demo password', async () => {
    const services = await buildFakeServices();
    const { deps } = seedDeps(services);
    await runSeed(deps);
    const before = JSON.stringify([services.ownersRepo.rows, services.storesRepo.rows]);
    const { deps: second, lines } = seedDeps(services);
    await runSeed({ ...second, password: 'a-different-long-password' });
    assert.equal(JSON.stringify([services.ownersRepo.rows, services.storesRepo.rows]), before);
    assert.deepEqual(lines, ['Demo owner already exists; password left unchanged.', 'Demo store already exists.']);
  });

  it('creates only the missing store for an existing demo owner', async () => {
    const services = await buildFakeServices();
    await services.auth.createOwnerRecord({ email: DEMO_EMAIL, password: DEMO_PASSWORD, isDemo: true });
    const hash = services.ownersRepo.rows[0].passwordHash;
    await runSeed(seedDeps(services).deps);
    assert.equal(services.ownersRepo.rows[0].passwordHash, hash);
    assert.equal(services.storesRepo.rows.length, 1);
  });

  it('aborts without modifying anything if the email belongs to a non-demo owner', async () => {
    const services = await buildFakeServices();
    await services.auth.createOwnerRecord({ email: DEMO_EMAIL, password: DEMO_PASSWORD, isDemo: false });
    const snapshot = JSON.stringify(services.ownersRepo.rows);
    const insertsBefore = services.ownersRepo.calls.filter((call) => call === 'insert').length;
    await assert.rejects(runSeed(seedDeps(services).deps), SeedError);
    assert.equal(JSON.stringify(services.ownersRepo.rows), snapshot);
    assert.equal(services.ownersRepo.calls.filter((call) => call === 'insert').length, insertsBefore);
    assert.equal(services.storesRepo.rows.length, 0);
  });

  it('never logs the email, password or hash', async () => {
    const services = await buildFakeServices();
    const { deps, lines } = seedDeps(services);
    await runSeed(deps);
    await runSeed(deps);
    const output = lines.join('\n');
    for (const secret of [DEMO_EMAIL, DEMO_PASSWORD, services.ownersRepo.rows[0].passwordHash, 'scrypt$']) {
      assert.ok(!output.includes(secret));
    }
  });

  it('the seeded demo owner logs in through the normal flow and sees the demo store', async () => {
    const app = await startAuthApp();
    try {
      await runSeed({ ...seedDeps(app).deps, password: PASSWORD });
      const login = await app.request('/login', { method: 'POST', form: { email: DEMO_EMAIL, password: PASSWORD } });
      assert.equal(login.location, '/dashboard');
      const dashboard = await app.request('/dashboard', { cookie: cookieFrom(login) });
      assert.match(dashboard.text, /Demo Shop/);
      assert.match(dashboard.text, /\/s\/demo-shop/);
    } finally {
      await app.close();
    }
  });
});

describe('seed environment', () => {
  const valid = {
    SUPABASE_URL: 'https://project.supabase.test',
    SUPABASE_SERVICE_ROLE_KEY: 'service-key',
    DEMO_OWNER_EMAIL: ' Demo@Example.com ',
    DEMO_OWNER_PASSWORD: DEMO_PASSWORD,
  };

  it('uses the signup email and password policy, normalizing the email', () => {
    const parsed = readSeedEnv(valid);
    assert.equal(parsed.email, 'demo@example.com');
    assert.equal(parsed.password, DEMO_PASSWORD);
  });

  it('reports variable names only, never values', () => {
    const secret = 'short-pw';
    assert.throws(
      () => readSeedEnv({ ...valid, DEMO_OWNER_PASSWORD: secret, DEMO_OWNER_EMAIL: 'not-an-email' }),
      (error) => {
        assert.ok(error instanceof SeedError);
        assert.match(error.message, /DEMO_OWNER_EMAIL, DEMO_OWNER_PASSWORD/);
        assert.doesNotMatch(error.message, new RegExp(`${secret}|not-an-email`));
        return true;
      },
    );
  });

  it('the demo variables are not required to boot the app', async () => {
    const { loadEnv } = await import('../../src/config/env.js');
    const config = loadEnv({
      NODE_ENV: 'test',
      BASE_URL: 'http://localhost:3000',
      SUPABASE_URL: 'https://project.supabase.test',
      SUPABASE_SERVICE_ROLE_KEY: 'k',
    });
    assert.equal(config.baseUrl, 'http://localhost:3000');
  });
});
