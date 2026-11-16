import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { MIN_UI_CONTRAST, contrastRatio } from '../../src/domain/contrast.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const read = (relative) => readFileSync(join(ROOT, relative), 'utf8');
const withoutEjsTags = (source) => source.replace(/<%[\s\S]*?%>/g, 'X');
const css = read('public/css/app.css');

function templates(dir) {
  return readdirSync(join(ROOT, dir), { withFileTypes: true }).flatMap((entry) => {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) return templates(path);
    return entry.name.endsWith('.ejs') ? [path] : [];
  });
}

const UNSTYLED_INPUT_TYPES = new Set(['checkbox', 'radio', 'hidden', 'submit', 'file']);

function sharedInputSelector() {
  const rule = css.split('\n').find((line) => line.startsWith('input:not('));
  assert.ok(rule, 'shared input rule exists');
  return rule;
}

function usedInputTypes(source) {
  const tags = source.match(/<input\b[^>]*>/g) ?? [];
  return tags.map((tag) => /\btype="([a-z]+)"/.exec(tag)?.[1] ?? 'text');
}

describe('owner form controls share one style', () => {
  it('every styled input type used in shop-settings.ejs is covered by the shared input selector', () => {
    const selector = sharedInputSelector();
    const types = new Set(usedInputTypes(read('src/views/shop-settings.ejs') + read('src/views/partials/contact-fields.ejs')));
    assert.ok(types.has('tel') && types.has('text'), 'the page uses text and tel inputs');
    for (const type of types) {
      if (UNSTYLED_INPUT_TYPES.has(type)) continue;
      assert.ok(!selector.includes(`[type="${type}"]`), `input type ${type} is excluded from the shared selector`);
    }
    assert.ok(/\bselect\b/.test(selector) && /\btextarea\b/.test(selector));
    for (const type of UNSTYLED_INPUT_TYPES) assert.ok(selector.includes(`[type="${type}"]`), `input type ${type} keeps its own styling`);
  });

  it('the shared rule gives a border, radius, padding, height and font', () => {
    const start = css.indexOf('input:not(');
    const block = css.slice(start, css.indexOf('}', start));
    for (const property of ['border: 2px solid', 'border-radius', 'padding', 'min-height', 'font: inherit']) {
      assert.ok(block.includes(property), property);
    }
  });

  it('keeps a visible 3px focus ring with at least 3:1 contrast and a visible border without colour alone', () => {
    assert.match(css, /input:focus-visible[^{]*\{[^}]*outline: 3px solid var\(--ink\)/);
    const color = (name) => new RegExp(`--${name}: (#[0-9a-f]{6})`, 'i').exec(css)[1];
    assert.ok(contrastRatio(color('ink'), color('paper')) >= MIN_UI_CONTRAST);
    assert.ok(contrastRatio(color('border'), color('paper')) >= MIN_UI_CONTRAST);
  });

});

describe('links between the owner pages and the public shop', () => {
  const ownerTemplates = templates('src/views').filter((path) => !path.startsWith('src/views/public/'));
  const publicTemplates = templates('src/views/public');

  it('every owner link to a public shop page opens in a new tab with noopener noreferrer', () => {
    let found = 0;
    for (const path of ownerTemplates) {
      for (const tag of withoutEjsTags(read(path)).match(/<a\b[^>]*\bhref="\/s\/[^>]*>/g) ?? []) {
        found += 1;
        assert.ok(tag.includes('target="_blank"'), `${path}: ${tag}`);
        assert.ok(tag.includes('rel="noopener noreferrer"'), `${path}: ${tag}`);
      }
    }
    assert.ok(found >= 2, 'dashboard and shop settings both link to the shop');
  });

  it('Shop settings keeps its Back to dashboard link', () => {
    assert.match(read('src/views/shop-settings.ejs'), /<a href="\/dashboard">Back to dashboard<\/a>/);
  });

  it('no public template links to a dashboard or other owner page', () => {
    assert.ok(publicTemplates.length >= 5);
    for (const path of publicTemplates) {
      assert.doesNotMatch(read(path), /href="\/(dashboard|products|store|login|signup|logout)\b/i, path);
      assert.doesNotMatch(read(path), /req\.owner|session|ownerBar|owner-bar/i, path);
    }
  });
});
