import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createJobQueue } from '../../src/lib/password.js';
import { INVITE_CODE } from '../helpers/fakes.js';
import { ORIGIN, PASSWORD, STORE_FORM, cookieFrom, signupAndLogin, startAuthApp } from '../helpers/appHarness.js';

const SIGNUP = { email: 'maker@example.com', password: PASSWORD, inviteCode: INVITE_CODE };
const LOGIN = { email: SIGNUP.email, password: PASSWORD };
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const forwarded = (ip) => ({ 'x-forwarded-for': ip });
const SRC = fileURLToPath(new URL('../../src/', import.meta.url));

describe('origin check on browser routes', () => {
  it('rejects a mismatched Origin with 403 on every state-changing route, before any work is done', async () => {
    const app = await startAuthApp();
    try {
      const cookie = await signupAndLogin(app);
      const rows = app.sessionsRepo.rows.length;
      for (const [path, form] of [['/login', LOGIN], ['/signup', SIGNUP], ['/logout', {}], ['/store/new', STORE_FORM]]) {
        const res = await app.request(path, { method: 'POST', form, cookie, origin: 'https://evil.test' });
        assert.equal(res.status, 403, path);
        assert.match(res.text, /Not allowed/);
      }
      assert.equal(app.sessionsRepo.rows.length, rows);
      assert.equal(app.storesRepo.rows.length, 0);
    } finally {
      await app.close();
    }
  });

  it('accepts a matching ALLOWED_ORIGINS entry', async () => {
    const app = await startAuthApp({ config: { allowedOrigins: [ORIGIN, 'https://theartisanstory.in'] } });
    try {
      const res = await app.request('/login', { method: 'POST', form: LOGIN, origin: 'https://theartisanstory.in' });
      assert.equal(res.status, 401);
    } finally {
      await app.close();
    }
  });

  it('a missing Origin needs Sec-Fetch-Site: same-origin', async () => {
    const app = await startAuthApp();
    try {
      const same = await app.request('/login', { method: 'POST', form: LOGIN, origin: null, headers: { 'sec-fetch-site': 'same-origin' } });
      assert.equal(same.status, 401);
      const cross = await app.request('/login', { method: 'POST', form: LOGIN, origin: null, headers: { 'sec-fetch-site': 'cross-site' } });
      assert.equal(cross.status, 403);
      const none = await app.request('/login', { method: 'POST', form: LOGIN, origin: null });
      assert.equal(none.status, 403);
    } finally {
      await app.close();
    }
  });

  it('does not trust forwarded host headers', async () => {
    const app = await startAuthApp();
    try {
      const res = await app.request('/login', {
        method: 'POST',
        form: LOGIN,
        origin: 'https://evil.test',
        headers: { 'x-forwarded-host': 'evil.test', 'x-forwarded-proto': 'https' },
      });
      assert.equal(res.status, 403);
    } finally {
      await app.close();
    }
  });

  it('GET requests are not Origin-checked', async () => {
    const app = await startAuthApp();
    try {
      assert.equal((await app.request('/login', { origin: 'https://evil.test' })).status, 200);
    } finally {
      await app.close();
    }
  });
});

