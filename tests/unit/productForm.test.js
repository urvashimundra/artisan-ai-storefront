import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { ZodError } from 'zod';
import { reviewFormErrors } from '../../src/controllers/productErrors.js';
import { formatPriceInput, parseReviewForm, stockInputSchema } from '../../src/domain/productForm.js';

const base = {
  story: 'A pot', price: '1,0', stock: '', intent: 'save',
  title_en: 'T', description_en: 'D', alt_text_en: 'A', title_gu: '', description_gu: '', alt_text_gu: '', title_hi: '', description_hi: '', alt_text_hi: '',
};
const read = (path) => readFileSync(fileURLToPath(new URL(`../../${path}`, import.meta.url)), 'utf8');

describe('review form parsing', () => {
  it('turns the flat form into a review with paise, approvals and publish flag', () => {
    const { review, stock } = parseReviewForm({ ...base, price: '499.50', stock: '7', approved_en: 'on', approved_hi: 'on', intent: 'publish', title_hi: 'ह', description_hi: 'ह', alt_text_hi: 'ह' });
    assert.equal(review.price, 49950);
    assert.deepEqual(review.approvedLanguages, ['en', 'hi']);
    assert.equal(review.publish, true);
    assert.equal(stock, 7);
  });

  it('accepts blank price and stock as null', () => {
    const parsed = parseReviewForm({ ...base, price: '' });
    assert.deepEqual([parsed.review.price, parsed.stock], [null, null]);
  });

  it('rejects unknown keys, missing fields, non-string values and a checkbox value other than on', () => {
    const { story: _omitted, ...missing } = base;
    for (const body of [{ ...base, store_id: 'x' }, missing, { ...base, price: 5 }, { ...base, approved_en: 'yes' }, { ...base, intent: 'x' }, null]) {
      assert.throws(() => parseReviewForm(body), ZodError);
    }
  });

  it('stock accepts whole numbers 0 to 1,000,000 only', () => {
    for (const ok of ['0', '12', ' 5 ', '1000000']) assert.ok(Number.isInteger(stockInputSchema.parse(ok)));
    for (const bad of ['-1', '1.5', '1e3', '1000001', 'abc', '12345678']) assert.equal(stockInputSchema.safeParse(bad).success, false, bad);
  });

  it('formats paise back to the text of a price input', () => {
    assert.equal(formatPriceInput(49950), '499.50');
    assert.equal(formatPriceInput(50000), '500');
    assert.equal(formatPriceInput(105), '1.05');
    assert.equal(formatPriceInput(null), '');
  });
});

describe('review error mapping', () => {
  const errorsFor = (body) => {
    try {
      parseReviewForm(body);
    } catch (error) {
      return reviewFormErrors(error);
    }
    return {};
  };

  it('maps price, stock, story and per-language problems to field messages', () => {
    assert.match(errorsFor({ ...base, price: 'x' }).price, /1,000,000/);
    assert.match(errorsFor({ ...base, price: '', intent: 'publish' }).price, /before publishing/);
    assert.match(errorsFor({ ...base, stock: '-1' }).stock, /whole number/);
    assert.match(errorsFor({ ...base, story: 'x'.repeat(2000) }).story, /1500/);
    assert.match(errorsFor({ ...base, approved_gu: 'on' }).gu, /approve this language/);
    assert.match(errorsFor({ ...base, title_en: 'x'.repeat(101) }).en, /lengths/);
  });

  it('rethrows what a normal form cannot produce', () => {
    assert.throws(() => errorsFor({ ...base, store_id: 'x' }), ZodError);
    assert.throws(() => errorsFor({ ...base, intent: 'zzz' }), ZodError);
  });
});

describe('browser upload script', () => {
  const script = read('public/js/product-upload.js');

  it('resizes to 1568 px at JPEG quality 0.85 through a canvas (which drops EXIF and GPS data) with a 4 MB guard', () => {
    assert.match(script, /MAX_SIDE = 1568/);
    assert.match(script, /JPEG_QUALITY = 0.85/);
    assert.match(script, /toBlob\([\s\S]*'image\/jpeg', JPEG_QUALITY/);
    assert.match(script, /MAX_BYTES = 4 \* 1024 \* 1024/);
    assert.match(script, /imageOrientation: 'from-image'/);
  });

  it('is plain browser JavaScript with no third-party origins, eval or innerHTML', () => {
    assert.doesNotMatch(script, /https?:\/\/|eval\(|innerHTML|document\.write|import /);
  });
});
