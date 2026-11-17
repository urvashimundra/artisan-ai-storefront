import { createBulkRuleExtractor } from './ai/bulkRuleExtractor.js';
import { createEnquiryAgent } from './ai/enquiryAgent.js';
import { createClaudeProbe } from './ai/claudeProbe.js';
import { createListingGenerator } from './ai/listingGenerator.js';
import { createTranslationGenerator } from './ai/translationGenerator.js';
import { createEmailService } from './email/emailService.js';
import { createOutboxWorker } from './email/outboxWorker.js';
import { createRelayClient } from './email/relayClient.js';
import { createRelayProbe } from './email/relayProbe.js';
import { createLinkCipher } from './lib/linkCipher.js';
import { createLogger } from './lib/logger.js';
import { createPasswordService } from './lib/password.js';
import { createAiBudgetRepository } from './repositories/aiBudgetRepository.js';
import { createContactRepository } from './repositories/contactRepository.js';
import { createEmailOutboxRepository } from './repositories/emailOutboxRepository.js';
import { createKnowledgeRepository } from './repositories/knowledgeRepository.js';
import { createEnquiryRepository } from './repositories/enquiryRepository.js';
import { createImageStorageRepository } from './repositories/imageStorageRepository.js';
import { createProductRepository } from './repositories/productRepository.js';
import { createPublicShopRepository } from './repositories/publicShopRepository.js';
import { createOrderRepository } from './repositories/orderRepository.js';
import { createOwnerRepository } from './repositories/ownerRepository.js';
import { createSessionRepository } from './repositories/sessionRepository.js';
import { createStoreRepository } from './repositories/storeRepository.js';
import { createStoreTranslationRepository } from './repositories/storeTranslationRepository.js';
import { SUPABASE_STORAGE_TIMEOUT_MS, createSupabaseClient } from './repositories/supabaseClient.js';
import { createSupabaseProbe } from './repositories/supabaseProbe.js';
import { createAiBudgetService } from './services/aiBudgetService.js';
import { createAssistantService } from './services/assistantService.js';
import { createAuthService } from './services/authService.js';
import { createDiagnosticsService } from './services/diagnosticsService.js';
import { createContactService } from './services/contactService.js';
import { createEnquiryInboxService } from './services/enquiryInboxService.js';
import { createKnowledgeService } from './services/knowledgeService.js';
import { createListingService } from './services/listingService.js';
import { createOrderService } from './services/orderService.js';
import { createProductService } from './services/productService.js';
import { createPublicShopService } from './services/publicShopService.js';
import { createSessionService } from './services/sessionService.js';
import { createStoreService } from './services/storeService.js';
import { createStoreTranslationService } from './services/storeTranslationService.js';
import { createTranslationDraftService } from './services/translationDraftService.js';

/** The database-backed three-limit AI budget guard, shared by every AI workflow. */
function buildBudgets({ config, client }) {
  const limits = {
    ownerMicroUsd: config.aiBudget.ownerDailyMicroUsd,
    demoMicroUsd: config.aiBudget.demoDailyMicroUsd,
    globalMicroUsd: config.aiBudget.globalDailyMicroUsd,
  };
  return createAiBudgetService({ budgets: createAiBudgetRepository({ client }), limits });
}

/**
 * Translated shop text: owner editing always; the Claude drafting service only when the ai group is configured.
 */
function buildTranslationServices({ config, client, logger, translations }) {
  const services = { translations: createStoreTranslationService({ translations }) };
  if (!config.ai) return services;
  const budgets = buildBudgets({ config, client });
  const generator = createTranslationGenerator({ config: config.ai });
  return { ...services, translationDrafts: createTranslationDraftService({ translations, budgets, generator, logger }) };
}

/**
 * Product and AI listing services. The listing service exists only when the ai group is configured; without it
 * the product routes are not mounted.
 */
function buildProductServices({ config, client, logger }) {
  if (!config.ai) return {};
  const storageClient = createSupabaseClient(config.supabase, undefined, SUPABASE_STORAGE_TIMEOUT_MS);
  const products = createProductRepository({ client });
  const images = createImageStorageRepository({ client: storageClient });
  const budgets = buildBudgets({ config, client });
  const generator = createListingGenerator({ config: config.ai });
  return {
    products: createProductService({ products, images, logger }),
    listings: createListingService({ products, images, budgets, generator, logger }),
  };
}

/** Shop notes and bulk discounts: owner editing always; the Claude discount search only when the ai group is configured. */
function buildKnowledgeService({ config, client, logger }) {
  const knowledge = createKnowledgeRepository({ client });
  if (!config.ai) return createKnowledgeService({ knowledge, logger });
  const budgets = buildBudgets({ config, client });
  return createKnowledgeService({ knowledge, budgets, extractor: createBulkRuleExtractor({ config: config.ai }), logger });
}

