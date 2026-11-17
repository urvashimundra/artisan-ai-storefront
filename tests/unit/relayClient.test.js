import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { RELAY_TIMEOUT_MS, createRelayClient } from '../../src/email/relayClient.js';
import { createRelayProbe } from '../../src/email/relayProbe.js';
import { createDiagnosticsService } from '../../src/services/diagnosticsService.js';

const RELAY_URL = 'http://127.0.0.1:2525';
const OWNER = 'owner@example.test';
const SHORT_TIMEOUT_MS = 20;
const HANG_KEEP_ALIVE_MS = 60_000;
const SECRET_RELAY_TEXT = 'SECRET-RELAY-TEXT';
const MESSAGE = { fromName: 'The Artisan Story', to: [OWNER], subject: 'Relay test', text: 'Hello' };

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}
const accepted = (messageId = 'msg-1') => jsonResponse(200, { success: true, messageId });
const refused = (status = 400) => jsonResponse(status, { success: false, error: SECRET_RELAY_TEXT });

/** Records every request and answers with `respond(attemptNumber, body)`; `respond` may throw to simulate a network error. */
function recordingFetch(respond) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, method: init.method, body, signal: init.signal });
    return respond(calls.length, body);
  };
  return { calls, fetchImpl };
}

/**
 * A fetch that never answers and rejects only when its abort signal fires, as the real fetch does. The keep-alive
 * timer is ref'd: AbortSignal.timeout timers are unref'd, so without it Node 22 can exit before the abort fires.
 */
const hangingFetch = (_url, init) =>
  new Promise((_resolve, reject) => {
    const keepAlive = setTimeout(() => {}, HANG_KEEP_ALIVE_MS);
    init.signal.addEventListener('abort', () => {
      clearTimeout(keepAlive);
      reject(init.signal.reason);
    });
  });

async function rejectionOf(promise) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  return assert.fail('expected a rejection');
}

function probeWith(fetchImpl, { ownerNotifyEmail = OWNER, timeoutMs } = {}) {
  const { send } = createRelayClient({ relayUrl: RELAY_URL, fetchImpl, timeoutMs });
  return createRelayProbe({ send, ownerNotifyEmail });
}

describe('relay client', () => {
  it('POSTs JSON to /api/email/send and returns only messageId and status', async () => {
    const { calls, fetchImpl } = recordingFetch(() => jsonResponse(200, { success: true, messageId: 'm-42', error: 'x' }));
    const client = createRelayClient({ relayUrl: `${RELAY_URL}/`, fetchImpl });
    assert.deepEqual(await client.send(MESSAGE), { messageId: 'm-42', httpStatus: 200 });
    assert.equal(calls[0].url, `${RELAY_URL}/api/email/send`);
    assert.equal(calls[0].method, 'POST');
    assert.deepEqual(calls[0].body, MESSAGE);
    assert.ok(calls[0].signal instanceof AbortSignal);
  });

  it('answers a refusal with RELAY_REJECTED and the HTTP status, never the provider text', async () => {
    const { fetchImpl } = recordingFetch(() => refused(400));
    const error = await rejectionOf(createRelayClient({ relayUrl: RELAY_URL, fetchImpl }).send(MESSAGE));
    assert.equal(error.code, 'RELAY_REJECTED');
    assert.equal(error.httpStatus, 400);
    assert.doesNotMatch(`${error.message} ${error.stack}`, new RegExp(SECRET_RELAY_TEXT));
  });

  it('treats a 2xx reply that is not the expected JSON, and a non-JSON error page, as RELAY_RESPONSE_INVALID', async () => {
    for (const status of [200, 502]) {
      const { fetchImpl } = recordingFetch(() => new Response('<html>gateway</html>', { status }));
      const error = await rejectionOf(createRelayClient({ relayUrl: RELAY_URL, fetchImpl }).send(MESSAGE));
      assert.equal(error.code, 'RELAY_RESPONSE_INVALID', String(status));
      assert.equal(error.httpStatus, status);
    }
  });

  it('maps a network failure to RELAY_UNREACHABLE without a status', async () => {
    const { fetchImpl } = recordingFetch(() => {
      throw new TypeError('fetch failed');
    });
    const error = await rejectionOf(createRelayClient({ relayUrl: RELAY_URL, fetchImpl }).send(MESSAGE));
    assert.equal(error.code, 'RELAY_UNREACHABLE');
    assert.equal(error.httpStatus, undefined);
  });

  it('maps an elapsed budget to RELAY_TIMEOUT', async () => {
    const error = await rejectionOf(
      createRelayClient({ relayUrl: RELAY_URL, fetchImpl: hangingFetch, timeoutMs: SHORT_TIMEOUT_MS }).send(MESSAGE),
    );
    assert.equal(error.code, 'RELAY_TIMEOUT');
  });

  it('uses a 10 second budget by default', () => {
    assert.equal(RELAY_TIMEOUT_MS, 10_000);
  });
});