describe('signup and invite security', () => {
  it('signup is a 404 for GET and POST when no invite code is configured', async () => {
    const app = await startAuthApp({ inviteCode: null });
    try {
      for (const method of ['GET', 'POST']) {
        const res = await app.request('/signup', { method, form: method === 'POST' ? SIGNUP : undefined });
        assert.equal(res.status, 404, method);
        assert.match(res.text, /Page not found/);
      }
      assert.equal(app.ownersRepo.rows.length, 0);
    } finally {
      await app.close();
    }
  });

  it('a wrong invite code is the same 403 for an existing and a new email, with no owners access', async () => {
    const app = await startAuthApp();
    try {
      await app.request('/signup', { method: 'POST', form: SIGNUP });
      const callsBefore = app.ownersRepo.calls.length;
      const wrong = { ...SIGNUP, inviteCode: 'wrong-code-wrong-code' };
      const existing = await app.request('/signup', { method: 'POST', form: wrong });
      const fresh = await app.request('/signup', { method: 'POST', form: { ...wrong, email: 'new@example.com' } });
      assert.equal(existing.status, 403);
      assert.equal(fresh.status, 403);
      assert.equal(existing.text.replace(/value="[^"]*"/, ''), fresh.text.replace(/value="[^"]*"/, ''));
      assert.equal(app.ownersRepo.calls.length, callsBefore);
      assert.doesNotMatch(existing.text, /already registered/);
    } finally {
      await app.close();
    }
  });

  it('a duplicate email is disclosed only after a valid invite code', async () => {
    const app = await startAuthApp();
    try {
      await app.request('/signup', { method: 'POST', form: SIGNUP });
      const duplicate = await app.request('/signup', { method: 'POST', form: SIGNUP });
      assert.equal(duplicate.status, 409);
      assert.match(duplicate.text, /already registered/);
    } finally {
      await app.close();
    }
  });

  it('two concurrent signups with the same email give one 303, one 409 and one owner', async () => {
    const app = await startAuthApp({ servicesOptions: { ownersOptions: { precheckBarrier: 2 } } });
    try {
      const results = await Promise.all([
        app.request('/signup', { method: 'POST', form: SIGNUP }),
        app.request('/signup', { method: 'POST', form: SIGNUP }),
      ]);
      assert.deepEqual(results.map((res) => res.status).sort(), [303, 409]);
      assert.equal(app.ownersRepo.rows.length, 1);
    } finally {
      await app.close();
    }
  });

  it('is_demo cannot be set through signup: the request is rejected and no owner is created', async () => {
    const app = await startAuthApp();
    try {
      for (const field of ['is_demo', 'isDemo']) {
        const res = await app.request('/signup', { method: 'POST', form: { ...SIGNUP, [field]: 'true' } });
        assert.equal(res.status, 400, field);
      }
      assert.equal(app.ownersRepo.rows.length, 0);
      await app.request('/signup', { method: 'POST', form: SIGNUP });
      assert.equal(app.ownersRepo.rows[0].isDemo, false);
    } finally {
      await app.close();
    }
  });

  it('no controller or route references isDemo or createOwnerRecord', () => {
    for (const dir of ['controllers', 'routes', 'middleware']) {
      for (const file of readdirSync(`${SRC}${dir}`)) {
        const source = readFileSync(`${SRC}${dir}/${file}`, 'utf8');
        assert.doesNotMatch(source, /isDemo|is_demo|createOwnerRecord/, `${dir}/${file}`);
      }
    }
  });
});

describe('login responses', () => {
  it('wrong password and unknown email give byte-identical status, body and headers of interest', async () => {
    const app = await startAuthApp();
    try {
      await app.request('/signup', { method: 'POST', form: SIGNUP });
      const headers = { 'x-request-id': 'same-id' };
      const wrongPassword = await app.request('/login', { method: 'POST', form: { ...LOGIN, password: 'incorrect-password-here' }, headers });
      const unknownEmail = await app.request('/login', { method: 'POST', form: { email: 'nobody@example.com', password: 'incorrect-password-here' }, headers });
      const malformed = await app.request('/login', { method: 'POST', form: { email: 'x', password: '' }, headers });
      for (const res of [unknownEmail, malformed]) {
        assert.equal(res.status, wrongPassword.status);
        assert.equal(res.text, wrongPassword.text);
        assert.deepEqual(res.setCookie, []);
      }
      assert.equal(wrongPassword.status, 401);
    } finally {
      await app.close();
    }
  });

  it('an unknown email performs one hash verification, like a wrong password does', async () => {
    const runs = [];
    const real = createJobQueue();
    const queue = { run: (task) => (runs.push(1), real.run(task)) };
    const app = await startAuthApp({ servicesOptions: { passwordOptions: { queue } } });
    try {
      await app.request('/signup', { method: 'POST', form: SIGNUP });
      runs.length = 0;
      await app.request('/login', { method: 'POST', form: { email: 'nobody@example.com', password: 'whatever-password' } });
      const unknown = runs.length;
      runs.length = 0;
      await app.request('/login', { method: 'POST', form: { ...LOGIN, password: 'whatever-password' } });
      assert.equal(unknown, 1);
      assert.equal(runs.length, unknown);
    } finally {
      await app.close();
    }
  });
});

