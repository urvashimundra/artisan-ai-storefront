import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createLogger } from '../../src/lib/logger.js';
import { createOrderRepository } from '../../src/repositories/orderRepository.js';
import { generateStatusToken } from '../../src/lib/statusToken.js';

const STORE_ID = '3f2b8c1e-5a4d-4b7e-9c10-1d2e3f4a5b6c';
const ORDER_ID = '9a2b8c1e-5a4d-4b7e-9c10-1d2e3f4a5b6c';
const read = (relative) => readFileSync(fileURLToPath(new URL(`../../${relative}`, import.meta.url)), 'utf8');

/** A recording client: every from(), filter and rpc() is captured. */
function recordingClient(result = { data: [], error: null }) {
  const calls = [];
  const chain = (table) => {
    const state = { table, selects: [], filters: [] };
    calls.push(state);
    const query = {
      select: (columns, options) => (state.selects.push({ columns, options }), query),
      eq: (column, value) => (state.filters.push([column, value]), query),
      order: () => query,
      limit: () => query,
      maybeSingle: async () => ({ data: null, error: null }),
      then: (resolve) => resolve({ ...result, count: 0 }),
    };
    return query;
  };
  return { calls, from: chain, rpc: async (name, args) => (calls.push({ rpc: name, args }), { data: { ok: true }, error: null }) };
}

describe('orderRepository', () => {
  it('scopes every owner read by store_id and never selects the token hash', async () => {
    const client = recordingClient();
    const repo = createOrderRepository({ client });
    await repo.listForOwner(STORE_ID, { status: 'paid' });
    await repo.findForOwner(STORE_ID, ORDER_ID);
    await repo.countByStatus(STORE_ID, 'payment_submitted');
    const queries = client.calls.filter((call) => call.table === 'orders');
    assert.equal(queries.length, 3);
    for (const query of queries) {
      assert.deepEqual(query.filters.find(([column]) => column === 'store_id'), ['store_id', STORE_ID]);
      for (const { columns } of query.selects) assert.doesNotMatch(columns, /status_token_hash/);
    }
  });

  it('refuses to run without a valid store id', async () => {
    const repo = createOrderRepository({ client: recordingClient() });
    await assert.rejects(async () => repo.listForOwner(undefined), TypeError);
    assert.throws(() => repo.resolvePayment('nope', ORDER_ID, ORDER_ID, 'paid'), TypeError);
    assert.throws(() => repo.cancelOrder(undefined, { orderId: ORDER_ID, actor: 'owner' }), TypeError);
    await assert.rejects(async () => repo.expireOverdue('x'), TypeError);
  });

  it('calls one database function per business change, passing the store id and the owner id from the caller', async () => {
    const client = recordingClient();
    const repo = createOrderRepository({ client });
    await repo.resolvePayment(STORE_ID, 'owner-1', ORDER_ID, 'paid');
    await repo.cancelOrder(STORE_ID, { orderId: ORDER_ID, actor: 'customer', tokenHash: 'h' });
    await repo.submitPaymentReference(STORE_ID, 'h', '123456789012');
    const rpcs = client.calls.filter((call) => call.rpc);
    assert.deepEqual(rpcs.map((call) => call.rpc), ['resolve_payment', 'cancel_order', 'submit_payment_reference']);
    for (const call of rpcs) assert.equal(call.args.p_store_id, STORE_ID);
    assert.equal(rpcs[0].args.p_owner_id, 'owner-1');
  });

  it('is the only place that talks to the orders tables (no supabase-js in the service or controllers)', () => {
    for (const file of ['src/services/orderService.js', 'src/controllers/orderController.js', 'src/controllers/ownerOrderController.js', 'src/routes/orders.js']) {
      assert.doesNotMatch(read(file), /supabase|\.rpc\(|\.from\(/, file);
    }
  });
});

describe('logger redaction for orders', () => {
  it('redacts the token path, wa.me links, UTR, address and VPA keys', () => {
    const lines = [];
    const logger = createLogger({ level: 'debug', write: (line) => lines.push(line) });
    const token = generateStatusToken();
    logger.info('x', { path: `/o/${token}/utr`, link: 'see https://wa.me/919876543210?text=hi now', utr: '123456789012', deliveryAddress: 'secret street', upiId: 'a@b', customerName: 'Asha' });
    const line = lines[0];
    for (const secret of [token, 'wa.me', '919876543210', '123456789012', 'secret street', 'a@b', 'Asha']) assert.equal(line.includes(secret), false, secret);
    assert.ok(line.includes('/o/[REDACTED]/utr'));
  });
});

describe('payment page assets', () => {
  it('puts the QR second only on touch devices via a pointer media query, with no user-agent sniffing', () => {
    const css = read('public/css/public.css');
    assert.match(css, /@media \(pointer: coarse\)\s*\{[^}]*\.pay-button \{ order: 1; \}[^}]*\.pay-qr \{ order: 2; \}/);
    assert.match(css, /\.pay-qr \{ order: 1;/);
    assert.doesNotMatch(read('src/views/public/order.ejs') + read('public/js/copy-upi.js'), /userAgent|navigator\.platform/i);
  });

  it('copy-upi.js is an external file using the Clipboard API with a fallback and a live region', () => {
    const script = read('public/js/copy-upi.js');
    for (const piece of ['navigator.clipboard', "execCommand('copy')", 'data-copy-status', 'button.hidden = false']) assert.ok(script.includes(piece), piece);
  });
});