describe('relay test-send probe', () => {
  it('sends one plain-text email with replyTo and reports replyTo accepted', async () => {
    const { calls, fetchImpl } = recordingFetch(() => accepted('m-7'));
    assert.deepEqual(await probeWith(fetchImpl)(), { messageId: 'm-7', httpStatus: 200, replyToAccepted: true });
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].body, {
      fromName: 'The Artisan Story',
      to: [OWNER],
      subject: 'Relay test',
      text: calls[0].body.text,
      replyTo: OWNER,
    });
    assert.doesNotMatch(calls[0].body.text, /https?:|www\./i);
  });

  it('retries exactly once without replyTo when the relay refuses it, and reports replyTo not accepted', async () => {
    const { calls, fetchImpl } = recordingFetch((_attempt, body) => (body.replyTo ? refused(422) : accepted('m-8')));
    assert.deepEqual(await probeWith(fetchImpl)(), { messageId: 'm-8', httpStatus: 200, replyToAccepted: false });
    assert.equal(calls.length, 2);
    assert.ok(!('replyTo' in calls[1].body));
  });

  it('fails with RELAY_REJECTED after one retry when both attempts are refused', async () => {
    const { calls, fetchImpl } = recordingFetch(() => refused(500));
    const error = await rejectionOf(probeWith(fetchImpl)());
    assert.equal(error.code, 'RELAY_REJECTED');
    assert.equal(error.httpStatus, 500);
    assert.equal(calls.length, 2);
  });

  it('never retries after a network error', async () => {
    const { calls, fetchImpl } = recordingFetch(() => {
      throw new TypeError('fetch failed');
    });
    const error = await rejectionOf(probeWith(fetchImpl)());
    assert.equal(error.code, 'RELAY_UNREACHABLE');
    assert.equal(calls.length, 1);
  });

  it('never retries after a timeout, because the relay may already have sent the message', async () => {
    const calls = [];
    const fetchImpl = (url, init) => {
      calls.push(url);
      return hangingFetch(url, init);
    };
    const error = await rejectionOf(probeWith(fetchImpl, { timeoutMs: SHORT_TIMEOUT_MS })());
    assert.equal(error.code, 'RELAY_TIMEOUT');
    assert.equal(calls.length, 1);
  });

  it('fails with a clear reason and makes no request when OWNER_NOTIFY_EMAIL is unset', async () => {
    const { calls, fetchImpl } = recordingFetch(() => accepted());
    const { send } = createRelayClient({ relayUrl: RELAY_URL, fetchImpl });
    const error = await rejectionOf(createRelayProbe({ send })());
    assert.equal(error.code, 'OWNER_NOTIFY_EMAIL_UNSET');
    assert.equal(calls.length, 0);
  });
});

describe('relay-send through the diagnostics service', () => {
  it('returns only allow-listed fields on success', async () => {
    const { fetchImpl } = recordingFetch(() => accepted('m-9'));
    const service = createDiagnosticsService({ probes: { 'relay-send': probeWith(fetchImpl) } });
    const { checks } = await service.run(['relay-send']);
    assert.deepEqual(Object.keys(checks[0]).sort(), ['durationMs', 'httpStatus', 'messageId', 'name', 'ok', 'replyToAccepted']);
    assert.equal(checks[0].messageId, 'm-9');
  });

  it('returns a safe reason and status on failure, with no provider text and no addresses', async () => {
    const { fetchImpl } = recordingFetch(() => refused(400));
    const service = createDiagnosticsService({ probes: { 'relay-send': probeWith(fetchImpl) } });
    const result = await service.run(['relay-send']);
    assert.deepEqual(Object.keys(result.checks[0]).sort(), ['durationMs', 'httpStatus', 'name', 'ok', 'reason']);
    assert.equal(result.checks[0].reason, 'RELAY_REJECTED');
    assert.doesNotMatch(JSON.stringify(result), new RegExp(`${SECRET_RELAY_TEXT}|owner@`));
  });
});
