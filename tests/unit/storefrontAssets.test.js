import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { ACCENTS, ACCENT_KEYS, ON_ACCENT, PAGE_COLORS } from '../../src/domain/palette.js';
import { formatInr } from '../../src/lib/money.js';

const read = (relative) => readFileSync(fileURLToPath(new URL(`../../${relative}`, import.meta.url)), 'utf8');
const css = read('public/css/public.css');
const script = read('public/js/share.js');
const MAX_SCRIPT_BYTES = 6 * 1024;

describe('public stylesheet', () => {
  it('uses only palette colours, so every pair is covered by the contrast tests', () => {
    const allowed = new Set([...Object.values(PAGE_COLORS), ON_ACCENT, ...Object.values(ACCENTS)].map((hex) => hex.toUpperCase()));
    const used = [...css.matchAll(/#[0-9a-fA-F]{6}\b/g)].map((match) => match[0].toUpperCase());
    assert.ok(used.length > 0);
    for (const hex of used) assert.ok(allowed.has(hex), hex);
  });

  it('defines one theme class per accent with the palette value', () => {
    for (const key of ACCENT_KEYS) {
      assert.match(css, new RegExp(`\\.theme-${key} \\{ --accent: ${ACCENTS[key]}; \\}`, 'i'), key);
    }
    assert.match(css, new RegExp(`--page: ${PAGE_COLORS.background};`, 'i'));
    assert.match(css, new RegExp(`--text: ${PAGE_COLORS.text};`, 'i'));
  });

  it('self-hosts script fonts with swap and unicode-range, and makes no third-party requests', () => {
    assert.equal(css.match(/font-display: swap;/g).length, 2);
    assert.equal(css.match(/unicode-range:/g).length, 2);
    assert.ok(css.includes('/fonts/NotoSansGujarati.woff2') && css.includes('/fonts/NotoSansDevanagari.woff2'));
    assert.doesNotMatch(css, /@import|https?:\/\//);
    assert.doesNotMatch(read('src/views/public/layout.ejs'), /<link[^>]+href="https?:/);
  });

  it('respects reduced motion, keeps hidden elements hidden and shows focus', () => {
    assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
    assert.match(css, /\[hidden\] \{ display: none !important; \}/);
    assert.match(css, /:focus-visible/);
    assert.match(css, /overflow-wrap: anywhere/);
    assert.match(css, /aspect-ratio: 1 \/ 1/);
  });
});

describe('share.js', () => {
  it('stays under 6 KB and avoids eval and inline-handler patterns', () => {
    assert.ok(Buffer.byteLength(script) < MAX_SCRIPT_BYTES);
    assert.doesNotMatch(script, /\beval\(|new Function|innerHTML|document\.write/);
  });

  it('uses the Clipboard and Web Share APIs with a fallback and an aria-live announcement', () => {
    for (const piece of ['navigator.clipboard', 'navigator.share', "execCommand('copy')", 'data-share-status', 'window.location.href', 'AbortError']) {
      assert.ok(script.includes(piece), piece);
    }
  });

  it('references only the self-hosted share.js, copy-upi.js and countdown.js scripts in public templates', () => {
    const files = [];
    const walk = (dir) => readdirSync(dir).forEach((name) => (statSync(join(dir, name)).isDirectory() ? walk(join(dir, name)) : files.push(join(dir, name))));
    walk(fileURLToPath(new URL('../../src/views/public', import.meta.url)));
    for (const file of files) {
      const scripts = readFileSync(file, 'utf8').match(/<script[^>]*>/g) ?? [];
      for (const tag of scripts) assert.ok(['<script src="/js/share.js" defer>', '<script src="/js/copy-upi.js" defer>', '<script src="/js/countdown.js" defer>'].includes(tag), `${file}: ${tag}`);
    }
  });
});

describe('formatInr whole-rupee option', () => {
  it('omits .00 only when asked, with Indian grouping', () => {
    assert.equal(formatInr(125000, { omitZeroFraction: true }), '₹1,250');
    assert.equal(formatInr(12500000, { omitZeroFraction: true }), '₹1,25,000');
    assert.equal(formatInr(12550, { omitZeroFraction: true }), '₹125.50');
    assert.equal(formatInr(5, { omitZeroFraction: true }), '₹0.05');
    assert.equal(formatInr(0, { omitZeroFraction: true }), '₹0');
    assert.equal(formatInr(125000), '₹1,250.00');
  });
});
