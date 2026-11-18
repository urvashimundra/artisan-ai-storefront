import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const css = readFileSync(new URL('../../public/css/public.css', import.meta.url), 'utf8');
const topLevelCount = (selector) => css.split('\n').filter((line) => line.startsWith(`${selector} {`)).length;

describe('public.css foundation', () => {
  for (const selector of [':root', '.grid', '.card', '.site-header', '.brand', '.site-footer']) {
    it(`defines ${selector} once at the top level`, () => {
      assert.equal(topLevelCount(selector), 1);
    });
  }

  it('clips .visually-hidden with a 1px box, overflow hidden and clip-path', () => {
    const block = /\.visually-hidden \{([^}]*)\}/.exec(css)[1];
    for (const needle of ['position: absolute', 'width: 1px', 'height: 1px', 'overflow: hidden', 'clip-path:']) assert.ok(block.includes(needle), needle);
  });

  it('has one prefers-reduced-motion block and a visible focus ring', () => {
    assert.equal(css.split('prefers-reduced-motion').length - 1, 1);
    assert.match(css, /a:focus-visible, button:focus-visible[^{]*\{\s*outline: 3px solid var\(--accent\)/);
  });

  it('keeps the Georgia-first display stack and all six themes', () => {
    assert.match(css, /--font-display: Georgia/);
    for (const key of ['terracotta', 'indigo', 'forest', 'plum', 'teal', 'saffron']) assert.ok(css.includes(`.theme-${key} {`), key);
  });
});
