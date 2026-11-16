import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { QR_QUIET_ZONE_MODULES, qrPath } from '../../src/domain/qrMatrix.js';
import { buildUpiUri, isValidVpa, upiAmount } from '../../src/domain/upi.js';

const base = { vpa: 'asha.patel@okbank', name: 'Asha Pottery', orderRef: 'AS1001' };

describe('upiAmount (integer paise, padded)', () => {
  it('formats small, round and large amounts exactly', () => {
    assert.equal(upiAmount(5), '0.05');
    assert.equal(upiAmount(10000), '100.00');
    assert.equal(upiAmount(123456789), '1234567.89');
    assert.equal(upiAmount(100), '1.00');
    assert.equal(upiAmount(99), '0.99');
  });

  it('rejects zero, negative, fractional and unsafe amounts', () => {
    for (const bad of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '100']) {
      assert.throws(() => upiAmount(bad), { code: 'INVALID_AMOUNT' });
    }
  });
});

describe('buildUpiUri', () => {
  it('builds the link with pa, pn, am, cu and tn, and no tr', () => {
    const uri = buildUpiUri({ ...base, amountPaise: 10000 });
    assert.equal(uri, 'upi://pay?pa=asha.patel%40okbank&pn=Asha%20Pottery&am=100.00&cu=INR&tn=AS1001');
    assert.doesNotMatch(uri, /[?&]tr=/);
  });

  it('covers the three amounts from the brief', () => {
    assert.match(buildUpiUri({ ...base, amountPaise: 5 }), /&am=0\.05&/);
    assert.match(buildUpiUri({ ...base, amountPaise: 10000 }), /&am=100\.00&/);
    assert.match(buildUpiUri({ ...base, amountPaise: 123456789 }), /&am=1234567\.89&/);
  });

  it('percent-encodes every value, so a hostile name cannot add parameters', () => {
    const uri = buildUpiUri({ ...base, name: 'A&B=C#D?E ગુજ', amountPaise: 100 });
    assert.equal(new URL(uri).searchParams.get('pn'), 'A&B=C#D?E ગુજ');
    assert.equal(uri.split('&').length, 5);
    assert.equal(uri.includes(' '), false);
  });

  it('rejects an invalid VPA, empty name or reference, and bad amounts', () => {
    assert.throws(() => buildUpiUri({ ...base, vpa: 'nope', amountPaise: 100 }), { code: 'INVALID_UPI' });
    assert.throws(() => buildUpiUri({ ...base, vpa: 'a@b&pa=evil@x', amountPaise: 100 }), { code: 'INVALID_UPI' });
    assert.throws(() => buildUpiUri({ ...base, name: '', amountPaise: 100 }), { code: 'INVALID_UPI' });
    assert.throws(() => buildUpiUri({ ...base, orderRef: '', amountPaise: 100 }), { code: 'INVALID_UPI' });
    assert.throws(() => buildUpiUri({ ...base, amountPaise: 0 }), { code: 'INVALID_AMOUNT' });
  });
});

describe('isValidVpa', () => {
  it('accepts name@handle and rejects everything else', () => {
    for (const ok of ['asha.patel-1@okhdfcbank', '9876543210@ybl']) assert.equal(isValidVpa(ok), true, ok);
    const bad = ['name', 'name@', '@bank', 'a@bank', 'na me@bank', 'a.b@c@d', 'name@bank\n', undefined, null, 5, `${'a'.repeat(60)}@${'b'.repeat(60)}`];
    for (const value of bad) assert.equal(isValidVpa(value), false, String(value));
  });
});

describe('qrPath', () => {
  it('returns geometry only: a size and a path of squares', () => {
    const { size, path } = qrPath(buildUpiUri({ ...base, amountPaise: 100 }));
    assert.ok(size > QR_QUIET_ZONE_MODULES * 2);
    assert.match(path, /^(M\d+ \d+h1v1h-1z)+$/);
  });

  it('is deterministic', () => {
    assert.deepEqual(qrPath('hello'), qrPath('hello'));
  });
});
