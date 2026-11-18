import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const view = (name) => readFileSync(new URL(`../../src/views/${name}.ejs`, import.meta.url), 'utf8');
const css = (name) => readFileSync(new URL(`../../public/css/${name}.css`, import.meta.url), 'utf8');
const hasAll = (source, hooks) => hooks.forEach((hook) => assert.ok(source.includes(hook), hook));

describe('T13 orders list', () => {
  it('keeps table semantics, search hooks, row links and labels', () => {
    hasAll(view('orders'), ['class="table-wrap order-table-wrap"', 'class="data-table order-table"', 'id="order-results"', 'data-order-search', 'data-order-row', 'id="order-search"', 'id="order-count"', 'id="order-search-empty"', 'role="status"', 'scope="col"', 'scope="row"', 'View order', '/js/order-search.js', 'method="get" action="/orders"', 'name="status"', 'class="empty-state"']);
  });

  it('never turns table parts into block or flex boxes outside the narrow items table', () => {
    assert.doesNotMatch(css('app'), /\.(data-table|order-table)[^{]*\{[^}]*display:\s*(block|flex)/);
  });
});

describe('T14 order detail', () => {
  const page = view('order-detail');

  it('puts the actions block before the order details in the DOM', () => {
    const actions = page.indexOf('id="actions-heading"');
    assert.ok(actions > 0);
    ['id="customer-heading"', 'id="items-heading"', 'id="payment-heading"'].forEach((id) => assert.ok(actions < page.indexOf(id), id));
  });

  it('keeps every form action, hidden confirmation, label and the script', () => {
    hasAll(page, ['action="/orders/<%= order.id %>/paid"', 'action="/orders/<%= order.id %>/not-received"', 'data-confirm="This was attempt', 'data-confirm="Mark this payment as not received?', 'Payment not received: cancel order', 'Payment not received</button>', 'Mark as paid', 'href="/orders/<%= order.id %>/cancel"', 'class="danger-zone"', 'Message customer on WhatsApp', '/js/confirm-submit.js', 'role="alert"', 'role="status"']);
    assert.equal(page.split('method="post"').length - 1, 3);
  });

  it('labels the single status field honestly and places columns without CSS order', () => {
    assert.ok(!page.includes('<dt>Payment status</dt>') && page.includes('<dt>Current status</dt>'));
    const styles = css('app');
    assert.doesNotMatch(styles, /\border:\s*-?\d/);
    assert.match(styles, /\.detail-layout > \.detail-side \{ grid-column: 2; grid-row: 1; \}/);
  });
});

describe('T15 conversations', () => {
  it('list keeps links, badges and labels', () => {
    hasAll(view('conversations'), ['class="convo-list plain"', 'class="convo-link"', 'status-badge status-<%= row.state %>', 'aria-label="Filter conversations"', 'aria-current="page"', 'Open conversation with', 'class="empty-state"']);
  });

  it('detail keeps the sender labels, forms, hidden fields and hooks', () => {
    const page = view('conversation-detail');
    hasAll(page, ["'AI assistant'", "'You'", 'thread-<%= m.role %>', 'thread-who', 'thread-time', 'action="/enquiries/<%= conversation.id %>/reply"', 'name="messageId" value="<%= replyId %>"', 'name="reply"', 'data-counter="reply-count"', 'id="reply-count" class="hint" aria-live="polite"', 'Send reply', 'action="/enquiries/<%= conversation.id %>/handled"', 'Mark as handled', 'action="/enquiries/<%= conversation.id %>/delete"', 'name="confirm" value="yes"', 'data-confirm="Delete this conversation', '/js/char-counter.js', '/js/confirm-submit.js']);
  });

  it('tells senders apart by layout and wraps long text, without sticky bars', () => {
    const styles = css('app');
    assert.match(styles, /\.thread-customer \{ justify-content: flex-start; \}/);
    assert.match(styles, /\.thread-assistant, \.thread-seller \{ justify-content: flex-end; \}/);
    assert.match(styles, /\.thread-assistant \.thread-bubble \{[^}]*border-inline-start/);
    assert.match(styles, /\.thread-bubble \{[^}]*overflow-wrap: anywhere/);
    assert.doesNotMatch(styles.slice(styles.indexOf('.thread {'), styles.indexOf('.conflict {')), /sticky/);
  });
});

describe('T16 public chatbot', () => {
  const chat = view('public/chat');
  const styles = css('public');

  it('keeps every chat hook, live region, hidden field and the send label', () => {
    hasAll(chat, ['data-chat ', 'data-poll-url', 'data-last-seq', 'data-running', 'data-str-sending', 'id="chat-log" role="log" aria-live="polite"', 'id="chat-typing" role="status"', 'id="chat-error" role="alert"', 'data-chat-status', 'data-needs-seller', 'data-share', 'data-share-status', 'id="composer"', 'name="messageId"', 'id="composer-text"', 'name="message"', 'class="composer-send"', 'composer-send-label', '<%= strings.chatSend %>', 'data-seq="<%= m.seq %>"', 'data-role="<%= m.role %>"']);
  });

  it('keeps the start button label', () => {
    assert.match(view('public/chat-start'), /<button type="submit" class="button button-large"><%= strings\.chatStartButton %><\/button>/);
  });

  it('styles the disabled send button in public tokens and keeps a 44px target and focus ring', () => {
    assert.match(styles, /\.composer-send:disabled \{[^}]*background: var\(--surface\)[^}]*color: var\(--muted\)/);
    assert.match(styles, /\.composer-send \{[^}]*min-height: 2\.75rem/);
    assert.match(styles, /\.composer-send:focus-visible/);
    assert.match(styles, /\.msg-text \{[^}]*overflow-wrap: anywhere/);
  });
});
