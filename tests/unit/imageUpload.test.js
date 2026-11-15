import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  MAX_IMAGE_BYTES,
  assertValidImage,
  buildImagePath,
  detectImageType,
  imagePrefix,
  isOwnedImagePath,
} from '../../src/domain/imageUpload.js';

const STORE = '11111111-1111-4111-8111-111111111111';
const PRODUCT = '22222222-2222-4222-8222-222222222222';
const RANDOM = '33333333-3333-4333-8333-333333333333';

const jpeg = (padding = 64) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(padding), Buffer.from([0xff, 0xd9])]);
const png = (padding = 64) =>
  Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(padding),
    Buffer.from([0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]),
  ]);
function webp(padding = 64) {
  const body = Buffer.concat([Buffer.from('WEBP', 'ascii'), Buffer.alloc(padding)]);
  const size = Buffer.alloc(4);
  size.writeUInt32LE(body.length);
  return Buffer.concat([Buffer.from('RIFF', 'ascii'), size, body]);
}

describe('image type detection', () => {
  it('accepts JPEG, PNG and WebP and derives type and extension from the bytes', () => {
    assert.deepEqual(detectImageType(jpeg()), { contentType: 'image/jpeg', extension: 'jpg' });
    assert.deepEqual(detectImageType(png()), { contentType: 'image/png', extension: 'png' });
    assert.deepEqual(detectImageType(webp()), { contentType: 'image/webp', extension: 'webp' });
  });

  it('rejects SVG, GIF, HTML, plain text and RIFF files that are not WebP', () => {
    const rejected = [
      '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'.padEnd(64, ' '),
      'GIF89a'.padEnd(64, '\0'),
      '<!DOCTYPE html><html><body>hi</body></html>'.padEnd(64, ' '),
      'just text '.repeat(10),
    ];
    for (const text of rejected) assert.equal(detectImageType(Buffer.from(text)), null);
    const wave = webp();
    wave.write('WAVE', 8, 'ascii');
    assert.equal(detectImageType(wave), null);
  });

  it('rejects empty, tiny and truncated files', () => {
    assert.equal(detectImageType(Buffer.alloc(0)), null);
    assert.equal(detectImageType(Buffer.from([0xff, 0xd8, 0xff])), null);
    assert.equal(detectImageType(jpeg().subarray(0, 40)), null);
    assert.equal(detectImageType(png().subarray(0, 40)), null);
    assert.equal(detectImageType(webp().subarray(0, 40)), null);
    assert.equal(detectImageType('not a buffer'), null);
  });

  it('ignores a lying client: only bytes matter, so HTML renamed to .jpg is rejected', () => {
    const html = Buffer.from('<html>'.padEnd(64, ' '));
    assert.throws(() => assertValidImage(html), { code: 'INVALID_IMAGE', httpStatus: 415 });
  });
});

describe('assertValidImage', () => {
  it('returns the detected type for a valid image', () => {
    assert.equal(assertValidImage(png()).extension, 'png');
  });

  it('rejects a missing body (express.raw leaves {} when nothing matched) and an empty body', () => {
    assert.throws(() => assertValidImage({}), { code: 'INVALID_IMAGE', httpStatus: 400 });
    assert.throws(() => assertValidImage(Buffer.alloc(0)), { code: 'INVALID_IMAGE', httpStatus: 400 });
  });

  it('enforces the 4 MB limit at the boundary', () => {
    assert.equal(MAX_IMAGE_BYTES, 4 * 1024 * 1024);
    const atLimit = jpeg(MAX_IMAGE_BYTES - 6);
    assert.equal(atLimit.length, MAX_IMAGE_BYTES);
    assert.equal(assertValidImage(atLimit).extension, 'jpg');
    assert.throws(() => assertValidImage(jpeg(MAX_IMAGE_BYTES - 5)), { code: 'IMAGE_TOO_LARGE', httpStatus: 413 });
  });
});

describe('storage paths', () => {
  it('builds {storeId}/{productId}/{randomUUID}.{ext}', () => {
    assert.equal(buildImagePath({ storeId: STORE, productId: PRODUCT, extension: 'webp', randomId: RANDOM }), `${STORE}/${PRODUCT}/${RANDOM}.webp`);
    assert.match(buildImagePath({ storeId: STORE, productId: PRODUCT, extension: 'jpg' }), new RegExp(`^${STORE}/${PRODUCT}/[0-9a-f-]{36}\\.jpg$`));
  });

  it('refuses ids and extensions that could escape the prefix', () => {
    for (const storeId of ['../x', `${STORE}/..`, '', undefined]) {
      assert.throws(() => buildImagePath({ storeId, productId: PRODUCT, extension: 'jpg' }), TypeError);
    }
    assert.throws(() => buildImagePath({ storeId: STORE, productId: '../../etc', extension: 'jpg' }), TypeError);
    assert.throws(() => buildImagePath({ storeId: STORE, productId: PRODUCT, extension: 'svg' }), TypeError);
    assert.throws(() => buildImagePath({ storeId: STORE, productId: PRODUCT, extension: 'jpg/../x' }), TypeError);
    assert.throws(() => buildImagePath({ storeId: STORE, productId: PRODUCT, extension: 'jpg', randomId: '../x' }), TypeError);
  });

  it('recognises only well-formed paths inside the same store and product', () => {
    const own = `${STORE}/${PRODUCT}/${RANDOM}.jpg`;
    assert.equal(isOwnedImagePath(own, STORE, PRODUCT), true);
    assert.equal(isOwnedImagePath(own, PRODUCT, STORE), false);
    assert.equal(isOwnedImagePath(`${STORE}/${PRODUCT}/../${RANDOM}.jpg`, STORE, PRODUCT), false);
    assert.equal(isOwnedImagePath(`${STORE}/${PRODUCT}/${RANDOM}.svg`, STORE, PRODUCT), false);
    assert.equal(isOwnedImagePath(`${STORE}/${PRODUCT}/${RANDOM}.jpg.png`, STORE, PRODUCT), false);
    assert.equal(isOwnedImagePath(null, STORE, PRODUCT), false);
    assert.equal(imagePrefix(STORE, PRODUCT), `${STORE}/${PRODUCT}/`);
  });
});
