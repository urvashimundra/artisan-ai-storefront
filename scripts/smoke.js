// Local connectivity smoke test. Run by the developer, never by tests or CI:
//   node --env-file=.env scripts/smoke.js [--send-test]
// Prints pass/fail per check with no secrets. Only --send-test sends (one) email.
import { buildDependencies } from '../src/composition.js';
import { EnvValidationError, loadEnv } from '../src/config/env.js';

const SEND_TEST_FLAG = '--send-test';
const SMOKE_CHECKS = ['supabase', 'smtp-verify', 'claude'];

function printCheck({ name, ok, durationMs, reason }) {
  const detail = ok ? `${durationMs} ms` : reason;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  (${detail})`);
}

async function sendTest(sendTestEmail) {
  if (!sendTestEmail) {
    console.log('FAIL  smtp-send-test  (not_configured)');
    return false;
  }
  try {
    await sendTestEmail();
    console.log('PASS  smtp-send-test  (one email sent to OWNER_NOTIFY_EMAIL)');
    return true;
  } catch (error) {
    console.log(`FAIL  smtp-send-test  (${error?.code ?? error?.name ?? 'Error'})`);
    return false;
  }
}

async function main() {
  const config = loadEnv();
  const { diagnostics, sendTestEmail } = await buildDependencies(config);
  const { ok, checks } = await diagnostics.run(SMOKE_CHECKS);
  checks.forEach(printCheck);
  const sendOk = process.argv.includes(SEND_TEST_FLAG) ? await sendTest(sendTestEmail) : true;
  process.exitCode = ok && sendOk ? 0 : 1;
}

main().catch((error) => {
  console.error(error instanceof EnvValidationError ? error.message : 'Smoke test crashed');
  process.exitCode = 1;
});
