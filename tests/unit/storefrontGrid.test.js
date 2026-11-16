import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const css = readFileSync(fileURLToPath(new URL('../../public/css/public.css', import.meta.url)), 'utf8');

/** Text of the first rule whose selector is exactly `selector`. */
function rule(selector) {
  const start = css.indexOf(`${selector} {`);
  assert.ok(start >= 0, `rule ${selector}`);
  return css.slice(start, css.indexOf('}', start));
}

describe('product grid CSS', () => {
  it('uses auto-fill with a minmax track so it adapts from 320 px to 1280 px for any number of products', () => {
    assert.match(rule('.grid'), /grid-template-columns: repeat\(auto-fill, minmax\(min\(100%, var\(--card-min\)\), 1fr\)\)/);
    assert.match(css, /--card-min: 8rem/);
  });

  it('lets grid items shrink and wraps long titles, so nothing overflows at 320 px', () => {
    assert.match(css, /\.grid > li \{ min-width: 0; \}/);
    assert.match(rule('.card'), /min-width: 0/);
    assert.match(rule('.card-title'), /overflow-wrap: anywhere/);
  });

  it('keeps equal-height rows through a square image box', () => {
    assert.match(rule('.card-link img'), /aspect-ratio: 1 \/ 1/);
    assert.match(rule('.card-link'), /height: 100%/);
    assert.doesNotMatch(css, /\.grid \{[^}]*align-items: (start|center|end)/);
  });

  it('does not force a fixed column count at any breakpoint', () => {
    assert.doesNotMatch(css, /grid-template-columns: repeat\(\d/);
  });

  it('separates the product photo from its title', () => {
    assert.match(rule('.product-photo'), /margin-bottom: 1rem/);
    assert.match(rule('.product-photo'), /display: block/);
  });

  it('every column minimum leaves at least two columns at 320 px (288 px of content)', () => {
    const smallest = Number(/--card-min: (\d+(?:\.\d+)?)rem/.exec(css)[1]) * 16;
    assert.ok(smallest * 2 + 12 <= 288, `${smallest}px`);
  });
});
