export const CHECK_NAMES = ['supabase', 'smtp-verify', 'claude', 'relay-send'];
export const DEFAULT_CHECKS = ['supabase', 'smtp-verify'];

const SAFE_REASON = /^[A-Za-z0-9_]{1,40}$/;
const GENERIC_REASON = 'Error';
const MAX_MESSAGE_ID_LENGTH = 200;
const MIN_HTTP_STATUS = 100;
const MAX_HTTP_STATUS = 599;

/** The only detail fields a probe result or error may add to a check, each with its type and range check. */
const DETAIL_RULES = {
  messageId: (value) => typeof value === 'string' && value.length > 0 && value.length <= MAX_MESSAGE_ID_LENGTH,
  replyToAccepted: (value) => typeof value === 'boolean',
  httpStatus: (value) => Number.isInteger(value) && value >= MIN_HTTP_STATUS && value <= MAX_HTTP_STATUS,
};

function safeReason(error) {
  const candidates = [error?.code, error?.name];
  return candidates.find((value) => typeof value === 'string' && SAFE_REASON.test(value)) ?? GENERIC_REASON;
}

/** Copies only allow-listed fields that pass their type check. Everything else is dropped. */
function pickDetails(source) {
  if (!source || typeof source !== 'object') return {};
  const entries = Object.entries(DETAIL_RULES)
    .filter(([key, isValid]) => isValid(source[key]))
    .map(([key]) => [key, source[key]]);
  return Object.fromEntries(entries);
}

async function runOne(name, probe) {
  if (!probe) return { name, ok: false, durationMs: 0, reason: 'not_configured' };
  const startedAt = performance.now();
  try {
    const result = await probe();
    return { name, ok: true, durationMs: Math.round(performance.now() - startedAt), ...pickDetails(result) };
  } catch (error) {
    const durationMs = Math.round(performance.now() - startedAt);
    return { name, ok: false, durationMs, reason: safeReason(error), ...pickDetails(error) };
  }
}

/**
 * Runs connectivity checks. Results contain only a check name, outcome, duration and a safe reason
 * (error code or class name), plus allow-listed, type-checked details (messageId, replyToAccepted, httpStatus).
 * Provider messages and bodies are never included.
 * @param {{ probes: Partial<Record<string, () => Promise<void>>> }} deps
 * @returns {{ run: (names?: string[]) => Promise<{ ok: boolean, checks: object[] }> }}
 */
export function createDiagnosticsService({ probes }) {
  return {
    async run(names = DEFAULT_CHECKS) {
      const checks = await Promise.all(names.map((name) => runOne(name, probes[name])));
      return { ok: checks.every((check) => check.ok), checks };
    },
  };
}
