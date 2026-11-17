import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';
import { CONVERSATION_STRINGS, NOTICE_KEYS } from '../../src/domain/conversationStrings.js';
import { answered, createFakeAgent, failedRun } from '../helpers/conversationFakes.js';
import { startChatApp } from '../helpers/chatApp.js';

const EN = CONVERSATION_STRINGS.en;
const withApp = async (options, run) => {
  const app = await startChatApp(options);
  try {
    await run(app);
  } finally {
    await app.close();
  }
};

describe('customer chat: start, resume and history', () => {
  it('shows the start screen with name, number, message, idempotency keys and no secret', async () => {
    await withApp({}, async (app) => {
      const res = await app.request('/s/clay-works/chat');
      assert.equal(res.status, 200);
      for (const text of ['name="name"', 'name="phone"', 'name="message"', 'name="startKey"', 'name="messageId"', EN.chatStartButton]) assert.ok(res.text.includes(text), text);
      assert.match(res.text, /<html lang="en">/);
      assert.ok(!res.text.includes('919123456780'));
    });
  });

  it('starts a chat, redirects to the private link, and shows the whole conversation in order', async () => {
    await withApp({}, async (app) => {
      const res = await app.start();
      assert.equal(res.status, 303);
      assert.match(res.location, /^\/s\/clay-works\/c\/[A-Za-z0-9_-]{43}\?lang=en$/);
      const token = app.tokenOf(res);
      const chat = await app.page(token);
      assert.equal(chat.status, 200);
      assert.ok(chat.text.indexOf('Do you ship to Pune?') < chat.text.indexOf('It is in stock.'));
      assert.match(chat.text, /<ol class="chat-messages"/);
      assert.match(chat.text, /msg-customer/);
      assert.match(chat.text, /msg-assistant/);
      assert.ok(chat.text.includes(EN.chatAiLabel));
    });
  });

  it('persists across refreshes and supports several messages in one conversation without asking for details again', async () => {
    await withApp({}, async (app) => {
      const token = app.tokenOf(await app.start());
      const first = await app.send(token, 'How long does delivery take?');
      assert.deepEqual(JSON.parse(first.text), { saved: true, outcome: 'answered', duplicate: false });
      const reload = await app.page(token);
      assert.equal((reload.text.match(/class="msg msg-customer/g) ?? []).length, 2);
      assert.equal((reload.text.match(/class="msg msg-assistant/g) ?? []).length, 2);
      assert.ok(!reload.text.includes('name="phone"'));
    });
  });

  it('serves new messages after a sequence number as JSON for the refresh on load and on focus', async () => {
    await withApp({}, async (app) => {
      const token = app.tokenOf(await app.start());
      const all = JSON.parse((await app.poll(token, 0)).text);
      assert.deepEqual(all.messages.map((m) => m.role), ['customer', 'assistant']);
      assert.equal(all.aiRunning, false);
      const none = JSON.parse((await app.poll(token, 2)).text);
      assert.deepEqual(none.messages, []);
      await app.send(token, 'another');
      assert.equal(JSON.parse((await app.poll(token, 2)).text).messages.length, 2);
    });
  });

  it('keeps every private response no-store, noindex and nofollow with a same-origin referrer policy', async () => {
    await withApp({}, async (app) => {
      const token = app.tokenOf(await app.start());
      for (const res of [await app.request('/s/clay-works/chat'), await app.page(token), await app.poll(token), await app.page('A'.repeat(43)), await app.send(token, 'x')]) {
        assert.equal(res.headers.get('cache-control'), 'no-store');
        assert.equal(res.headers.get('x-robots-tag'), 'noindex, nofollow');
        assert.equal(res.headers.get('referrer-policy'), 'same-origin');
      }
      assert.match((await app.page(token)).text, /<meta name="robots" content="noindex, nofollow">/);
    });
  });

  it('never puts the private token in a cookie, storage script or log, and the page script does not use browser storage', async () => {
    await withApp({}, async (app) => {
      const res = await app.start();
      const token = app.tokenOf(res);
      const chat = await app.page(token);
      assert.deepEqual(res.setCookie, []);
      assert.deepEqual(chat.setCookie, []);
      assert.ok(!JSON.stringify(app.logs).includes(token));
      const { readFileSync } = await import('node:fs');
      const script = readFileSync(new URL('../../public/js/chat.js', import.meta.url), 'utf8');
      assert.doesNotMatch(script, /localStorage|sessionStorage|indexedDB|document\.cookie|innerHTML|eval\(/);
    });
  });
});

describe('customer chat: security and tenancy', () => {
  it('treats another store, a malformed token and an unknown token alike as a generic 404', async () => {
    await withApp({}, async (app) => {
      const token = app.tokenOf(await app.start());
      for (const res of [await app.page(token, 'other-shop'), await app.page('short'), await app.page('A'.repeat(43)), await app.poll(token, 0, 'other-shop')]) {
        assert.equal(res.status, 404);
      }
      assert.ok(!(await app.page(token, 'other-shop')).text.includes('Pune'));
      assert.equal((await app.request(`/s/other-shop/c/${token}/messages`, { method: 'POST', form: { message: 'hi', messageId: randomUUID() }, headers: { accept: 'application/json' } })).status, 404);
    });
  });

  it('rejects a cross-origin post before anything is saved', async () => {
    await withApp({}, async (app) => {
      const token = app.tokenOf(await app.start());
      const before = app.conversationsRepo.messages.length;
      const evil = { origin: 'https://evil.example' };
      assert.equal((await app.send(token, 'sneaky', { request: evil })).status, 403);
      assert.equal((await app.start({}, evil)).status, 403);
      assert.equal(app.conversationsRepo.messages.length, before);
    });
  });

  it('does not accept a store id or conversation id from the body', async () => {
    await withApp({}, async (app) => {
      const token = app.tokenOf(await app.start());
      const res = await app.send(token, 'hi', { form: { storeId: app.other.id } });
      assert.equal(res.status, 400);
      assert.equal(JSON.parse(res.text).saved, false);
    });
  });

  it('is rate limited per IP on top of the database limits', async () => {
    await withApp({ appDeps: { assistantRateLimits: { chatMessage: { windowMs: 60_000, limit: 2 }, chatStart: { windowMs: 60_000, limit: 100 } } } }, async (app) => {
      const token = app.tokenOf(await app.start());
      assert.equal((await app.send(token, 'one')).status, 200);
      assert.equal((await app.send(token, 'two')).status, 200);
      assert.equal((await app.send(token, 'three')).status, 429);
    });
  });
});

describe('customer chat: distinct outcomes', () => {
  it('rejects bad input with nothing sent, on the start page and in JSON', async () => {
    await withApp({}, async (app) => {
      const res = await app.start({ phone: '12', name: '' });
      assert.equal(res.status, 400);
      assert.ok(res.text.includes(EN.chatErrPhone) && res.text.includes(EN.chatErrRejected));
      assert.ok(res.text.includes('name="startKey"'));
      assert.equal(app.conversationsRepo.conversations.size, 0);
      const token = app.tokenOf(await app.start());
      const json = await app.send(token, '   ');
      assert.equal(json.status, 400);
      assert.deepEqual(JSON.parse(json.text), { saved: false, code: 'REJECTED', text: EN.chatErrRejected });
    });
  });

  it('says plainly the message was NOT saved when the database fails, and keeps the same keys so a retry is safe', async () => {
    await withApp({}, async (app) => {
      app.conversationsRepo.state.failNext = true;
      const keys = { startKey: randomUUID(), messageId: randomUUID() };
      const res = await app.start(keys);
      assert.equal(res.status, 503);
      assert.ok(res.text.includes(EN.chatErrNotSaved));
      assert.ok(res.text.includes(`value="${keys.startKey}"`) && res.text.includes(`value="${keys.messageId}"`));
      assert.ok(res.text.includes('Do you ship to Pune?'));
      const retry = await app.start(keys);
      assert.equal(retry.status, 303);
      const token = app.tokenOf(retry);
      app.conversationsRepo.state.failNext = true;
      const failed = await app.send(token, 'second');
      assert.equal(failed.status, 503);
      assert.deepEqual(JSON.parse(failed.text), { saved: false, code: 'PERSISTENCE_FAILED', text: EN.chatErrNotSaved });
    });
  });

  it('shows the customer limit, the busy state and the full-conversation state distinctly', async () => {
    const agent = createFakeAgent({ fallback: failedRun('provider_error') });
    await withApp({ agent }, async (app) => {
      const token = app.tokenOf(await app.start());
      for (let i = 0; i < 5; i += 1) await app.send(token, `q${i}`);
      const limited = await app.send(token, 'too many');
      assert.equal(limited.status, 429);
      assert.equal(JSON.parse(limited.text).text, EN.chatErrCustomerLimit);
      const html = await app.start({ phone: '98765 43210' });
      assert.equal(html.status, 429);
      assert.ok(html.text.includes(EN.chatErrCustomerLimit));
      const [row] = [...app.conversationsRepo.conversations.values()];
      row.messageCount = 199;
      assert.equal(JSON.parse((await app.send(token, 'x')).text).text, EN.chatErrFull);
    });
  });

  it('keeps the message and shows a fixed notice for every kind of assistant failure', async () => {
    for (const reason of ['budget', 'provider_limit', 'provider_error', 'timeout', 'network', 'invalid_output', 'refused', 'unavailable']) {
      await withApp({ agent: createFakeAgent({ fallback: failedRun(reason) }) }, async (app) => {
        const token = app.tokenOf(await app.start());
        const chat = await app.page(token);
        assert.ok(chat.text.includes('Do you ship to Pune?'), reason);
        assert.ok(chat.text.includes(EN[NOTICE_KEYS[reason]]), reason);
        assert.match(chat.text, /msg-flag/);
        assert.ok(chat.text.includes(EN.chatSellerWaiting), `${reason}: seller banner`);
        assert.ok(chat.text.includes('href="https://wa.me/'), `${reason}: whatsapp`);
        assert.equal(app.alerts.length, 1, reason);
      });
    }
  });

  it('works without JavaScript: a plain form post saves, runs the assistant and redirects back to the chat', async () => {
    await withApp({}, async (app) => {
      const token = app.tokenOf(await app.start());
      const res = await app.send(token, 'plain form', { json: false });
      assert.equal(res.status, 303);
      assert.equal(res.location, `/s/clay-works/c/${token}?lang=en`);
      assert.ok((await app.page(token)).text.includes('plain form'));
      const bad = await app.send(token, '', { json: false });
      assert.equal(bad.status, 400);
      assert.ok(bad.text.includes(EN.chatErrRejected));
    });
  });

  it('escapes message text in HTML and JSON and never renders HTML from the model', async () => {
    const agent = createFakeAgent({ fallback: answered('<script>alert(1)</script> <b>bold</b>') });
    await withApp({ agent }, async (app) => {
      const token = app.tokenOf(await app.start({ message: '<img src=x onerror=alert(1)>' }));
      const chat = await app.page(token);
      assert.ok(!chat.text.includes('<img src=x'));
      assert.ok(!chat.text.includes('<script>alert'));
      assert.ok(chat.text.includes('&lt;img src=x onerror=alert(1)&gt;'));
    });
  });

  it('is idempotent: a repeated message id saves once, in JSON and as a start', async () => {
    await withApp({}, async (app) => {
      const keys = { startKey: randomUUID(), messageId: randomUUID() };
      const a = await app.start(keys);
      const b = await app.start(keys);
      assert.equal(app.tokenOf(a), app.tokenOf(b));
      assert.equal(app.conversationsRepo.conversations.size, 1);
      const token = app.tokenOf(a);
      const id = randomUUID();
      await app.send(token, 'once', { form: { messageId: id } });
      const again = await app.send(token, 'once', { form: { messageId: id } });
      assert.equal(JSON.parse(again.text).duplicate, true);
      assert.equal(app.conversationsRepo.messages.filter((m) => m.body === 'once').length, 1);
    });
  });

  it('shows the Gujarati and Hindi chat with a visible pending-review notice, and English without one', async () => {
    await withApp({}, async (app) => {
      const token = app.tokenOf(await app.start());
      for (const lang of ['gu', 'hi']) {
        const chat = await app.request(`/s/clay-works/c/${token}?lang=${lang}`);
        assert.match(chat.text, new RegExp(`<html lang="${lang}">`));
        assert.match(chat.text, /data-translation-status="pending-review"/);
        assert.ok(chat.text.includes(CONVERSATION_STRINGS[lang].chatReviewNotice));
        assert.ok(chat.text.includes(CONVERSATION_STRINGS[lang].chatSend));
      }
      assert.doesNotMatch((await app.page(token)).text, /pending-review/);
    });
  });

  it('retires the embedded ask form: the old endpoint forwards to the chat and saves nothing', async () => {
    await withApp({}, async (app) => {
      const post = await app.request('/s/clay-works/ask', { method: 'POST', form: { name: 'A', phone: '9876543210', question: 'hi' } });
      assert.equal(post.status, 303);
      assert.equal(post.location, '/s/clay-works/chat');
      assert.equal(app.conversationsRepo.conversations.size, 0);
    });
  });

  it('returns 404 for an unknown shop on every chat route', async () => {
    await withApp({}, async (app) => {
      assert.equal((await app.request('/s/nope-shop/chat')).status, 404);
      assert.equal((await app.start({}, {})).status, 303);
      assert.equal((await app.request('/s/nope-shop/chat', { method: 'POST', form: { name: 'A' } })).status, 404);
    });
  });
});
