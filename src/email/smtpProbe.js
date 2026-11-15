import nodemailer from 'nodemailer';
import { withTimeout } from '../lib/timeout.js';

export const SMTP_TIMEOUT_MS = 10000;
const SMTPS_PORT = 465;
const TEST_SUBJECT = 'Artisan AI SMTP connectivity test';
const TEST_BODY = 'One-off connectivity test from the Artisan AI smoke script. No action needed.';

function buildTransport(createTransport, config) {
  return createTransport({
    host: config.host,
    port: config.port,
    secure: config.port === SMTPS_PORT,
    requireTLS: config.port !== SMTPS_PORT,
    auth: { user: config.user, pass: config.pass },
    connectionTimeout: SMTP_TIMEOUT_MS,
    greetingTimeout: SMTP_TIMEOUT_MS,
    socketTimeout: SMTP_TIMEOUT_MS,
  });
}

/**
 * SMTP probes. `verify` only connects and authenticates; `sendTest` sends exactly one email.
 * @param {{ config: object, createTransport?: Function }} deps
 * @returns {{ verify: () => Promise<void>, sendTest: () => Promise<void> }}
 */
export function createSmtpProbe({ config, createTransport = nodemailer.createTransport }) {
  const run = async (label, action) => {
    const transport = buildTransport(createTransport, config);
    try {
      await withTimeout(() => action(transport), SMTP_TIMEOUT_MS, label);
    } finally {
      transport.close();
    }
  };
  return {
    verify: () => run('smtp-verify', (transport) => transport.verify()),
    sendTest: () =>
      run('smtp-send-test', (transport) =>
        transport.sendMail({
          from: config.from,
          to: config.ownerNotifyEmail,
          subject: TEST_SUBJECT,
          text: TEST_BODY,
        }),
      ),
  };
}
