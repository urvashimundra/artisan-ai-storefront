import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const read = (relative) => readFileSync(fileURLToPath(new URL(`../../${relative}`, import.meta.url)), 'utf8');
const source = read('public/js/resize.js');
/** Objects made inside the vm sandbox have another realm's prototypes; compare plain copies. */
const plain = (value) => JSON.parse(JSON.stringify(value));

/** Runs the browser script in a sandbox where `module` exists, which is how the file exposes itself to tests. */
function loadResize(globals = {}) {
  const sandbox = { module: { exports: {} }, ...globals };
  vm.runInNewContext(source, sandbox);
  return sandbox.module.exports;
}

describe('fitWithin (pure)', () => {
  const api = loadResize();
  const fitWithin = (...args) => plain(api.fitWithin(...args));

  it('scales a landscape photo so the long side is 1200', () => {
    assert.deepEqual(fitWithin(4000, 3000, 1200), { width: 1200, height: 900 });
  });

  it('scales a portrait photo so the long side is 1200', () => {
    assert.deepEqual(fitWithin(3000, 4000, 1200), { width: 900, height: 1200 });
  });

  it('never enlarges a photo that is already small', () => {
    assert.deepEqual(fitWithin(800, 600, 1200), { width: 800, height: 600 });
    assert.deepEqual(fitWithin(1, 1, 1200), { width: 1, height: 1 });
  });

  it('leaves a photo exactly at the limit unchanged', () => {
    assert.deepEqual(fitWithin(1200, 800, 1200), { width: 1200, height: 800 });
    assert.deepEqual(fitWithin(1200, 1200, 1200), { width: 1200, height: 1200 });
  });

  it('scales squares, extreme panoramas and never returns a zero side', () => {
    assert.deepEqual(fitWithin(2400, 2400, 1200), { width: 1200, height: 1200 });
    assert.deepEqual(fitWithin(12000, 10, 1200), { width: 1200, height: 1 });
  });

  it('uses 1200 px and quality 0.82', () => {
    const api = loadResize();
    assert.equal(api.MAX_SIDE, 1200);
    assert.equal(api.JPEG_QUALITY, 0.82);
  });
});

describe('resizeToJpeg (browser APIs faked)', () => {
  function fakeBrowser({ width, height, blob = { size: 10 }, decodeError } = {}) {
    const record = { bitmapOptions: null, canvas: null, fills: [], draws: [], encode: null, closed: false };
    const context = {
      set fillStyle(value) {
        record.fillStyle = value;
      },
      fillRect: (...args) => record.fills.push(args),
      drawImage: (_bitmap, ...args) => record.draws.push(args),
    };
    const canvas = {
      getContext: () => context,
      toBlob(callback, type, quality) {
        record.encode = { type, quality };
        callback(blob);
      },
    };
    record.canvas = canvas;
    return {
      record,
      globals: {
        createImageBitmap: async (_file, options) => {
          record.bitmapOptions = options;
          if (decodeError) throw decodeError;
          return { width, height, close: () => (record.closed = true) };
        },
        document: { createElement: () => canvas },
        Promise,
      },
    };
  }

  it('decodes with EXIF orientation, draws on white at the fitted size and encodes JPEG at 0.82', async () => {
    const { record, globals } = fakeBrowser({ width: 4000, height: 3000 });
    const result = await loadResize(globals).resizeToJpeg({});
    assert.deepEqual(plain(record.bitmapOptions), { imageOrientation: 'from-image' });
    assert.deepEqual([record.canvas.width, record.canvas.height], [1200, 900]);
    assert.equal(record.fillStyle, '#ffffff');
    assert.deepEqual(plain(record.fills[0]), [0, 0, 1200, 900]);
    assert.deepEqual(plain(record.draws[0]), [0, 0, 1200, 900]);
    assert.deepEqual(plain(record.encode), { type: 'image/jpeg', quality: 0.82 });
    assert.equal(record.closed, true);
    assert.deepEqual(result, { size: 10 });
  });

  it('rejects when the photo cannot be decoded or encoded, so the caller can upload the original', async () => {
    const decode = fakeBrowser({ decodeError: new Error('bad image') });
    await assert.rejects(loadResize(decode.globals).resizeToJpeg({}), /bad image/);
    const encode = fakeBrowser({ width: 10, height: 10, blob: null });
    await assert.rejects(loadResize(encode.globals).resizeToJpeg({}), /encode/);
  });
});

describe('upload page wiring', () => {
  const upload = read('public/js/product-upload.js');

  it('loads resize.js before the upload script, with the allowed script form only', () => {
    const view = read('src/views/product-new.ejs');
    assert.ok(view.indexOf('<script src="/js/resize.js" defer></script>') < view.indexOf('<script src="/js/product-upload.js" defer></script>'));
  });

  it('falls back to the original file when resizing is missing or fails, and keeps the client-side size check', () => {
    assert.match(upload, /if \(!resizer\) return Promise\.resolve\(file\)/);
    assert.match(upload, /\.catch\(function \(\) \{ return file; \}\)/);
    assert.match(upload, /blob\.size > MAX_BYTES/);
    assert.doesNotMatch(upload, /1568/);
  });
});