describe('login and signup rate limits', () => {
  const tight = (overrides) => ({
    loginFailure: { windowMs: 60_000, limit: 1000 },
    loginIp: { windowMs: 60_000, limit: 1000 },
    signup: { windowMs: 60_000, limit: 1000 },
    ...overrides,
  });
  const attempt = (app, email, ip = '203.0.113.1', password = 'wrong-password-here') =>
    app.request('/login', { method: 'POST', form: { email, password }, headers: forwarded(ip) });

  it('the failed-login limiter blocks repeated failures for the same IP and email', async () => {
    const app = await startAuthApp({ authRateLimits: tight({ loginFailure: { windowMs: 60_000, limit: 2 } }) });
    try {
      assert.equal((await attempt(app, 'a@example.com')).status, 401);
      assert.equal((await attempt(app, 'a@example.com')).status, 401);
      const blocked = await attempt(app, 'a@example.com');
      assert.equal(blocked.status, 429);
      assert.match(blocked.text, /Too many requests/);
      assert.equal((await attempt(app, 'A@Example.com ')).status, 429);
    } finally {
      await app.close();
    }
  });

  it('successful logins are skipped by the failed-login limiter', async () => {
    const app = await startAuthApp({ authRateLimits: tight({ loginFailure: { windowMs: 60_000, limit: 2 } }) });
    try {
      await app.request('/signup', { method: 'POST', form: SIGNUP });
      for (let index = 0; index < 4; index += 1) {
        const res = await attempt(app, SIGNUP.email, '203.0.113.1', PASSWORD);
        assert.equal(res.status, 303);
        await wait(10);
      }
      assert.equal((await attempt(app, SIGNUP.email)).status, 401);
      assert.equal((await attempt(app, SIGNUP.email)).status, 401);
      assert.equal((await attempt(app, SIGNUP.email)).status, 429);
    } finally {
      await app.close();
    }
  });

  it('different emails from one IP do not bypass the per-IP login limiter', async () => {
    const app = await startAuthApp({ authRateLimits: tight({ loginIp: { windowMs: 60_000, limit: 3 } }) });
    try {
      for (const email of ['a@example.com', 'b@example.com', 'c@example.com']) {
        assert.equal((await attempt(app, email)).status, 401);
      }
      assert.equal((await attempt(app, 'd@example.com')).status, 429);
      assert.equal((await attempt(app, 'e@example.com', '203.0.113.99')).status, 401);
    } finally {
      await app.close();
    }
  });

  it('there is no email-only lockout: failures from another IP never block the real owner', async () => {
    const app = await startAuthApp({ authRateLimits: tight({ loginFailure: { windowMs: 60_000, limit: 2 } }) });
    try {
      await app.request('/signup', { method: 'POST', form: SIGNUP });
      for (let index = 0; index < 5; index += 1) await attempt(app, SIGNUP.email, '198.51.100.7');
      assert.equal((await attempt(app, SIGNUP.email, '198.51.100.7')).status, 429);
      const owner = await attempt(app, SIGNUP.email, '203.0.113.1', PASSWORD);
      assert.equal(owner.status, 303);
      assert.equal((await attempt(app, 'other@example.com', '198.51.100.7')).status, 401);
    } finally {
      await app.close();
    }
  });

  it('signup is limited per IP', async () => {
    const app = await startAuthApp({ authRateLimits: tight({ signup: { windowMs: 60_000, limit: 2 } }) });
    try {
      const post = (email, ip) =>
        app.request('/signup', { method: 'POST', form: { ...SIGNUP, email }, headers: forwarded(ip) });
      assert.equal((await post('a@example.com', '203.0.113.1')).status, 303);
      assert.equal((await post('b@example.com', '203.0.113.1')).status, 303);
      assert.equal((await post('c@example.com', '203.0.113.1')).status, 429);
      assert.equal((await post('c@example.com', '203.0.113.2')).status, 303);
    } finally {
      await app.close();
    }
  });

  it('a 503 BUSY response does not count as a failed login and carries Retry-After', async () => {
    const queue = createJobQueue({ maxConcurrent: 1, maxQueueDepth: 0 });
    const app = await startAuthApp({
      authRateLimits: tight({ loginFailure: { windowMs: 60_000, limit: 1 } }),
      servicesOptions: { passwordOptions: { queue } },
    });
    try {
      let release;
      const hold = queue.run(() => new Promise((resolve) => (release = resolve)));
      const busy = await attempt(app, 'a@example.com');
      assert.equal(busy.status, 503);
      assert.equal(busy.headers.get('retry-after'), '5');
      assert.match(busy.text, /Server busy/);
      release();
      await hold;
      await wait(20);
      assert.equal((await attempt(app, 'a@example.com')).status, 401);
      assert.equal((await attempt(app, 'a@example.com')).status, 429);
    } finally {
      await app.close();
    }
  });
});

