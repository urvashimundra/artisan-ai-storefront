import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createJobQueue } from '../../src/lib/password.js';
import { hashToken } from '../../src/services/sessionService.js';
import { CHEAP_PARAMS, INVITE_CODE, buildFakeServices } from '../helpers/fakes.js';

const SIGNUP = { email: 'Maker@Example.com', password: 'a-long-enough-password', inviteCode: INVITE_CODE };

describe('signup service', () => {
  it('creates a non-demo owner with a normalized email and an encoded scrypt hash', async () => {
    const { auth, ownersRepo } = await buildFakeServices();
    await auth.signup(SIGNUP);
    assert.equal(ownersRepo.rows.length, 1);
    assert.equal(ownersRepo.rows[0].email, 'maker@example.com');
    assert.equal(ownersRepo.rows[0].isDemo, false);
    assert.match(ownersRepo.rows[0].passwordHash, /^scrypt\$16\$1\$1\$/);
    assert.doesNotMatch(ownersRepo.rows[0].passwordHash, /a-long-enough-password/);
  });

  it('request input cannot set is_demo: strict schema rejects it and the owner is never created', async () => {
    const { auth, ownersRepo } = await buildFakeServices();
    for (const extra of [{ is_demo: true }, { isDemo: true }, { is_demo: 'true' }]) {
      await assert.rejects(auth.signup({ ...SIGNUP, ...extra }), { name: 'ZodError' });
    }
    assert.equal(ownersRepo.rows.length, 0);
  });

  it('a wrong invite code is a generic 403 and never touches the owners table', async () => {
    const { auth, ownersRepo } = await buildFakeServices();
    const wrong = { ...SIGNUP, inviteCode: 'wrong-invite-code-000000' };
    await assert.rejects(auth.signup(wrong), { code: 'INVALID_INVITE', httpStatus: 403 });
    await assert.rejects(auth.signup({ ...SIGNUP, inviteCode: undefined }), { code: 'INVALID_INVITE' });
    await assert.rejects(auth.signup({ ...SIGNUP, inviteCode: ['x'] }), { code: 'INVALID_INVITE' });
    assert.deepEqual(ownersRepo.calls, []);
  });

  it('an unset invite code makes every code invalid', async () => {
    const { auth, ownersRepo } = await buildFakeServices({ inviteCode: null });
    await assert.rejects(auth.signup({ ...SIGNUP, inviteCode: '' }), { code: 'INVALID_INVITE' });
    await assert.rejects(auth.signup(SIGNUP), { code: 'INVALID_INVITE' });
    assert.equal(ownersRepo.rows.length, 0);
  });

  it('duplicate email is disclosed only after a valid invite code', async () => {
    const { auth, ownersRepo } = await buildFakeServices();
    await auth.signup(SIGNUP);
    await assert.rejects(auth.signup({ ...SIGNUP, email: 'MAKER@example.com' }), {
      code: 'EMAIL_ALREADY_REGISTERED',
      httpStatus: 409,
    });
    const callsBefore = ownersRepo.calls.length;
    const wrongForExisting = await auth.signup({ ...SIGNUP, inviteCode: 'bad-bad-bad-bad-bad' }).catch((e) => e);
    const wrongForNew = await auth
      .signup({ ...SIGNUP, email: 'new@example.com', inviteCode: 'bad-bad-bad-bad-bad' })
      .catch((e) => e);
    assert.equal(wrongForExisting.code, wrongForNew.code);
    assert.equal(wrongForExisting.httpStatus, wrongForNew.httpStatus);
    assert.equal(wrongForExisting.message, wrongForNew.message);
    assert.equal(ownersRepo.calls.length, callsBefore);
  });

  it('two concurrent signups with the same email and a valid code: one succeeds, one gets 409, one owner row', async () => {
    const { auth, ownersRepo } = await buildFakeServices({ ownersOptions: { precheckBarrier: 2 } });
    const results = await Promise.allSettled([auth.signup(SIGNUP), auth.signup(SIGNUP)]);
    const fulfilled = results.filter((result) => result.status === 'fulfilled');
    const rejected = results.filter((result) => result.status === 'rejected');
    assert.equal(fulfilled.length, 1);
    assert.equal(rejected.length, 1);
    assert.equal(rejected[0].reason.code, 'EMAIL_ALREADY_REGISTERED');
    assert.equal(rejected[0].reason.httpStatus, 409);
    assert.equal(ownersRepo.rows.length, 1);
  });

  it('createOwnerRecord applies the same policy and is the only path that accepts isDemo', async () => {
    const { auth, ownersRepo } = await buildFakeServices();
    await assert.rejects(auth.createOwnerRecord({ email: 'x@example.com', password: 'short', isDemo: true }), {
      name: 'ZodError',
    });
    await auth.createOwnerRecord({ email: 'demo@example.com', password: 'a-long-enough-password', isDemo: true });
    assert.equal(ownersRepo.rows[0].isDemo, true);
  });
});

