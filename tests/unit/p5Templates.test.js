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
