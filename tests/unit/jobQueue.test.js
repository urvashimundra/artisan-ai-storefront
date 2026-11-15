import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createJobQueue } from '../../src/lib/password.js';

function controllableJob(log, name) {
  let release;
  let fail;
  const promise = new Promise((resolve, reject) => {
    release = resolve;
    fail = reject;
  });
  return { release, fail, task: () => (log.push(`start:${name}`), promise) };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

function fakeTimers() {
  const timers = [];
  return {
    timers,
    setTimer: (callback) => {
      const timer = { callback, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimer: (timer) => {
      if (timer) timer.cleared = true;
    },
  };
}

describe('scrypt job queue', () => {
  it('never runs more than maxConcurrent jobs and runs a queued job when a slot frees', async () => {
    const queue = createJobQueue({ maxConcurrent: 2, maxQueueDepth: 5 });
    const log = [];
    const jobs = ['a', 'b', 'c'].map((name) => controllableJob(log, name));
    const results = jobs.map((job) => queue.run(job.task));
    await tick();
    assert.deepEqual(log, ['start:a', 'start:b']);
    jobs[0].release('A');
    assert.equal(await results[0], 'A');
    await tick();
    assert.deepEqual(log, ['start:a', 'start:b', 'start:c']);
    jobs[1].release('B');
    jobs[2].release('C');
    assert.deepEqual(await Promise.all(results), ['A', 'B', 'C']);
  });

  it('serves queued jobs in FIFO order', async () => {
    const queue = createJobQueue({ maxConcurrent: 1, maxQueueDepth: 5 });
    const log = [];
    const jobs = ['a', 'b', 'c', 'd'].map((name) => controllableJob(log, name));
    const results = jobs.map((job) => queue.run(job.task));
    for (const job of jobs) {
      await tick();
      job.release();
    }
    await Promise.all(results);
    assert.deepEqual(log, ['start:a', 'start:b', 'start:c', 'start:d']);
  });

  it('rejects immediately with 503 BUSY when running slots and queue are full', async () => {
    const queue = createJobQueue({ maxConcurrent: 1, maxQueueDepth: 1 });
    const log = [];
    const running = controllableJob(log, 'running');
    const queued = controllableJob(log, 'queued');
    const first = queue.run(running.task);
    const second = queue.run(queued.task);
    await assert.rejects(queue.run(() => assert.fail('must not run')), { code: 'BUSY', httpStatus: 503 });
    running.release();
    queued.release();
    await Promise.all([first, second]);
  });

  it('releases the slot when a job throws', async () => {
    const queue = createJobQueue({ maxConcurrent: 1, maxQueueDepth: 0 });
    await assert.rejects(queue.run(() => Promise.reject(new Error('boom'))), /boom/);
    await assert.rejects(queue.run(() => { throw new Error('sync boom'); }), /sync boom/);
    assert.equal(await queue.run(async () => 'ok'), 'ok');
  });

  it('rejects a queued job with 503 BUSY after maxWaitMs and removes it from the queue', async () => {
    const { timers, setTimer, clearTimer } = fakeTimers();
    const queue = createJobQueue({ maxConcurrent: 1, maxQueueDepth: 2, maxWaitMs: 5000, setTimer, clearTimer });
    const running = controllableJob([], 'running');
    const first = queue.run(running.task);
    const waiter = queue.run(() => assert.fail('timed-out job must not run'));
    timers[0].callback();
    await assert.rejects(waiter, { code: 'BUSY', httpStatus: 503 });
    running.release();
    await first;
    assert.equal(await queue.run(async () => 'after'), 'after');
  });

  it('clears the wait timer when a queued job starts', async () => {
    const { timers, setTimer, clearTimer } = fakeTimers();
    const queue = createJobQueue({ maxConcurrent: 1, maxQueueDepth: 2, setTimer, clearTimer });
    const running = controllableJob([], 'running');
    const first = queue.run(running.task);
    const second = queue.run(async () => 'second');
    running.release();
    await first;
    assert.equal(await second, 'second');
    assert.equal(timers[0].cleared, true);
  });
});
