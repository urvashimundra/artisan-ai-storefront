import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const read = (relative) => readFileSync(fileURLToPath(new URL(`../../${relative}`, import.meta.url)), 'utf8');
const migration = read('db/migrations/009_order_reservation_10min.sql');
const smoke = read('db/test/009_order_reservation_smoke.sql');
const races = read('db/test/009_order_reservation_races.sql');

const BACKFILL = /UPDATE public\.orders\s+SET expires_at = created_at \+ public\.order_expiry_interval\(\), updated_at = now\(\)\s+WHERE status = 'awaiting_payment' AND expires_at > created_at \+ public\.order_expiry_interval\(\);/;
const normalise = (text) => text.replace(/\s+/g, ' ').trim();

describe('migration 009 test scripts', () => {
  it('the smoke test runs the exact backfill statement from the migration', () => {
    const fromMigration = migration.match(BACKFILL);
    assert.ok(fromMigration, 'backfill statement found in migration');
    assert.ok(normalise(smoke).includes(normalise(fromMigration[0])), 'smoke test contains the same statement');
  });

  it('the smoke test covers awaiting, submitted and not_received legacy orders', () => {
    for (const label of ["'legacy'", "'young'", "'lsub'", "'lnr'"]) assert.ok(smoke.includes(label), label);
    assert.match(smoke, /legacy payment_submitted order is untouched/);
    assert.match(smoke, /legacy not_received order keeps its 1 hour retry deadline/);
  });

  it('race scenarios 1 to 3 limit their sweep to their own product', () => {
    const sweeps = races.match(/expire_overdue_orders\('[^']+'(, ARRAY\['[^']+'\]::uuid\[\])?\)/g) ?? [];
    assert.equal(sweeps.length, 3);
    assert.ok(sweeps.every((call) => call.includes('ARRAY')));
    for (const product of ['c1', 'c2', 'c3']) assert.ok(races.includes(`0000000000${product}']::uuid[]`), product);
  });
});
