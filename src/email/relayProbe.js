import { ProbeError } from '../lib/probeError.js';
import { RELAY_REFUSED, RelayError } from './relayClient.js';

const RELAY_TEST_FROM_NAME = 'The Artisan Story';
const RELAY_TEST_SUBJECT = 'Relay test';
const RELAY_TEST_TEXT = 'Relay connectivity test from The Artisan Story. No action needed.';
const OWNER_NOTIFY_UNSET = 'OWNER_NOTIFY_EMAIL_UNSET';

/** True only when the relay answered and refused the message. Network errors and timeouts are not refusals. */
function isRelayRefusal(error) {
  return error instanceof RelayError && error.code === RELAY_REFUSED;
}

/**
 * Sends ONE plain-text test email to the owner through the relay. The first attempt sets replyTo to the owner
 * address. Only an explicit relay refusal triggers one retry without replyTo, and the result says which worked.
 * Network errors and timeouts are never retried, because the relay may already have sent the message.
 * @param {{ send: (message: object) => Promise<{ messageId?: string, httpStatus: number }>, ownerNotifyEmail?: string }} deps
 * @returns {() => Promise<{ messageId?: string, httpStatus: number, replyToAccepted: boolean }>}
 */
export function createRelayProbe({ send, ownerNotifyEmail }) {
  return async function checkRelaySend() {
    if (!ownerNotifyEmail) throw new ProbeError(OWNER_NOTIFY_UNSET);
    const message = {
      fromName: RELAY_TEST_FROM_NAME,
      to: [ownerNotifyEmail],
      subject: RELAY_TEST_SUBJECT,
      text: RELAY_TEST_TEXT,
    };
    try {
      return { ...(await send({ ...message, replyTo: ownerNotifyEmail })), replyToAccepted: true };
    } catch (error) {
      if (!isRelayRefusal(error)) throw error;
      return { ...(await send(message)), replyToAccepted: false };
    }
  };
}
