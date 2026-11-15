import { createClaudeProbe } from './ai/claudeProbe.js';
import { createListingGenerator } from './ai/listingGenerator.js';
import { createSmtpProbe } from './email/smtpProbe.js';
import { createLogger } from './lib/logger.js';
import { createPasswordService } from './lib/password.js';
import { createAiBudgetRepository } from './repositories/aiBudgetRepository.js';
import { createImageStorageRepository } from './repositories/imageStorageRepository.js';
import { createProductRepository } from './repositories/productRepository.js';
import { createOwnerRepository } from './repositories/ownerRepository.js';
import { createSessionRepository } from './repositories/sessionRepository.js';
import { createStoreRepository } from './repositories/storeRepository.js';
import { SUPABASE_STORAGE_TIMEOUT_MS, createSupabaseClient } from './repositories/supabaseClient.js';
import { createSupabaseProbe } from './repositories/supabaseProbe.js';
import { createAiBudgetService } from './services/aiBudgetService.js';
import { createAuthService } from './services/authService.js';
import { createDiagnosticsService } from './services/diagnosticsService.js';
import { createListingService } from './services/listingService.js';
import { createProductService } from './services/productService.js';
import { createSessionService } from './services/sessionService.js';
import { createStoreService } from './services/storeService.js';

/**
 * Product and AI listing services. The listing service exists only when the ai group is configured; without it
 * the product routes are not mounted.
 */
function buildProductServices({ config, client, logger }) {
  if (!config.ai) return {};
  const storageClient = createSupabaseClient(config.supabase, undefined, SUPABASE_STORAGE_TIMEOUT_MS);
  const products = createProductRepository({ client });
  const images = createImageStorageRepository({ client: storageClient });
  const limits = {
    ownerMicroUsd: config.aiBudget.ownerDailyMicroUsd,
    demoMicroUsd: config.aiBudget.demoDailyMicroUsd,
    globalMicroUsd: config.aiBudget.globalDailyMicroUsd,
  };
  const budgets = createAiBudgetService({ budgets: createAiBudgetRepository({ client }), limits });
  const generator = createListingGenerator({ config: config.ai });
  return {
    products: createProductService({ products, images, logger }),
    listings: createListingService({ products, images, budgets, generator, logger }),
  };
}

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
  const logger = createLogger({ level: config.nodeEnv === 'test' ? 'silent' : 'info' });
  const stores = createStoreService({ stores: createStoreRepository({ client }) });
  const services = {
    auth: createAuthService({ owners, passwords, sessions, inviteCode: config.signupInviteCode }),
    sessions,
    stores,
    ...buildProductServices({ config, client, logger }),
  };
  return { diagnostics: createDiagnosticsService({ probes }), sendTestEmail: smtp?.sendTest, services };
}
