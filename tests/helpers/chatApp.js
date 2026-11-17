import { randomUUID } from 'node:crypto';
import { createLinkCipher } from '../../src/lib/linkCipher.js';
import { createConversationService } from '../../src/services/conversationService.js';
import { startAuthApp } from './appHarness.js';
import { answered, createFakeAgent, createFakeConversationRepo } from './conversationFakes.js';
import { createFakePublicRepo, startPublicApp, translation } from './publicFakes.js';

export const CHAT_LINK_KEY = 'D'.repeat(43);
const NOON = Date.parse('2026-11-16T10:00:00Z');

/**
 * The real app with the real conversation service over in-memory repositories and a fake agent. One shop (WhatsApp on) with one published
 * product, and a second shop for cross-store checks.
 * @param {{ agent?: object | null, shop?: object, appDeps?: object, withBudgets?: boolean }} [options]
 */
export async function startChatApp({ agent = createFakeAgent({ fallback: answered() }), shop = {}, appDeps = {} } = {}) {
  const clock = { now: NOON };
  const repo = createFakePublicRepo();
  const logs = [];
  const logger = { info: (m, f) => logs.push({ m, ...f }), warn: (m, f) => logs.push({ m, ...f }), error: (m, f) => logs.push({ m, ...f }) };
  const shopRow = repo.addShop({ slug: 'clay-works', name: 'Clay Works', whatsappNumber: '919123456780', whatsappEnabled: true, ...shop });
  const otherRow = repo.addShop({ slug: 'other-shop', name: 'Other Shop' });
  const product = repo.addProduct(shopRow, { translations: { en: translation('Clay diya', 'A hand made diya.', 'A diya.') } });
  const conversationsRepo = createFakeConversationRepo({ now: () => clock.now });
  const alerts = [];
  const budgets = { async reserve() { return { reservationId: 'r' }; }, async settle() {}, async release() {} };
  const conversations = createConversationService({
    shops: repo, conversations: conversationsRepo, knowledge: { get: async () => ({ content: 'We ship in 5 days.', bulkRules: [] }) }, agent, budgets: agent ? budgets : null,
    emails: { enqueueSellerEnquiryAlert: async (_store, id) => alerts.push(id) }, logger, linkCipher: createLinkCipher(CHAT_LINK_KEY), now: () => clock.now,
    baseUrl: 'https://shop.example.test',
  });
  const app = await startPublicApp({ repo, appOptions: { appDeps }, extraServices: { conversations } });
  const start = (form = {}, extra = {}) => app.request('/s/clay-works/chat', {
    method: 'POST', form: { name: 'Asha Patel', phone: '98765 43210', message: 'Do you ship to Pune?', startKey: randomUUID(), messageId: randomUUID(), ...form }, ...extra,
  });
  const tokenOf = (res) => /\/c\/([A-Za-z0-9_-]{43})/.exec(res.location)[1];
  const page = (token, slug = 'clay-works', extra = {}) => app.request(`/s/${slug}/c/${token}`, extra);
  const poll = (token, after = 0, slug = 'clay-works') => app.request(`/s/${slug}/c/${token}/messages?after=${after}`, { headers: { accept: 'application/json' } });
  const send = (token, message, extra = {}) => app.request(`/s/clay-works/c/${token}/messages`, {
    method: 'POST', form: { message, messageId: randomUUID(), ...extra.form }, headers: extra.json === false ? {} : { accept: 'application/json' }, ...extra.request,
  });
  return { ...app, repo, shop: shopRow, other: otherRow, product, clock, serviceLogs: logs, alerts, agent, conversationsRepo, conversations, start, tokenOf, page, poll, send };
}

export { startAuthApp };
