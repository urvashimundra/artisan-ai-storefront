import { z } from 'zod';
import { ProbeError } from '../lib/probeError.js';

export const RELAY_TIMEOUT_MS = 10_000;
export const RELAY_REFUSED = 'RELAY_REJECTED';
const RELAY_SEND_PATH = '/api/email/send';
const HTTP_STATUS_OK_MIN = 200;
const HTTP_STATUS_OK_MAX = 299;
const SAFE_MESSAGE_ID = /^[A-Za-z0-9@._<>-]{1,200}$/;
const TIMEOUT_ERROR_NAMES = ['TimeoutError', 'AbortError'];
const replySchema = z.object({ success: z.boolean(), messageId: z.unknown().optional() });

/** A failed relay call. Carries a safe code and, when the relay answered, its HTTP status. Never the body. */
export class RelayError extends ProbeError {
  /**
   * @param {string} code RELAY_REJECTED, RELAY_RESPONSE_INVALID, RELAY_TIMEOUT or RELAY_UNREACHABLE.
   * @param {number} [httpStatus] Status of the response the relay sent, if any.
   */
  constructor(code, httpStatus) {
    super(code);
    this.name = 'RelayError';
    this.httpStatus = httpStatus;
  }
}

/** Maps a fetch failure to a safe code. Nothing from the thrown error is kept. */
function toTransportError(error) {
  return new RelayError(TIMEOUT_ERROR_NAMES.includes(error?.name) ? 'RELAY_TIMEOUT' : 'RELAY_UNREACHABLE');
}

/** Sends one POST bounded by an AbortSignal. Returns the status and body text, or throws a RelayError. */
async function postJson(fetchImpl, endpoint, payload, timeoutMs) {
  try {
    const response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    });
    return { status: response.status, text: await response.text() };
  } catch (error) {
    throw toTransportError(error);
  }
}

/** @returns {{ success: boolean, messageId?: unknown } | null} The parsed reply, or null when it is not JSON of that shape. */
function parseReply(text) {
  try {
    const result = replySchema.safeParse(JSON.parse(text));
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

/** Keeps the message id only if it has a short, plain shape. */
function safeMessageId(value) {
  return typeof value === 'string' && SAFE_MESSAGE_ID.test(value) ? value : undefined;
}

/**
 * Turns a relay response into a result. A reply that is not the expected JSON is invalid; a 2xx reply with
 * success true is accepted; anything else is a refusal.
 * @returns {{ messageId: string | undefined, httpStatus: number }}
 */
function interpretResponse(status, text) {
  const reply = parseReply(text);
  if (!reply) throw new RelayError('RELAY_RESPONSE_INVALID', status);
  const accepted = status >= HTTP_STATUS_OK_MIN && status <= HTTP_STATUS_OK_MAX && reply.success === true;
  if (!accepted) throw new RelayError(RELAY_REFUSED, status);
  return { messageId: safeMessageId(reply.messageId), httpStatus: status };
}

/**
 * Client for the GoDaddy hosting mail relay. Plain fetch, no dependency. Each `send` makes one POST, bounded by
 * `timeoutMs`, and never retries. Provider text is never returned or thrown.
 * @param {{ relayUrl: string, fetchImpl?: typeof fetch, timeoutMs?: number }} deps relayUrl is a validated loopback origin.
 * @returns {{ send: (message: { fromName: string, to: string[], subject: string, text: string, replyTo?: string }) =>
 *   Promise<{ messageId: string | undefined, httpStatus: number }> }}
 */
export function createRelayClient({ relayUrl, fetchImpl = globalThis.fetch, timeoutMs = RELAY_TIMEOUT_MS }) {
  const endpoint = new URL(RELAY_SEND_PATH, relayUrl).href;
  return {
    async send(message) {
      const { status, text } = await postJson(fetchImpl, endpoint, message, timeoutMs);
      return interpretResponse(status, text);
    },
  };
}
