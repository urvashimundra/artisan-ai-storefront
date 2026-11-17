// Local connectivity smoke test. Run by the developer, never by tests or CI:
//   node --env-file=.env scripts/smoke.js
// Prints pass/fail per check with no secrets. It never sends email.
import { buildDependencies } from '../src/composition.js';
import { EnvValidationError, loadEnv } from '../src/config/env.js';

const SMOKE_CHECKS = ['supabase', 'claude'];

function printCheck({ name, ok, durationMs, reason }) {
  const detail = ok ? `${durationMs} ms` : reason;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  (${detail})`);
}

async function main() {
  const config = loadEnv();
  const { diagnostics } = await buildDependencies(config);
  const { ok, checks } = await diagnostics.run(SMOKE_CHECKS);
  checks.forEach(printCheck);
  process.exitCode = ok ? 0 : 1;
}

main().catch((error) => {
  console.error(error instanceof EnvValidationError ? error.message : 'Smoke test crashed');
  process.exitCode = 1;
});
