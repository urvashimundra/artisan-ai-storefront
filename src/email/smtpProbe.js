import nodemailer from 'nodemailer';
import { withTimeout } from '../lib/timeout.js';

export const SMTP_TIMEOUT_MS = 10000;
const SMTPS_PORT = 465;
const TEST_SUBJECT = 'Artisan AI SMTP connectivity test';
const TEST_BODY = 'One-off connectivity test from the Artisan AI smoke script. No action needed.';

const MAX_MESSAGE_CHARS = 200;
const SAFE_TOKEN = /^[A-Za-z0-9_.:-]{1,255}$/;
const REDACTED = '[redacted]';

function base64(text) {
  return Buffer.from(text, 'utf8').toString('base64');
}

function secretForms({ user, pass }) {
  const values = [user, pass].filter((value) => typeof value === 'string' && value.length > 0);
  const combined = values.length === 2 ? [base64(`\0${user}\0${pass}`)] : [];
  return [...combined, ...values.map(base64), ...values];
}

/**
 * First line of an error message with configured credentials (plain and base64) removed, length capped.
 * @param {unknown} message
 * @param {{ user?: string, pass?: string }} config
 * @returns {string}
 */
export function redactFirstLine(message, config) {
  const firstLine = String(message ?? '').split(/\r?\n/)[0];
  const scrubbed = secretForms(config).reduce((text, secret) => text.split(secret).join(REDACTED), firstLine);
  return scrubbed.slice(0, MAX_MESSAGE_CHARS);
}

function safeToken(value) {
  return typeof value === 'string' && SAFE_TOKEN.test(value) ? value : undefined;
}

function safeNumber(value) {
  return Number.isInteger(value) ? value : undefined;
}

/**
 * Non-secret facts about an SMTP failure, safe to return from the diagnostics endpoint.
 * @param {any} error
 * @param {{ port: number, user?: string, pass?: string }} config
 * @returns {object}
 */
export function describeSmtpFailure(error, config) {
  return {
    code: safeToken(error?.code),
    errno: safeNumber(error?.errno) ?? safeToken(error?.errno),
    syscall: safeToken(error?.syscall),
    address: safeToken(error?.address),
    port: safeNumber(error?.port) ?? config.port,
    secure: config.port === SMTPS_PORT,
    message: redactFirstLine(error?.message, config),
  };
}

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
    } catch (error) {
      throw Object.assign(error, { safeDetail: describeSmtpFailure(error, config) });
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
