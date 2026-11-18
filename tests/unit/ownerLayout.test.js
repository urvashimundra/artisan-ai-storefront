import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const css = readFileSync(new URL('../../public/css/app.css', import.meta.url), 'utf8');

/** Returns the declaration block of the first rule whose selector starts with the given text. */
function block(selector) {
  const start = css.indexOf(`\n${selector}`);
  assert.notEqual(start, -1, selector);
  return css.slice(start, css.indexOf('}', start));
}

describe('owner layout width', () => {
  it('has no 44rem or 82rem cap left', () => {
    assert.doesNotMatch(css, /44rem|82rem/);
  });

  it('defines one owner width token and a form measure', () => {
    assert.match(css, /--owner-width: 80rem/);
    assert.match(css, /--measure-form: 40rem/);
    assert.match(block('.measure-form'), /max-width: var\(--measure-form\)/);
  });

  it('header, main and footer share the width token and the gutter', () => {
    for (const selector of ['main {', '.site-footer {', '.main-wide {']) {
      assert.match(block(selector), /max-width: var\(--owner-width\)/, selector);
    }
    assert.match(block('.site-header { padding-inline'), /var\(--owner-width\)/);
    assert.match(block('.site-header { padding-inline'), /var\(--gutter\)/);
    assert.match(block('main {'), /var\(--gutter\)/);
    assert.match(block('.site-footer {'), /var\(--gutter\)/);
  });
});

describe('visually hidden text', () => {
  it('stays in the page but clipped to a 1px absolute box', () => {
    const rule = block('.visually-hidden');
    for (const part of [/position: absolute/, /width: 1px/, /height: 1px/, /overflow: hidden/, /clip-path: inset\(50%\)/]) assert.match(rule, part);
    assert.doesNotMatch(rule, /display: none|visibility: hidden/);
  });

  it('tables are a containing block so hidden header text cannot widen the page', () => {
    assert.match(block('.table-wrap'), /position: relative/);
  });
});

describe('badge inside a button', () => {
  const token = (name) => new RegExp(`--${name}: (#[0-9a-fA-F]{6})`).exec(css)[1];

  it('meets text and non-text contrast on the button and its hover colour', async () => {
    const { contrastRatio, MIN_TEXT_CONTRAST, MIN_UI_CONTRAST } = await import('../../src/domain/contrast.js');
    const rule = block('.button .badge');
    assert.match(rule, /color: var\(--ink\)/);
    assert.match(rule, /background: var\(--paper\)/);
    assert.match(rule, /border-color: var\(--paper\)/);
    assert.ok(contrastRatio(token('ink'), token('paper')) >= MIN_TEXT_CONTRAST);
    for (const accent of ['accent', 'accent-strong']) {
      assert.ok(contrastRatio(token('paper'), token(accent)) >= MIN_UI_CONTRAST, accent);
    }
  });
});

describe('disabled buttons', () => {
  it('are muted, not-allowed, and legible for every variant', () => {
    const rule = block('.button:disabled');
    assert.match(rule, /\.button\[aria-disabled="true"\]/);
    assert.match(rule, /cursor: not-allowed/);
    assert.match(rule, /color: var\(--neutral-ink\)/);
    assert.match(rule, /background: var\(--neutral-soft\)/);
    assert.ok(css.indexOf('.button:disabled') > css.indexOf('.button-danger:hover'), 'placed after the hover rules so it wins');
  });
});