describe('login service', () => {
  async function seeded(options) {
    const services = await buildFakeServices(options);
    await services.auth.signup(SIGNUP);
    return services;
  }

  it('returns a token whose SHA-256 (not the token) is stored with a 7 day expiry', async () => {
    const fixed = Date.parse('2026-11-15T00:00:00.000Z');
    const { auth, sessionsRepo } = await seeded({ now: () => fixed });
    const { token } = await auth.login({ email: 'maker@example.com', password: SIGNUP.password });
    assert.match(token, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(sessionsRepo.rows.length, 1);
    assert.equal(sessionsRepo.rows[0].tokenHash, hashToken(token));
    assert.notEqual(sessionsRepo.rows[0].tokenHash, token);
    assert.equal(sessionsRepo.rows[0].expiresAt, '2026-11-22T00:00:00.000Z');
    assert.ok(!JSON.stringify(sessionsRepo.rows).includes(token));
  });

  it('issues a new token on every login and deletes that owner expired sessions', async () => {
    let now = Date.parse('2026-11-15T00:00:00.000Z');
    const { auth, sessionsRepo } = await seeded({ now: () => now });
    const credentials = { email: 'maker@example.com', password: SIGNUP.password };
    const first = await auth.login(credentials);
    now += 8 * 24 * 60 * 60 * 1000;
    const second = await auth.login(credentials);
    assert.notEqual(first.token, second.token);
    assert.equal(sessionsRepo.rows.length, 1);
    assert.equal(sessionsRepo.rows[0].tokenHash, hashToken(second.token));
  });

  it('wrong password, unknown email and invalid input fail with the identical error', async () => {
    const { auth } = await seeded();
    const failures = [];
    for (const body of [
      { email: 'maker@example.com', password: 'wrong password here' },
      { email: 'nobody@example.com', password: 'wrong password here' },
      { email: 'not-an-email', password: 'x' },
      {},
      undefined,
    ]) {
      failures.push(await auth.login(body).catch((error) => error));
    }
    for (const failure of failures) {
      assert.equal(failure.code, 'INVALID_CREDENTIALS');
      assert.equal(failure.httpStatus, 401);
      assert.equal(failure.message, failures[0].message);
    }
  });

  it('an unknown email still performs a hash verification (dummy path); known email does one verify', async () => {
    const derived = [];
    const queue = { run: (task) => ((derived.push('derive')), task()) };
    const { auth } = await seeded({ passwordOptions: { queue } });
    derived.length = 0;
    await auth.login({ email: 'nobody@example.com', password: 'whatever-it-is' }).catch(() => {});
    assert.equal(derived.length, 1);
    derived.length = 0;
    await auth.login({ email: 'maker@example.com', password: 'whatever-it-is' }).catch(() => {});
    assert.equal(derived.length, 1);
  });

  it('a busy queue surfaces as 503 BUSY, not as invalid credentials', async () => {
    const queue = createJobQueue({ maxConcurrent: 1, maxQueueDepth: 0 });
    const { auth } = await seeded({ passwordOptions: { queue } });
    let release;
    const hold = queue.run(() => new Promise((resolve) => (release = resolve)));
    await assert.rejects(auth.login({ email: 'maker@example.com', password: SIGNUP.password }), {
      code: 'BUSY',
      httpStatus: 503,
    });
    release();
    await hold;
  });
});

describe('session service', () => {
  const credentials = { email: 'maker@example.com', password: SIGNUP.password };

  it('resolves a valid token to the owner, and unknown, malformed or missing tokens to null', async () => {
    const { auth, sessions, ownersRepo } = await buildFakeServices();
    await auth.signup(SIGNUP);
    const { token } = await auth.login(credentials);
    assert.deepEqual(await sessions.resolve(token), { id: ownersRepo.rows[0].id, isDemo: false });
    assert.equal(await sessions.resolve('A'.repeat(43)), null);
    assert.equal(await sessions.resolve('not a token'), null);
    assert.equal(await sessions.resolve(undefined), null);
  });

  it('rejects an expired session and deletes its row', async () => {
    let now = Date.parse('2026-11-15T00:00:00.000Z');
    const { auth, sessions, sessionsRepo } = await buildFakeServices({ now: () => now });
    await auth.signup(SIGNUP);
    const { token } = await auth.login(credentials);
    now += 7 * 24 * 60 * 60 * 1000;
    assert.equal(await sessions.resolve(token), null);
    assert.equal(sessionsRepo.deleted.length, 1);
    assert.equal(sessionsRepo.rows.length, 0);
  });

  it('destroy deletes the current session row only', async () => {
    const { auth, sessions, sessionsRepo } = await buildFakeServices();
    await auth.signup(SIGNUP);
    const first = await auth.login(credentials);
    const second = await auth.login(credentials);
    await sessions.destroy(first.token);
    assert.equal(sessionsRepo.rows.length, 1);
    assert.equal(await sessions.resolve(first.token), null);
    assert.ok(await sessions.resolve(second.token));
  });
});

describe('store service', () => {
  const STORE = { name: 'Clay Works', slug: 'clay-works', defaultLanguage: 'gu', story: 'Hand made pots.' };

  it('creates one store per owner and maps unique violations by constraint name', async () => {
    const { auth, stores, storesRepo, ownersRepo } = await buildFakeServices();
    await auth.signup(SIGNUP);
    await auth.signup({ ...SIGNUP, email: 'second@example.com' });
    const [first, second] = ownersRepo.rows;
    await stores.create(first.id, STORE);
    await assert.rejects(stores.create(first.id, { ...STORE, slug: 'another' }), {
      code: 'STORE_EXISTS',
      httpStatus: 409,
    });
    await assert.rejects(stores.create(second.id, STORE), { code: 'SLUG_TAKEN', httpStatus: 409 });
    assert.equal(storesRepo.rows.length, 1);
  });

  it('rejects reserved and malformed slugs and unknown keys before any insert', async () => {
    const { stores, storesRepo } = await buildFakeServices();
    for (const bad of [{ slug: 'admin' }, { slug: 'Bad Slug' }, { store_id: 'x' }, { defaultLanguage: 'fr' }]) {
      await assert.rejects(stores.create('owner-id', { ...STORE, ...bad }), { name: 'ZodError' });
    }
    assert.equal(storesRepo.rows.length, 0);
  });

  it('an unrecognized unique violation is not mapped to a conflict', async () => {
    const { stores, storesRepo } = await buildFakeServices();
    storesRepo.insert = async () => {
      const { UniqueViolation } = await import('../../src/repositories/pgErrors.js');
      throw new UniqueViolation('unknown');
    };
    await assert.rejects(stores.create('owner-id', STORE), { name: 'UniqueViolation' });
  });
});

describe('cheap-parameter sanity', () => {
  it('fakes use the cheap scrypt parameters', () => {
    assert.deepEqual({ ...CHEAP_PARAMS }, { N: 16, r: 1, p: 1 });
  });
});
