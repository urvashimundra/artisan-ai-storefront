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
