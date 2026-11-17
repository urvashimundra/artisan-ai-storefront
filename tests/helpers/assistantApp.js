import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createEnquiryAgent } from '../../src/ai/enquiryAgent.js';
import { ENQUIRY_STATUS } from '../../src/domain/enquiryRules.js';
import { createEmailService } from '../../src/email/emailService.js';
import { createLinkCipher } from '../../src/lib/linkCipher.js';
import { generateStatusToken, hashStatusToken } from '../../src/lib/statusToken.js';
import { normalizeWhatsappNumber } from '../../src/domain/whatsapp.js';
import { requireStoreId } from '../../src/repositories/requireStoreId.js';
import { createAssistantService } from '../../src/services/assistantService.js';
import { createConversationInboxService } from '../../src/services/conversationInboxService.js';
import { createConversationService } from '../../src/services/conversationService.js';
import { answered, createFakeAgent, createFakeConversationRepo } from './conversationFakes.js';
import { createEnquiryInboxService } from '../../src/services/enquiryInboxService.js';
import { createKnowledgeService } from '../../src/services/knowledgeService.js';
import { STORE_FORM, signupAndLogin } from './appHarness.js';
import { createFakeBudgets, createFakeKnowledgeRepo } from './assistantFakes.js';
import { createFakeOutbox } from './emailFakes.js';
import { createLogCollector } from './productFakes.js';
import { createFakePublicRepo, startPublicApp, translation } from './publicFakes.js';

export const TEST_LINK_KEY = 'B'.repeat(43);
export const ASK = { name: 'Asha Patel', phone: '98765 43210', question: 'Do you ship to Pune?' };
const iso = (ms) => new Date(ms).toISOString();

/** In-memory enquiry repository with the real one's interface and rules (compare-and-set updates, store scoping, token hash lookup). */
export function createFakeEnquiryRepo({ clock, ownerContextOf }) {
  const rows = [];
  const calls = [];
  const inStore = (storeId) => rows.filter((row) => row.storeId === requireStoreId(storeId));
  const view = (row, withEnc = false) => {
    const { tokenHash: _hash, tokenEnc, ...rest } = structuredClone(row);
    return { ...rest, tokenEnc: withEnc ? tokenEnc : null };
  };
  const cas = (storeId, id, allowed, change) => {
    const row = inStore(storeId).find((candidate) => candidate.id === id && allowed(candidate));
    if (!row) return false;
    Object.assign(row, change, { updatedAt: iso(clock.now) });
    return true;
  };
  return {
    rows,
    calls,
    async findOwnerContext(storeId) {
      return ownerContextOf(requireStoreId(storeId));
    },
    async create(storeId, enquiry) {
      calls.push('create');
      const row = { id: randomUUID(), storeId: requireStoreId(storeId), trace: [], answerText: null, sellerReply: null, repliedAt: null, claimedAt: null,
        createdAt: iso(clock.now), updatedAt: iso(clock.now), ...enquiry };
      rows.push(row);
      return { id: row.id };
    },
    async findByTokenHash(storeId, hash) {
      const row = inStore(storeId).find((candidate) => candidate.tokenHash === hash);
      return row ? view(row) : null;
    },
    async claim(storeId, id, nowIso) {
      calls.push('claim');
      return cas(storeId, id, (r) => r.status === ENQUIRY_STATUS.PENDING, { status: ENQUIRY_STATUS.ANSWERING, claimedAt: nowIso });
    },
    async finish(storeId, id, { status, answerText, flagReason, trace }) {
      calls.push('finish');
      return cas(storeId, id, (r) => r.status === ENQUIRY_STATUS.ANSWERING, { status, answerText, flagReason, trace });
    },
    async failStuck(storeId, id, staleBeforeIso) {
      return cas(storeId, id, (r) => r.status === ENQUIRY_STATUS.ANSWERING && Date.parse(r.claimedAt) < Date.parse(staleBeforeIso),
        { status: ENQUIRY_STATUS.NEEDS_YOU, flagReason: 'error' });
    },
    async countByPhoneSince(storeId, phone, sinceIso) {
      return inStore(storeId).filter((r) => r.customerPhone === phone && Date.parse(r.createdAt) >= Date.parse(sinceIso)).length;
    },
    async countClaimedSince(storeId, sinceIso) {
      return inStore(storeId).filter((r) => r.claimedAt && Date.parse(r.claimedAt) >= Date.parse(sinceIso)).length;
    },
    async countByStatus(storeId, status) {
      return inStore(storeId).filter((r) => r.status === status).length;
    },
    async listForOwner(storeId, { status = null } = {}) {
      return inStore(storeId).filter((r) => !status || r.status === status).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map((r) => view(r));
    },
    async findForOwner(storeId, id) {
      const row = inStore(storeId).find((candidate) => candidate.id === id);
      return row ? view(row, true) : null;
    },
    async saveReply(storeId, id, reply, nowIso) {
      return cas(storeId, id, (r) => ['answered', 'needs_you', 'handled'].includes(r.status), { sellerReply: reply, repliedAt: nowIso, status: ENQUIRY_STATUS.HANDLED });
    },
    async markHandled(storeId, id) {
      return cas(storeId, id, (r) => ['answered', 'needs_you'].includes(r.status), { status: ENQUIRY_STATUS.HANDLED });
    },
  };
}

