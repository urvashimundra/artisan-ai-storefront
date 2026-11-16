import { isIP } from 'node:net';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };
const LOG_METHODS = ['debug', 'info', 'warn', 'error'];
const REDACTED = '[REDACTED]';
const REDACTED_PHONE = '[REDACTED_PHONE]';
const TRUNCATED = '[TRUNCATED]';
const MAX_DEPTH = 6;
const SENSITIVE_KEY =
  /password|passwd|token|authorization|api[-_]?key|secret|cookie|phone|mobile|customer[-_]?message|^message$|^body$|utr|address|customer[-_]?name|upi|vpa/i;
const PHONE_IN_TEXT = /\+?\d[\d\s().-]{8,}\d/g;
const BEARER_IN_TEXT = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;
const WA_LINK_IN_TEXT = /https?:\/\/(?:wa\.me|api\.whatsapp\.com)\/\S*/gi;
const STATUS_TOKEN_IN_PATH = /\/o\/[A-Za-z0-9_-]{43}/g;
const REDACTED_LINK = '[REDACTED_LINK]';

const WHOLE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function scrubString(text) {
  if (WHOLE_UUID.test(text) || isIP(text) !== 0) return text;
  return text
    .replace(WA_LINK_IN_TEXT, REDACTED_LINK)
    .replace(STATUS_TOKEN_IN_PATH, `/o/${REDACTED}`)
    .replace(BEARER_IN_TEXT, `Bearer ${REDACTED}`)
    .replace(PHONE_IN_TEXT, REDACTED_PHONE);
}

function sanitizeError(error) {
  return {
    name: error.name,
    code: error.code,
    message: scrubString(String(error.message)),
    stack: error.stack ? scrubString(error.stack) : undefined,
  };
}

function sanitizeObject(object, depth, seen) {
  const result = {};
  for (const [key, entry] of Object.entries(object)) {
    result[key] = SENSITIVE_KEY.test(key) ? REDACTED : sanitizeValue(entry, depth + 1, seen);
  }
  return result;
}

function sanitizeValue(value, depth, seen) {
  if (typeof value === 'string') return scrubString(value);
  if (value instanceof Error) return sanitizeError(value);
  if (value === null || typeof value !== 'object') return value;
  if (depth >= MAX_DEPTH || seen.has(value)) return TRUNCATED;
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => sanitizeValue(item, depth + 1, seen));
  return sanitizeObject(value, depth, seen);
}

/**
 * Redacts secrets and personal data from a log context object.
 * @param {Record<string, unknown>} context
 * @returns {Record<string, unknown>}
 */
export function redact(context) {
  return sanitizeObject(context, 0, new WeakSet());
}

function defaultWrite(line) {
  process.stdout.write(`${line}\n`);
}

/**
 * Creates a structured JSON logger that writes one JSON object per line.
 * @param {{ level?: keyof typeof LEVELS, write?: (line: string) => void, bindings?: Record<string, unknown> }} [options]
 */
export function createLogger({ level = 'info', write = defaultWrite, bindings = {} } = {}) {
  const threshold = LEVELS[level] ?? LEVELS.info;
  const emit = (name, msg, context = {}) => {
    if (LEVELS[name] < threshold) return;
    const entry = { time: new Date().toISOString(), level: name, msg, ...redact({ ...bindings, ...context }) };
    write(JSON.stringify(entry));
  };
  const logger = {
    child: (extra) => createLogger({ level, write, bindings: { ...bindings, ...extra } }),
  };
  for (const name of LOG_METHODS) {
    logger[name] = (msg, context) => emit(name, msg, context);
  }
  return logger;
}
