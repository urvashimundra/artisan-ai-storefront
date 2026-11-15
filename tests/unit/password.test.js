import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  DEFAULT_PARAMS,
  SCRYPT_KEY_LENGTH,
  SCRYPT_MAXMEM,
  createPasswordService,
  parseHash,
} from '../../src/lib/password.js';

const CHEAP = { N: 16, r: 1, p: 1 };
const GOOD_PASSWORD = 'correct horse battery';

function spyDerive() {
  const calls = [];
  const derive = async (password, salt, keyLength, params) => {
    calls.push({ password, keyLength, params });
    return Buffer.alloc(keyLength, salt[0]);
  };
  return { calls, derive };
}

describe('password hashing', () => {
  it('hashes and verifies, producing a unique salt per hash', async () => {
    const service = await createPasswordService({ params: CHEAP });
    const first = await service.hash(GOOD_PASSWORD);
    const second = await service.hash(GOOD_PASSWORD);
    assert.notEqual(first, second);
    assert.equal(await service.verify(GOOD_PASSWORD, first), true);
    assert.equal(await service.verify('wrong password here', first), false);
  });

  it('encodes parameters as scrypt$N$r$p$salt$hash and parses them back', async () => {
    const service = await createPasswordService({ params: CHEAP });
    const encoded = await service.hash(GOOD_PASSWORD);
    assert.match(encoded, /^scrypt\$16\$1\$1\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
    const parsed = parseHash(encoded);
    assert.deepEqual(parsed.params, CHEAP);
    assert.equal(parsed.salt.length, 16);
    assert.equal(parsed.hash.length, SCRYPT_KEY_LENGTH);
  });

  it('rejects malformed encoded hashes', async () => {
    const service = await createPasswordService({ params: CHEAP });
    const good = await service.hash(GOOD_PASSWORD);
    const [prefix, n, r, p, salt, hash] = good.split('$');
    const bad = [
      '',
      'plaintext',
      `bcrypt$${n}$${r}$${p}$${salt}$${hash}`,
      `${prefix}$15$${r}$${p}$${salt}$${hash}`,
      `${prefix}$${2 ** 25}$${r}$${p}$${salt}$${hash}`,
      `${prefix}$${n}$0$${p}$${salt}$${hash}`,
      `${prefix}$${n}$${r}$${p}$!!!$${hash}`,
      `${prefix}$${n}$${r}$${p}$${salt}$AAAA`,
      `${prefix}$${n}$${r}$${p}$${salt}`,
      `${good}$extra`,
    ];
    for (const encoded of bad) {
      assert.equal(parseHash(encoded), null, encoded);
      assert.equal(await service.verify(GOOD_PASSWORD, encoded), false);
    }
    assert.equal(parseHash(undefined), null);
  });

  it('compares with equal-length buffers and treats a length mismatch as a failed verification', async () => {
    const lengths = [];
    const derive = async (_password, _salt, keyLength) => {
      lengths.push(keyLength);
      return Buffer.alloc(keyLength - 1);
    };
    const service = await createPasswordService({ params: CHEAP, derive: spyDerive().derive });
    const encoded = await service.hash(GOOD_PASSWORD);
    const short = await createPasswordService({ params: CHEAP, derive });
    assert.equal(await short.verify(GOOD_PASSWORD, encoded), false);
    assert.deepEqual(lengths.slice(-1), [SCRYPT_KEY_LENGTH]);
  });

  it('computes the dummy hash once at initialization, with the real parameters, and reuses it', async () => {
    const { calls, derive } = spyDerive();
    const service = await createPasswordService({ params: CHEAP, derive });
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].params, CHEAP);
    assert.equal(calls[0].keyLength, SCRYPT_KEY_LENGTH);
    await service.verifyDummy('anything');
    await service.verifyDummy('anything else');
    assert.equal(calls.length, 3);
    for (const call of calls.slice(1)) {
      assert.deepEqual(call.params, CHEAP);
      assert.equal(call.keyLength, SCRYPT_KEY_LENGTH);
    }
    assert.equal(await service.verifyDummy('anything'), false);
  });

  it('runs every derive call, including the dummy one, through the queue', async () => {
    let queued = 0;
    const queue = { run: (task) => ((queued += 1), task()) };
    const service = await createPasswordService({ params: CHEAP, derive: spyDerive().derive, queue });
    assert.equal(queued, 1);
    await service.hash(GOOD_PASSWORD);
    await service.verifyDummy('x');
    assert.equal(queued, 3);
  });

  it('works at the real parameters (N=2^15, r=8, p=1) within maxmem on this runtime', async () => {
    assert.deepEqual({ ...DEFAULT_PARAMS }, { N: 32768, r: 8, p: 1 });
    assert.ok(SCRYPT_MAXMEM > 128 * DEFAULT_PARAMS.N * DEFAULT_PARAMS.r);
    const service = await createPasswordService();
    const encoded = await service.hash(GOOD_PASSWORD);
    assert.match(encoded, /^scrypt\$32768\$8\$1\$/);
    assert.equal(await service.verify(GOOD_PASSWORD, encoded), true);
  });
});
