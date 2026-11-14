import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { formatInr, toPaise } from '../../src/lib/money.js';

describe('toPaise', () => {
  it('converts normal amounts without float error', () => {
    assert.equal(toPaise(19.99), 1999);
    assert.equal(toPaise('1.1'), 110);
    assert.equal(toPaise(0.29), 29);
    assert.equal(toPaise('499'), 49900);
    assert.equal(toPaise(' 12.50 '), 1250);
  });

  it('handles zero', () => {
    assert.equal(toPaise(0), 0);
    assert.equal(toPaise('0.00'), 0);
  });

  it('rejects invalid input', () => {
    const invalid = [NaN, Infinity, -Infinity, -1, '-0.5', 1.234, '1.005', '', 'abc', '1e3', 1e21, null, undefined, {}, '1,000'];
    for (const value of invalid) {
      assert.throws(() => toPaise(value), { code: 'INVALID_AMOUNT' }, String(value));
    }
  });

  it('rejects amounts beyond the safe integer range', () => {
    assert.equal(toPaise('90071992547409.91'), Number.MAX_SAFE_INTEGER);
    assert.throws(() => toPaise('90071992547409.92'), { code: 'INVALID_AMOUNT' });
    assert.throws(() => toPaise('99999999999999999999'), { code: 'INVALID_AMOUNT' });
  });
});

describe('formatInr', () => {
  it('formats with Indian grouping and two decimals', () => {
    assert.equal(formatInr(0), '₹0.00');
    assert.equal(formatInr(5), '₹0.05');
    assert.equal(formatInr(99900), '₹999.00');
    assert.equal(formatInr(123456), '₹1,234.56');
    assert.equal(formatInr(12345678), '₹1,23,456.78');
    assert.equal(formatInr(1234567890), '₹1,23,45,678.90');
  });

  it('rejects non-integers, negatives and unsafe integers', () => {
    for (const value of [1.5, -1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '100', null]) {
      assert.throws(() => formatInr(value), { code: 'INVALID_AMOUNT' }, String(value));
    }
  });

  it('round-trips with toPaise', () => {
    assert.equal(toPaise('1234.56'), 123456);
    assert.equal(formatInr(toPaise('1234.56')), '₹1,234.56');
  });
});
