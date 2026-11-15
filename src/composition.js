import { createClaudeProbe } from './ai/claudeProbe.js';
import { createSmtpProbe } from './email/smtpProbe.js';
import { createPasswordService } from './lib/password.js';
import { createOwnerRepository } from './repositories/ownerRepository.js';
import { createSessionRepository } from './repositories/sessionRepository.js';
import { createStoreRepository } from './repositories/storeRepository.js';
import { createSupabaseClient } from './repositories/supabaseClient.js';
import { createSupabaseProbe } from './repositories/supabaseProbe.js';
import { createAuthService } from './services/authService.js';
import { createDiagnosticsService } from './services/diagnosticsService.js';
import { createSessionService } from './services/sessionService.js';
import { createStoreService } from './services/storeService.js';

/**
 * Wires real integrations from validated config. Only configured optional groups get a probe.
 * Async because the password service computes its dummy hash once at startup; the server must await this
 * before it accepts requests.
 * @param {ReturnType<import('./config/env.js').loadEnv>} config
 * @returns {Promise<{ diagnostics: ReturnType<typeof createDiagnosticsService>,
 *   sendTestEmail: (() => Promise<void>) | undefined,
 *   services: { auth: ReturnType<typeof createAuthService>, sessions: ReturnType<typeof createSessionService>,
 *     stores: ReturnType<typeof createStoreService> } }>}
 */
export async function buildDependencies(config) {
  const smtp = config.smtp && createSmtpProbe({ config: config.smtp });
  const probes = {
    supabase: createSupabaseProbe({ config: config.supabase }),
    claude: config.ai && createClaudeProbe({ config: config.ai }),
    'smtp-verify': smtp?.verify,
  };
  const client = createSupabaseClient(config.supabase);
  const owners = createOwnerRepository({ client });
  const sessions = createSessionService({ sessions: createSessionRepository({ client }), owners });
  const passwords = await createPasswordService();
  const services = {
    auth: createAuthService({ owners, passwords, sessions, inviteCode: config.signupInviteCode }),
    sessions,
    stores: createStoreService({ stores: createStoreRepository({ client }) }),
  };
  return { diagnostics: createDiagnosticsService({ probes }), sendTestEmail: smtp?.sendTest, services };
}