/** Public storefront read path: its own repository and a storage client with the storage timeout (signed URLs only). */
function buildPublicShopService({ config, client, logger }) {
  const storageClient = createSupabaseClient(config.supabase, undefined, SUPABASE_STORAGE_TIMEOUT_MS);
  return createPublicShopService({
    shops: createPublicShopRepository({ client }),
    images: createImageStorageRepository({ client: storageClient }),
    logger,
    baseUrl: config.baseUrl,
  });
}

/** Orders and manual UPI payment: database functions plus the public read repository for prices and titles. */
function buildOrderService({ client, logger, linkCipher, kick }) {
  return createOrderService({ orders: createOrderRepository({ client }), shops: createPublicShopRepository({ client }), logger, linkCipher, kick });
}

/**
 * The shop assistant (ask the seller): enquiries are always saved and reach the seller's inbox; the Claude agent exists only when the
 * ai group is configured (without it every enquiry goes straight to the seller).
 */
function buildAssistantService({ config, client, logger, linkCipher, emails }) {
  const aiParts = config.ai ? { agent: createEnquiryAgent({ config: config.ai }), budgets: buildBudgets({ config, client }) } : {};
  return createAssistantService({
    shops: createPublicShopRepository({ client }),
    enquiries: createEnquiryRepository({ client }),
    knowledge: createKnowledgeRepository({ client }),
    emails, logger, linkCipher, baseUrl: config.baseUrl, ...aiParts,
  });
}

/**
 * The email outbox: the enqueue API for emails the app queues itself, and the background worker (created here, started only by
 * the server entry). Order emails are queued by the order database functions, not by this service.
 */
function buildEmail({ config, client, logger, owners, relay, linkCipher }) {
  const outbox = createEmailOutboxRepository({ client });
  const contacts = createContactRepository({ client });
  const worker = createOutboxWorker({ outbox, contacts, relay, baseUrl: config.baseUrl, logger, linkCipher });
  const emails = createEmailService({ outbox, owners, logger, baseUrl: config.baseUrl, kick: worker.kick });
  return { emails, contacts, worker };
}

/**
 * Wires real integrations from validated config. Only configured optional groups get a probe.
 * Async because the password service computes its dummy hash once at startup; the server must await this
 * before it accepts requests.
 * @param {ReturnType<import('./config/env.js').loadEnv>} config
 * @returns {Promise<{ diagnostics: ReturnType<typeof createDiagnosticsService>,
 *   emailWorker: { start: Function, stop: Function } | null,
 *   services: { auth: ReturnType<typeof createAuthService>, sessions: ReturnType<typeof createSessionService>,
 *     stores: ReturnType<typeof createStoreService> } }>}
 */
export async function buildDependencies(config) {
  const relay = createRelayClient({ relayUrl: config.emailRelayUrl });
  const probes = {
    supabase: createSupabaseProbe({ config: config.supabase }),
    claude: config.ai && createClaudeProbe({ config: config.ai }),
    'relay-send': createRelayProbe({ send: relay.send, ownerNotifyEmail: config.ownerNotifyEmail }),
  };
  const client = createSupabaseClient(config.supabase);
  const owners = createOwnerRepository({ client });
  const sessions = createSessionService({ sessions: createSessionRepository({ client }), owners });
  const passwords = await createPasswordService();
  const logger = createLogger({ level: config.nodeEnv === 'test' ? 'silent' : 'info' });
  const linkCipher = config.orderLinkKey ? createLinkCipher(config.orderLinkKey) : null;
  const email = buildEmail({ config, client, logger, owners, relay, linkCipher });
  const translations = createStoreTranslationRepository({ client });
  const stores = createStoreService({ stores: createStoreRepository({ client }), translations });
  const services = {
    auth: createAuthService({ owners, passwords, sessions, inviteCode: config.signupInviteCode }),
    sessions,
    stores,
    publicShop: buildPublicShopService({ config, client, logger }),
    orders: buildOrderService({ client, logger, linkCipher, kick: email.worker.kick }),
    emails: email.emails,
    contact: createContactService({
      contacts: email.contacts,
      emails: email.emails,
      inboxEmail: config.contactInboxEmail ?? config.ownerNotifyEmail ?? null,
      logger,
    }),
    knowledge: buildKnowledgeService({ config, client, logger }),
    enquiries: createEnquiryInboxService({ enquiries: createEnquiryRepository({ client }), logger, linkCipher, baseUrl: config.baseUrl }),
    assistant: buildAssistantService({ config, client, logger, linkCipher, emails: email.emails }),
    ...buildTranslationServices({ config, client, logger, translations }),
    ...buildProductServices({ config, client, logger }),
  };
  const emailWorker = config.emailWorkerEnabled ? email.worker : null;
  return { diagnostics: createDiagnosticsService({ probes }), services, emailWorker };
}
