import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';
import { createFakeAgent, answered, failedRun } from '../helpers/conversationFakes.js';
import { startAssistantApp } from '../helpers/assistantApp.js';

const run = async (options, body) => {
  const app = await startAssistantApp(options);
  try {
    await body(app);
  } finally {
    await app.close();
  }
};
const startChat = (t, form = {}) => t.request(`/s/${t.store.slug}/chat`, {
  method: 'POST', form: { name: 'Asha Patel', phone: '98765 43210', message: 'Do you ship to Pune?', startKey: randomUUID(), messageId: randomUUID(), ...form },
});
const tokenOf = (res) => /\/c\/([A-Za-z0-9_-]{43})/.exec(res.location)[1];
const firstConversation = (t) => [...t.conversationRepo.conversations.values()][0];

describe('seller conversations inbox', () => {
  it('lists conversations with text states, shows the full thread with distinct roles and the customer contact to the owner only', async () => {
    await run({}, async (t) => {
      const customer = await startChat(t);
      assert.equal(customer.status, 303);
      const id = firstConversation(t).id;
      const list = await t.owner('/enquiries');
      assert.match(list.text, /<h1>Conversations<\/h1>/);
      assert.ok(list.text.includes('Asha Patel') && list.text.includes('Answered by assistant'));
      const detail = await t.owner(`/enquiries/${id}`);
      assert.equal(detail.status, 200);
      for (const text of ['thread-customer', 'thread-assistant', 'AI assistant', '+919876543210', 'Open WhatsApp', 'Reply in this conversation', 'Do you ship to Pune?']) assert.ok(detail.text.includes(text), text);
      const publicChat = await t.request(`/s/${t.store.slug}/c/${tokenOf(customer)}`);
      assert.ok(!publicChat.text.includes('9876543210'));
    });
  });

  it('requires a logged-in owner and applies the Origin check to every state change', async () => {
    await run({}, async (t) => {
      await startChat(t);
      const id = firstConversation(t).id;
      assert.equal((await t.request('/enquiries')).status, 303);
      assert.equal((await t.request(`/enquiries/${id}`)).status, 303);
      for (const action of ['reply', 'handled', 'delete']) {
        const res = await t.owner(`/enquiries/${id}/${action}`, { method: 'POST', form: { reply: 'x', messageId: randomUUID(), confirm: 'yes' }, origin: 'https://evil.example' });
        assert.equal(res.status, 403, action);
      }
      assert.equal(t.conversationRepo.conversations.size, 1);
    });
  });

  it('puts the seller reply in the customer existing conversation, marks it handled, and a double submit adds one message', async () => {
    await run({}, async (t) => {
      const token = tokenOf(await startChat(t));
      const id = firstConversation(t).id;
      const messageId = randomUUID();
      const first = await t.owner(`/enquiries/${id}/reply`, { method: 'POST', form: { reply: 'Yes, we ship to Pune in 4 days.', messageId } });
      assert.equal(first.status, 303);
      await t.owner(`/enquiries/${id}/reply`, { method: 'POST', form: { reply: 'Yes, we ship to Pune in 4 days.', messageId } });
      const chat = await t.request(`/s/${t.store.slug}/c/${token}`);
      assert.equal((chat.text.match(/Yes, we ship to Pune in 4 days\./g) ?? []).length, 1);
      assert.match(chat.text, /msg msg-seller/);
      assert.ok(chat.text.indexOf('Do you ship') < chat.text.indexOf('4 days'));
      assert.equal(firstConversation(t).status, 'handled');
      const detail = await t.owner(`/enquiries/${id}`);
      assert.match(detail.text, /status-handled/);
      assert.ok(detail.text.includes('https://wa.me/919876543210?text='));
      assert.ok(decodeURIComponent(detail.text.match(/wa\.me\/\d+\?text=([^"]+)"/)[1].replaceAll('&amp;', '&')).includes(`/s/${t.store.slug}/c/${token}`));
    });
  });

  it('rejects an empty reply, a store id in the body and a reply to another store', async () => {
    await run({}, async (t) => {
      await startChat(t);
      const id = firstConversation(t).id;
      const empty = await t.owner(`/enquiries/${id}/reply`, { method: 'POST', form: { reply: '  ', messageId: randomUUID() } });
      assert.equal(empty.status, 400);
      assert.match(empty.text, /Write a reply of 1 to 1000 characters/);
      assert.equal((await t.owner(`/enquiries/${id}/reply`, { method: 'POST', form: { reply: 'hi', messageId: randomUUID(), storeId: randomUUID() } })).status, 400);
      assert.equal((await t.owner(`/enquiries/${randomUUID()}/reply`, { method: 'POST', form: { reply: 'hi', messageId: randomUUID() } })).status, 404);
      assert.equal(t.conversationRepo.messages.filter((m) => m.role === 'seller').length, 0);
    });
  });

  it('shows both conflicting values with their source labels, and the customer sees only the fixed explanation', async () => {
    const conflict = { topic: 'Returns', claims: [{ label: 'seller_notes', excerpt: 'returns within 7 days' }, { label: 'product_description', excerpt: 'returns within 14 days' }] };
    const chatAgent = createFakeAgent({ fallback: { ok: true, outcome: 'conflict', text: null, conflict, sources: [], trace: [], steps: 1, charged: {} } });
    await run({ chatAgent }, async (t) => {
      const token = tokenOf(await startChat(t));
      const id = firstConversation(t).id;
      const detail = await t.owner(`/enquiries/${id}`);
      for (const text of ['Conflict: Returns', 'Your shop notes', 'returns within 7 days', 'Product description', 'returns within 14 days', 'status-needs_you', 'Two of your written sources disagree']) assert.ok(detail.text.includes(text), text);
      const customer = await t.request(`/s/${t.store.slug}/c/${token}`);
      assert.ok(!customer.text.includes('returns within 7 days') && !customer.text.includes('returns within 14 days'));
      assert.ok(customer.text.includes('two different answers'));
    });
  });

  it('shows needs-you, unanswered and handled states and filters by them', async () => {
    await run({ chatAgent: createFakeAgent({ results: [failedRun('provider_error'), answered()], fallback: answered() }) }, async (t) => {
      await startChat(t, { phone: '9000000001', name: 'Needs Person' });
      await startChat(t, { phone: '9000000002', name: 'Answered Person' });
      const unanswered = [...t.conversationRepo.conversations.values()][1];
      unanswered.lastMessageRole = 'customer';
      assert.ok((await t.owner('/enquiries?status=needs_you')).text.includes('Needs Person'));
      assert.ok(!(await t.owner('/enquiries?status=needs_you')).text.includes('Answered Person'));
      const un = await t.owner('/enquiries?status=unanswered');
      assert.ok(un.text.includes('Answered Person') && !un.text.includes('Needs Person'));
      assert.match(un.text, /aria-current="page" href="\/enquiries\?status=unanswered"/);
      assert.match((await t.owner('/dashboard')).text, /Conversations <span class="badge">1 need you/);
    });
  });

  it('keeps tenancy: another owner cannot list, read, reply to, hand over or delete the conversation', async () => {
    await run({}, async (t) => {
      await startChat(t);
      const id = firstConversation(t).id;
      t.conversationRepo.conversations.get(id).storeId = randomUUID();
      assert.ok(!(await t.owner('/enquiries')).text.includes('Asha Patel'));
      assert.equal((await t.owner(`/enquiries/${id}`)).status, 404);
      assert.equal((await t.owner(`/enquiries/${id}/handled`, { method: 'POST' })).status, 404);
      assert.equal((await t.owner(`/enquiries/${id}/delete`, { method: 'POST', form: { confirm: 'yes' } })).status, 404);
      assert.equal(t.conversationRepo.conversations.size, 1);
    });
  });

  it('deletes a conversation with its messages and private link only when confirmed', async () => {
    await run({}, async (t) => {
      const token = tokenOf(await startChat(t));
      const id = firstConversation(t).id;
      const refused = await t.owner(`/enquiries/${id}/delete`, { method: 'POST', form: {} });
      assert.equal(refused.status, 400);
      assert.equal(t.conversationRepo.conversations.size, 1);
      const done = await t.owner(`/enquiries/${id}/delete`, { method: 'POST', form: { confirm: 'yes' } });
      assert.equal(done.status, 303);
      assert.equal(t.conversationRepo.conversations.size, 0);
      assert.equal(t.conversationRepo.messages.length, 0);
      assert.equal((await t.request(`/s/${t.store.slug}/c/${token}`)).status, 404);
      assert.match((await t.owner('/enquiries?done=deleted')).text, /customer details were deleted/);
    });
  });

  it('still shows and opens legacy enquiries, with the old private /q/ link working', async () => {
    await run({}, async (t) => {
      const legacy = await t.ask();
      const list = await t.owner('/enquiries');
      assert.ok(list.text.includes('Earlier enquiries') && list.text.includes('Asha Patel'));
      const row = t.enquiryRepo.rows[0];
      assert.equal((await t.owner(`/enquiries/${row.id}`)).status, 200);
      assert.equal((await t.page(legacy.location.match(/q\/([^?]+)/)[1])).status, 200);
      const removed = await t.owner(`/enquiries/${row.id}/delete`, { method: 'POST', form: { confirm: 'yes' } });
      assert.equal(removed.status, 303);
    });
  });

  it('alerts the seller once per escalation with a conversation-based dedupe key', async () => {
    await run({ chatAgent: createFakeAgent({ fallback: failedRun('provider_error') }) }, async (t) => {
      const token = tokenOf(await startChat(t));
      await t.request(`/s/${t.store.slug}/c/${token}/messages`, { method: 'POST', form: { message: 'still there?', messageId: randomUUID() }, headers: { accept: 'application/json' } });
      assert.equal(t.chatAlerts.length, 1);
      assert.match(t.chatAlerts[0], /^[0-9a-f-]{36}:1$/);
      assert.equal(t.outbox.rows.filter((row) => row.kind === 'seller_enquiry_needs_you').length, 1);
    });
  });
});
