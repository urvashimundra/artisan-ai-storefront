import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { busy } from './errors.js';

export const SCRYPT_N = 2 ** 15;
export const SCRYPT_R = 8;
export const SCRYPT_P = 1;
export const SCRYPT_KEY_LENGTH = 64;
export const SALT_BYTES = 16;
const BYTES_PER_MIB = 1024 * 1024;
/**
 * scrypt needs about 128 * N * r bytes = 32 MiB at these parameters. Node's default maxmem (32 MiB) is too
 * tight, so it is set to twice the requirement (64 MiB) as a safety margin.
 */
export const SCRYPT_MAXMEM = 64 * BYTES_PER_MIB;
export const HASH_PREFIX = 'scrypt';
export const MAX_CONCURRENT = 2;
export const MAX_QUEUE_DEPTH = 20;
export const MAX_QUEUE_WAIT_MS = 5000;

const MIN_PARSED_SALT_BYTES = 8;
const MAX_PARSED_SALT_BYTES = 64;
const MIN_PARSED_KEY_BYTES = 16;
const MAX_PARSED_KEY_BYTES = 128;
const MAX_PARSED_LOG2_N = 20;
const MAX_PARSED_R = 32;
const MAX_PARSED_P = 16;
const DUMMY_SECRET_BYTES = 32;
const HASH_FIELD_COUNT = 6;
const INTEGER = /^[1-9]\d{0,9}$/;

export const DEFAULT_PARAMS = Object.freeze({ N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });

/**
 * Bounded FIFO job queue. Rejects with 503 BUSY when running slots and queue are full, or when a queued job
 * waits longer than maxWaitMs. A slot is always released, including when the job throws.
 * @param {{ maxConcurrent?: number, maxQueueDepth?: number, maxWaitMs?: number,
 *   setTimer?: Function, clearTimer?: Function }} [options]
 * @returns {{ run: <T>(task: () => Promise<T>) => Promise<T> }}
 */
export function createJobQueue({
  maxConcurrent = MAX_CONCURRENT,
  maxQueueDepth = MAX_QUEUE_DEPTH,
  maxWaitMs = MAX_QUEUE_WAIT_MS,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  let running = 0;
  const waiting = [];

  function launch(job) {
    running += 1;
    Promise.resolve()
      .then(job.task)
      .then(job.resolve, job.reject)
      .finally(() => {
        running -= 1;
        startWaiting();
      });
  }

  function startWaiting() {
    while (running < maxConcurrent && waiting.length > 0) {
      const job = waiting.shift();
      clearTimer(job.timer);
      launch(job);
    }
  }

  function expire(job) {
    const index = waiting.indexOf(job);
    if (index === -1) return;
    waiting.splice(index, 1);
    job.reject(busy());
  }

  function run(task) {
    return new Promise((resolve, reject) => {
      const job = { task, resolve, reject, timer: null };
      if (running < maxConcurrent && waiting.length === 0) return launch(job);
      if (waiting.length >= maxQueueDepth) return reject(busy());
      job.timer = setTimer(() => expire(job), maxWaitMs);
      return waiting.push(job);
    });
  }

  return { run };
}

function deriveKey(password, salt, keyLength, params) {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keyLength, { ...params, maxmem: SCRYPT_MAXMEM }, (error, key) =>
      error ? reject(error) : resolve(key),
    );
  });
}

function canonicalBase64(text) {
  const buffer = Buffer.from(text, 'base64');
  return buffer.toString('base64') === text ? buffer : null;
}

function isPowerOfTwoWithin(n) {
  return Number.isInteger(Math.log2(n)) && n >= 2 && n <= 2 ** MAX_PARSED_LOG2_N;
}

function parseParams(nText, rText, pText) {
  if (![nText, rText, pText].every((text) => INTEGER.test(text))) return null;
  const params = { N: Number(nText), r: Number(rText), p: Number(pText) };
  const valid = isPowerOfTwoWithin(params.N) && params.r <= MAX_PARSED_R && params.p <= MAX_PARSED_P;
  return valid ? params : null;
}

/**
 * Parses `scrypt$N$r$p$saltB64$hashB64`. Returns null for any malformed or out-of-range value.
 * @param {unknown} encoded
 * @returns {{ params: { N: number, r: number, p: number }, salt: Buffer, hash: Buffer } | null}
 */
export function parseHash(encoded) {
  if (typeof encoded !== 'string') return null;
  const fields = encoded.split('$');
  if (fields.length !== HASH_FIELD_COUNT || fields[0] !== HASH_PREFIX) return null;
  const params = parseParams(fields[1], fields[2], fields[3]);
  const salt = canonicalBase64(fields[4]);
  const hash = canonicalBase64(fields[5]);
  if (!params || !salt || !hash) return null;
  const saltOk = salt.length >= MIN_PARSED_SALT_BYTES && salt.length <= MAX_PARSED_SALT_BYTES;
  const hashOk = hash.length >= MIN_PARSED_KEY_BYTES && hash.length <= MAX_PARSED_KEY_BYTES;
  return saltOk && hashOk ? { params, salt, hash } : null;
}

function encodeHash(params, salt, hash) {
  const head = [HASH_PREFIX, params.N, params.r, params.p].join('$');
  return `${head}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

/**
 * Password hashing service. Every scrypt call goes through the bounded queue. The dummy hash used for
 * unknown-email logins is computed once here, with the same parameters as real hashes.
 * Inputs must already be NFKC-normalized and length-checked by the caller (see credentialRules).
 * @param {{ params?: { N: number, r: number, p: number }, queue?: ReturnType<typeof createJobQueue>,
 *   derive?: typeof deriveKey }} [options]
 * @returns {Promise<{ hash: (password: string) => Promise<string>,
 *   verify: (password: string, encoded: string) => Promise<boolean>,
 *   verifyDummy: (password: string) => Promise<false> }>}
 */
export async function createPasswordService({
  params = DEFAULT_PARAMS,
  queue = createJobQueue(),
  derive = deriveKey,
} = {}) {
  async function hash(password) {
    const salt = randomBytes(SALT_BYTES);
    const key = await queue.run(() => derive(password, salt, SCRYPT_KEY_LENGTH, params));
    return encodeHash(params, salt, key);
  }

  async function verify(password, encoded) {
    const parsed = parseHash(encoded);
    if (!parsed) return false;
    const key = await queue.run(() => derive(password, parsed.salt, parsed.hash.length, parsed.params));
    return key.length === parsed.hash.length && timingSafeEqual(key, parsed.hash);
  }

  const dummyHash = await hash(randomBytes(DUMMY_SECRET_BYTES).toString('base64url'));

  async function verifyDummy(password) {
    await verify(password, dummyHash);
    return false;
  }

  return { hash, verify, verifyDummy };
}
