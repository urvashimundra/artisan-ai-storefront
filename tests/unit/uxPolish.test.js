import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { ORDER_STRINGS } from '../../src/domain/orderStrings.js';

const read = (relative) => readFileSync(fileURLToPath(new URL(`../../${relative}`, import.meta.url)), 'utf8');
const LANGUAGES = ['en', 'gu', 'hi'];
const MESSAGE = 'Writing your translations\u2026 this takes about 20 seconds. Please keep this page open.';
const publicCss = read('public/css/public.css');
const appCss = read('public/css/app.css');

describe('order strings', () => {
  it('keep the same keys in every language, including the address and quantity strings', () => {
    const keys = Object.keys(ORDER_STRINGS.en).sort();
    for (const language of LANGUAGES) {
      assert.deepEqual(Object.keys(ORDER_STRINGS[language]).sort(), keys, language);
      for (const key of ['errAddress', 'quantityOnlyAvailable', 'quantityHint']) assert.ok(ORDER_STRINGS[language][key].includes(key === 'errAddress' ? '300' : '{max}'), `${language}.${key}`);
    }
  });

  it('no longer promise an enquiry form', () => {
    for (const language of LANGUAGES) assert.equal(ORDER_STRINGS[language].moreThanTwenty, undefined, language);
    assert.ok(!read('src/views/public/checkout.ejs').includes('moreThanTwenty'));
  });
});

describe('generic input styling', () => {
  const rule = (css) => css.match(/(input:not\([^{]+)\{([^}]+)\}/);

  it('has one rule that covers tel, number, url and textarea and excludes checkbox, radio, file and buttons', () => {
    for (const css of [publicCss, appCss]) {
      const [, selector] = rule(css);
      assert.match(selector, /textarea/);
      for (const type of ['checkbox', 'radio', 'file', 'submit', 'button']) assert.ok(selector.includes(`[type="${type}"]`), type);
      for (const type of ['tel', 'number', 'url', 'email', 'password', 'text']) assert.ok(!selector.includes(`[type="${type}"]`), `${type} must not be excluded`);
      assert.doesNotMatch(css, /input\[type="(text|email|tel|password|number|url)"\]\s*[,{]/);
    }
  });

  it('gives public inputs full width, max-width 28rem and a 44px minimum height; owner inputs the same minimum', () => {
    const [, , publicBody] = rule(publicCss);
    assert.match(publicBody, /width: 100%/);
    assert.match(publicBody, /max-width: 28rem/);
    assert.match(publicBody, /min-height: 44px/);
    assert.match(rule(appCss)[2], /min-height: 2\.75rem/);
  });

  it('stacks public labels above inputs', () => {
    assert.match(publicCss, /\.field \{[^}]*flex-direction: column/);
  });
});

describe('dashboard actions', () => {
  it('wrap with a visible gap and never overflow', () => {
    assert.match(appCss, /\.actions \{ display: flex; flex-wrap: wrap; gap: 0\.75rem;/);
    assert.match(appCss, /\.actions > \* \{ max-width: 100%;/);
    const dashboard = read('src/views/dashboard.ejs');
    assert.equal((dashboard.match(/class="actions"/g) ?? []).length, 1);
    for (const href of ['/store/settings', '/products', '/orders']) assert.ok(dashboard.includes(`href="${href}"`), href);
  });
});

describe('orders page styling', () => {
  it('shows status as a text badge and collapses the table to cards on narrow screens', () => {
    assert.match(read('src/views/orders.ejs'), /class="status-badge status-<%= row\.status %>"><%= row\.statusLabel %>/);
    assert.match(appCss, /@media \(max-width: 47\.99rem\)[\s\S]*\.order-table td::before \{ content: attr\(data-label\)/);
  });
});

describe('UPI preview', () => {
  it('is absent from owner settings and onboarding views', () => {
    for (const view of ['shop-settings', 'store-new', 'store-contact', 'store-languages']) {
      assert.doesNotMatch(read(`src/views/${view}.ejs`), /preview|upi-qr|qrcode|<svg/i, view);
    }
  });
});

function runAutosubmit() {
  const state = { submits: 0, focused: 0, attrs: {} };
  const button = { tagName: 'BUTTON', disabled: false, hidden: false };
  const skip = { tagName: 'A', hidden: false };
  const status = { textContent: '', setAttribute() {}, focus() { state.focused += 1; } };
  const form = {
    getAttribute: (name) => state.attrs[name] ?? null,
    hasAttribute: (name) => name in state.attrs,
    setAttribute: (name, value) => { state.attrs[name] = value; },
    querySelectorAll: () => [button, skip],
    submit: () => { state.submits += 1; },
  };
  const document = { querySelector: (selector) => (selector.startsWith('form') ? form : status) };
  const source = read('public/js/autosubmit.js');
  vm.runInNewContext(source, { document });
  vm.runInNewContext(source, { document });
  return { state, button, skip, status };
}

describe('autosubmit.js', () => {
  it('hides the button and skip link, announces progress in the live region and submits exactly once', () => {
    const { state, button, skip, status } = runAutosubmit();
    assert.equal(status.textContent, MESSAGE);
    assert.equal(button.hidden && button.disabled && skip.hidden, true);
    assert.equal(state.focused, 1);
    assert.equal(state.submits, 1);
  });

  it('leaves the no-JavaScript fallback unchanged: visible button and skip link, plain POST form', () => {
    const view = read('src/views/store-languages.ejs');
    assert.match(view, /<form method="post" action="\/store\/new\/languages" class="stack"<%= autosubmit \? ' data-autosubmit' : '' %>>/);
    assert.match(view, /<button type="submit" class="button"><%= aiError \? 'Try again' : 'Write my translations with Claude' %><\/button>/);
    assert.ok(view.includes(`<a href="/dashboard"<%= autosubmit ? ' data-autosubmit-skip' : '' %>>Skip, I will do this later</a>`));
    assert.ok(!view.includes('hidden'));
    assert.ok(!view.includes('<noscript>'));
  });
});