export const call = (name, input = {}) => ({ type: 'tool_use', id: `tu_${randomUUID().slice(0, 8)}`, name, input });
export const turn = (...content) => ({ content, stop_reason: 'tool_use' });
export const finalAnswer = (outcome, text) => turn(call('final_answer', { outcome, text }));

/**
 * The real app with the real assistant, inbox and knowledge services over in-memory repositories and a scripted fake model. One owner
 * (logged in) with one shop (WhatsApp on) and one published product (Rs 250, stock 5).
 * @param {{ script?: object[], send?: Function, tiers?: object[], document?: string, shop?: object, appDeps?: object, withAgent?: boolean, wallClockMs?: number, stock?: number | null }} [options]
 */
export async function startAssistantApp({ chatAgent = createFakeAgent({ fallback: answered() }), script = [], send, tiers = [], document = 'We ship across India in 5 days.', shop = {}, appDeps = {}, withAgent = true, wallClockMs, stock = 5 } = {}) {
  const clock = { now: Date.parse('2026-11-16T10:00:00Z') };
  const repo = createFakePublicRepo();
  const logs = createLogCollector();
  const outbox = createFakeOutbox({ clock: { get now() { return clock.now; } } });
  const budgets = createFakeBudgets();
  const knowledgeRepo = createFakeKnowledgeRepo();
  const linkCipher = createLinkCipher(TEST_LINK_KEY);
  const requests = [];
  const queue = [...script];
  const transport = send ?? (async (request) => {
    requests.push(structuredClone(request));
    const next = queue.shift();
    if (!next) throw Object.assign(new Error('script exhausted'), { kind: 'http', status: 500 });
    return { response: typeof next === 'function' ? next(request) : next, usage: { inputTokens: 100, outputTokens: 20 } };
  });
  let app;
  const ownerContextOf = (storeId) => {
    const store = app.storesRepo.rows.find((row) => row.id === storeId);
    const owner = app.ownersRepo.rows.find((row) => row.id === store?.ownerId);
    return store ? { id: store.id, ownerId: store.ownerId, name: store.name, notifyEnquiryEmail: store.notifyEnquiryEmail, isDemo: owner?.isDemo ?? false } : null;
  };
  const enquiryRepo = createFakeEnquiryRepo({ clock, ownerContextOf });
  const emailService = createEmailService({ outbox, owners: { findById: async (id) => app.ownersRepo.rows.find((row) => row.id === id) ?? null }, logger: logs, baseUrl: 'https://shop.example.test' });
  const tokens = [];
  const agent = withAgent ? createEnquiryAgent({ config: { apiKey: 'k', model: 'fake-model' }, send: transport }) : null;
  const assistant = createAssistantService({
    shops: repo, enquiries: enquiryRepo, knowledge: knowledgeRepo, agent, budgets: withAgent ? budgets : null, emails: emailService, logger: logs,
    baseUrl: 'https://shop.example.test', linkCipher, now: () => clock.now, ...(wallClockMs ? { agentWallClockMs: wallClockMs } : {}),
    newToken: () => { const token = randomUUID().replaceAll('-', '').padEnd(43, 'x').slice(0, 43); tokens.push(token); return token; },
  });
  const enquiries = createEnquiryInboxService({ enquiries: enquiryRepo, knowledge: knowledgeRepo, emails: emailService, logger: logs, linkCipher, baseUrl: 'https://shop.example.test', now: () => clock.now });
  const knowledge = createKnowledgeService({ knowledge: knowledgeRepo, budgets, now: () => clock.now });
  const conversationRepo = createFakeConversationRepo({
    now: () => clock.now, ownerContextOf,
    legacyDelete: (storeId, id) => { const at = enquiryRepo.rows.findIndex((row) => row.storeId === storeId && row.id === id); if (at < 0) return false; enquiryRepo.rows.splice(at, 1); return true; },
  });
  const conversationInbox = createConversationInboxService({ conversations: conversationRepo, legacy: enquiries, logger: logs, linkCipher, baseUrl: 'https://shop.example.test', now: () => clock.now });
  const chatAlerts = [];
  const conversations = createConversationService({
    shops: repo, conversations: conversationRepo, knowledge: knowledgeRepo, agent: chatAgent, budgets, emails: { enqueueSellerEnquiryAlert: async (ctx, id) => { chatAlerts.push(id); return emailService.enqueueSellerEnquiryAlert(ctx, id); } },
    logger: logs, linkCipher, now: () => clock.now, baseUrl: 'https://shop.example.test',
  });
  app = await startPublicApp({ appOptions: { appDeps }, repo, extraServices: { assistant, enquiries, knowledge, conversationInbox, conversations } });
  const cookie = await signupAndLogin(app);
  await app.request('/store/new', { method: 'POST', cookie, form: STORE_FORM });
  const store = app.storesRepo.rows[0];
  const fakeShop = repo.addShop({ id: store.id, ownerId: store.ownerId, slug: store.slug, name: store.name, defaultLanguage: 'en',
    whatsappNumber: '919123456780', whatsappEnabled: true, ...shop });
  const product = repo.addProduct(fakeShop, { pricePaise: 25000, stock, translations: { en: translation('Clay diya', 'A hand made diya.', 'A diya.') } });
  await knowledgeRepo.replaceContent(store.id, document, 'now');
  await knowledgeRepo.saveRules(store.id, tiers, 'now');
  /** Legacy enquiries are no longer created through the site (the chat replaced the form), so the legacy tests seed a pending enquiry directly. */
  const ask = async (form = ASK) => {
    const token = generateStatusToken();
    tokens.push(token);
    await enquiryRepo.create(store.id, {
      productId: form.productId ?? null, language: 'en', customerName: form.name, customerPhone: normalizeWhatsappNumber(form.phone), question: form.question, status: 'pending', flagReason: null,
      tokenHash: hashStatusToken(token), tokenEnc: linkCipher.encrypt(token),
    });
    return { status: 303, location: `/s/${store.slug}/q/${token}?lang=en`, text: '' };
  };
  const tokenOf = (res) => {
    assert.equal(res.status, 303, res.text.slice(0, 300));
    return /\/q\/([A-Za-z0-9_-]{43})/.exec(res.location)[1];
  };
  const page = (token, extra = {}) => app.request(`/s/${store.slug}/q/${token}`, extra);
  const answer = (token, extra = {}) => app.request(`/s/${store.slug}/q/${token}/answer`, { method: 'POST', ...extra });
  const owner = (path, extra = {}) => app.request(path, { cookie, ...extra });
  return {
    ...app, cookie, store, shop: fakeShop, product, repo, clock, serviceLogs: logs, outbox, budgets, knowledgeRepo, enquiryRepo, requests, linkCipher, tokens, assistant, enquiries,
    ask, tokenOf, page, answer, owner, conversationRepo, conversationInbox, conversations, chatAlerts, chatAgent,
  };
}
