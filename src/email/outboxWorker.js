import {
  MS_PER_DAY, RETENTION_DAYS, RETENTION_INTERVAL_MS, RETRY_DELAYS_SECONDS, SENDER_NAME, SUPPORT_REPLY_TO, WORKER_BATCH_SIZE,
  WORKER_INTERVAL_MS, WORKER_LEASE_SECONDS, orderPayloadSchema,
} from '../domain/emailRules.js';
import { renderEmail } from '../domain/emailTemplates.js';
import { RELAY_REFUSED, RelayError } from './relayClient.js';

const HTTP_SERVER_ERROR = 500;
const SAFE_CODE = /^[A-Z0-9_]{1,40}$/;
const CODE_SEND_FAILED = 'SEND_FAILED';
const CODE_PAYLOAD_INVALID = 'PAYLOAD_INVALID';
const CODE_RENDER_FAILED = 'RENDER_FAILED';

/** A short, safe error code. Provider text never leaves this function. */
function codeOf(error) {
  return SAFE_CODE.test(error?.code ?? '') ? error.code : CODE_SEND_FAILED;
}

/** The relay answered and refused (a 4xx, or success false): retrying cannot help, so the email is dead at once. */
function isPermanentRefusal(error) {
  return error instanceof RelayError && error.code === RELAY_REFUSED && (error.httpStatus ?? 0) < HTTP_SERVER_ERROR;
}

/** Seconds to wait after the given (already counted) attempt: 1 min, 5 min, 30 min, 2 h. The database kills the row at the 5th. */
export function retryDelaySeconds(attempts) {
  return RETRY_DELAYS_SECONDS[Math.min(Math.max(attempts, 1), RETRY_DELAYS_SECONDS.length) - 1];
}

/** Rows queued by the order functions carry no text: it is rendered here, at send time, from the payload and the language. */
function messageFor(row, baseUrl) {
  let content = row.body === '' ? null : { subject: row.subject, text: row.body };
  if (!content) {
    const facts = orderPayloadSchema.safeParse(row.payload);
    if (!facts.success) return { failure: CODE_PAYLOAD_INVALID };
    try {
      content = renderEmail({ kind: row.kind, language: row.language, facts: facts.data, baseUrl });
    } catch {
      return { failure: CODE_RENDER_FAILED };
    }
  }
  return { message: { fromName: SENDER_NAME, to: [row.toEmail], subject: content.subject, text: content.text, replyTo: row.replyTo ?? SUPPORT_REPLY_TO } };
}

/**
 * Background sender for the email outbox. Claims due rows (atomic, leased, so two workers never send the same row), sends each
 * through the relay and reports the result. Retries: 1 min, 5 min, 30 min, 2 h, dead at the 5th attempt; a relay refusal (4xx)
 * is dead at once; timeouts, network errors and 5xx retry. Also deletes finished rows and old contact messages once a day.
 * Started only by the server entry. The timer is unref'ed. Logs ids, counts and codes only, never addresses or text.
 * @param {{ outbox: object, contacts: object, relay: { send: Function }, baseUrl: string, logger: { info: Function, warn: Function },
 *   clock?: () => number, timers?: { setInterval: Function, clearInterval: Function }, intervalMs?: number }} deps
 */
export function createOutboxWorker({
  outbox, contacts, relay, baseUrl, logger, clock = Date.now, timers = { setInterval, clearInterval }, intervalMs = WORKER_INTERVAL_MS,
}) {
  let timer = null;
  let current = null;
  let rerun = false;
  let lastRetentionAt = null;

  async function sendOne(row, tally) {
    const { message, failure } = messageFor(row, baseUrl);
    if (failure) {
      await outbox.finish(row.id, { sent: false, errorCode: failure, retrySeconds: null });
      tally.dead += 1;
      return;
    }
    try {
      await relay.send(message);
      await outbox.finish(row.id, { sent: true });
      tally.sent += 1;
    } catch (error) {
      const retrySeconds = isPermanentRefusal(error) ? null : retryDelaySeconds(row.attempts);
      const status = await outbox.finish(row.id, { sent: false, errorCode: codeOf(error), retrySeconds });
      tally[status === 'dead' ? 'dead' : 'retried'] += 1;
    }
  }

  async function sendBatch() {
    const rows = await outbox.claimDue(WORKER_BATCH_SIZE, WORKER_LEASE_SECONDS);
    const tally = { claimed: rows.length, sent: 0, retried: 0, dead: 0 };
    for (const row of rows) {
      try {
        await sendOne(row, tally);
      } catch (error) {
        logger.warn('email worker row failed', { emailId: row.id, code: error?.code });
      }
    }
    if (tally.claimed > 0) logger.info('email worker run', tally);
  }

  async function purgeOld() {
    const now = clock();
    if (lastRetentionAt !== null && now - lastRetentionAt < RETENTION_INTERVAL_MS) return;
    lastRetentionAt = now;
    const cutoff = new Date(now - RETENTION_DAYS * MS_PER_DAY).toISOString();
    const removed = { emails: await outbox.deleteFinishedBefore(cutoff), contacts: await contacts.deleteBefore(cutoff) };
    if (removed.emails + removed.contacts > 0) logger.info('email retention run', removed);
  }

  async function runOnce() {
    try {
      await sendBatch();
      await purgeOld();
    } catch (error) {
      logger.warn('email worker failed', { code: error?.code });
    }
  }

  function run() {
    if (current) {
      rerun = true;
      return current;
    }
    current = runOnce().finally(() => {
      current = null;
      if (rerun) {
        rerun = false;
        run();
      }
    });
    return current;
  }

  return {
    /** Processes one batch now (and the daily cleanup when due). Never throws. @returns {Promise<void>} */
    runOnce: run,
    /** Wakes the worker after an enqueue; it never blocks the caller. */
    kick() {
      if (timer) setImmediate(run);
    },
    /** Starts the interval. Safe to call twice. */
    start() {
      if (timer) return;
      timer = timers.setInterval(run, intervalMs);
      timer.unref?.();
      run();
    },
    /** Stops the interval and waits for a run in progress. @returns {Promise<void>} */
    async stop() {
      if (timer) timers.clearInterval(timer);
      timer = null;
      rerun = false;
      await current;
    },
  };
}
