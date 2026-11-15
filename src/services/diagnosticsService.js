export const CHECK_NAMES = ['supabase', 'smtp-verify', 'claude'];
export const DEFAULT_CHECKS = ['supabase', 'smtp-verify'];

const SAFE_REASON = /^[A-Za-z0-9_]{1,40}$/;
const GENERIC_REASON = 'Error';

function safeReason(error) {
  const candidates = [error?.code, error?.name];
  return candidates.find((value) => typeof value === 'string' && SAFE_REASON.test(value)) ?? GENERIC_REASON;
}

async function runOne(name, probe) {
  if (!probe) return { name, ok: false, durationMs: 0, reason: 'not_configured' };
  const startedAt = performance.now();
  try {
    await probe();
    return { name, ok: true, durationMs: Math.round(performance.now() - startedAt) };
  } catch (error) {
    return { name, ok: false, durationMs: Math.round(performance.now() - startedAt), reason: safeReason(error) };
  }
}

/**
 * Runs connectivity checks. Results contain only a check name, outcome, duration and a safe reason
 * (error code or class name); provider messages and bodies are never included.
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
