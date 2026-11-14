import { createClaudeProbe } from './ai/claudeProbe.js';
import { createSmtpProbe } from './email/smtpProbe.js';
import { createSupabaseProbe } from './repositories/supabaseProbe.js';
import { createDiagnosticsService } from './services/diagnosticsService.js';

/**
 * Wires real integrations from validated config. Only configured groups get a probe.
 * @param {ReturnType<import('./config/env.js').loadEnv>} config
 * @returns {{ diagnostics: ReturnType<typeof createDiagnosticsService>, sendTestEmail: (() => Promise<void>) | undefined }}
 */
export function buildDependencies(config) {
  const smtp = config.smtp && createSmtpProbe({ config: config.smtp });
  const probes = {
    supabase: config.supabase && createSupabaseProbe({ config: config.supabase }),
    claude: config.ai && createClaudeProbe({ config: config.ai }),
    'smtp-verify': smtp?.verify,
  };
  return { diagnostics: createDiagnosticsService({ probes }), sendTestEmail: smtp?.sendTest };
}