describe('tenancy', () => {
  async function twoOwners(app) {
    const a = await signupAndLogin(app, 'a@example.com');
    const b = await signupAndLogin(app, 'b@example.com');
    await app.request('/store/new', { method: 'POST', cookie: a, form: { ...STORE_FORM, name: 'Store Of A', slug: 'store-a' } });
    await app.request('/store/new', { method: 'POST', cookie: b, form: { ...STORE_FORM, name: 'Store Of B', slug: 'store-b' } });
    return { a, b };
  }

  it('each owner sees only their own store; cross-tenant access is impossible through the session', async () => {
    const app = await startAuthApp();
    try {
      const { a, b } = await twoOwners(app);
      const pageA = (await app.request('/dashboard', { cookie: a })).text;
      const pageB = (await app.request('/dashboard', { cookie: b })).text;
      assert.match(pageA, /Store Of A/);
      assert.doesNotMatch(pageA, /Store Of B/);
      assert.match(pageB, /Store Of B/);
      assert.doesNotMatch(pageB, /Store Of A/);
    } finally {
      await app.close();
    }
  });

  it('a store id in the query string or form body is ignored or rejected, never used', async () => {
    const app = await startAuthApp();
    try {
      const { a } = await twoOwners(app);
      const [storeB] = app.storesRepo.rows.filter((row) => row.slug === 'store-b');
      const viaQuery = await app.request(`/dashboard?store_id=${storeB.id}&storeId=${storeB.id}`, { cookie: a });
      assert.match(viaQuery.text, /Store Of A/);
      assert.doesNotMatch(viaQuery.text, /Store Of B/);
      const c = await signupAndLogin(app, 'c@example.com');
      const viaBody = await app.request('/store/new', { method: 'POST', cookie: c, form: { ...STORE_FORM, slug: 'store-c', store_id: storeB.id } });
      assert.equal(viaBody.status, 400);
      assert.equal(app.storesRepo.rows.length, 2);
    } finally {
      await app.close();
    }
  });

  it('the owner is resolved from the session only: a forged or other-owner cookie value cannot select a store', async () => {
    const app = await startAuthApp();
    try {
      const { a } = await twoOwners(app);
      const forged = a.replace(/=.+$/, `=${'B'.repeat(43)}`);
      assert.equal((await app.request('/dashboard', { cookie: forged })).location, '/login');
      const [ownerA] = app.ownersRepo.rows;
      assert.equal((await app.request(`/dashboard`, { cookie: `owner_id=${ownerA.id}` })).location, '/login');
    } finally {
      await app.close();
    }
  });

  it('after logout the old cookie no longer reaches the dashboard', async () => {
    const app = await startAuthApp();
    try {
      const { a } = await twoOwners(app);
      await app.request('/logout', { method: 'POST', cookie: a });
      assert.equal((await app.request('/dashboard', { cookie: a })).location, '/login');
    } finally {
      await app.close();
    }
  });
});

describe('logging', () => {
  it('never logs emails, passwords, tokens or cookies during signup, login and failures', async () => {
    const app = await startAuthApp();
    try {
      await app.request('/signup', { method: 'POST', form: SIGNUP });
      const login = await app.request('/login', { method: 'POST', form: LOGIN });
      await app.request('/login', { method: 'POST', form: { ...LOGIN, password: 'incorrect-password-here' } });
      await app.request('/dashboard', { cookie: cookieFrom(login) });
      const logs = JSON.stringify(app.logs);
      for (const secret of [SIGNUP.email, PASSWORD, 'incorrect-password-here', INVITE_CODE, cookieFrom(login).split('=')[1]]) {
        assert.ok(!logs.includes(secret), `log contains ${secret.slice(0, 6)}...`);
      }
    } finally {
      await app.close();
    }
  });
});
