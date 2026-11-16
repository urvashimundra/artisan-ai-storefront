import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { MIN_TEXT_CONTRAST, MIN_UI_CONTRAST, contrastRatio } from '../../src/domain/contrast.js';
import {
  isSupportedLanguage,
  parseAcceptLanguage,
  pickField,
  resolveLanguage,
} from '../../src/domain/language.js';
import { ACCENTS, ACCENT_KEYS, ON_ACCENT, PAGE_COLORS, safeAccentKey, themeClass } from '../../src/domain/palette.js';
import { PUBLIC_STRINGS, STRING_KEYS, fillTemplate } from '../../src/domain/publicStrings.js';
import {
  absoluteUrl,
  buildMeta,
  metaDescription,
  ogLocale,
  productImagePath,
  truncateText,
  withLang,
} from '../../src/domain/seo.js';
import { shopSettingsSchema } from '../../src/domain/shopSettings.js';
import { buildWhatsappLink, normalizeWhatsappNumber } from '../../src/domain/whatsapp.js';

describe('contrastRatio', () => {
  it('matches known WCAG values', () => {
    assert.equal(contrastRatio('#000000', '#FFFFFF').toFixed(2), '21.00');
    assert.equal(contrastRatio('#FFFFFF', '#000000').toFixed(2), '21.00');
    assert.equal(contrastRatio('#777777', '#FFFFFF').toFixed(2), '4.48');
    assert.equal(contrastRatio('#123456', '#123456'), 1);
  });
  it('rejects malformed colours', () => {
    assert.throws(() => contrastRatio('red', '#FFFFFF'), TypeError);
    assert.throws(() => contrastRatio('#FFF', '#FFFFFF'), TypeError);
  });
});

describe('palette contrast (every pair the stylesheet uses)', () => {
  it('has the six agreed keys and a safe fallback', () => {
    assert.deepEqual([...ACCENT_KEYS], ['terracotta', 'indigo', 'forest', 'plum', 'teal', 'saffron']);
    assert.equal(safeAccentKey('nope'), 'terracotta');
    assert.equal(themeClass('teal'), 'theme-teal');
    assert.equal(themeClass('"><script>'), 'theme-terracotta');
  });
  for (const key of ACCENT_KEYS) {
    it(`${key}: button text, accent text, focus outline`, () => {
      const accent = ACCENTS[key];
      assert.ok(contrastRatio(ON_ACCENT, accent) >= MIN_TEXT_CONTRAST, 'on-accent text on accent button');
      assert.ok(contrastRatio(accent, PAGE_COLORS.background) >= MIN_TEXT_CONTRAST, 'accent text on page');
      assert.ok(contrastRatio(accent, PAGE_COLORS.surface) >= MIN_TEXT_CONTRAST, 'accent text on card surface');
      assert.ok(contrastRatio(accent, PAGE_COLORS.background) >= MIN_UI_CONTRAST, 'focus outline on page');
    });
  }
  it('body and muted text pass on page and surface', () => {
    for (const background of [PAGE_COLORS.background, PAGE_COLORS.surface]) {
      assert.ok(contrastRatio(PAGE_COLORS.text, background) >= MIN_TEXT_CONTRAST);
      assert.ok(contrastRatio(PAGE_COLORS.muted, background) >= MIN_TEXT_CONTRAST);
    }
  });
});

describe('language resolution', () => {
  const base = { shopDefault: 'gu' };
  it('prefers ?lang, then cookie, then Accept-Language, then shop default', () => {
    assert.deepEqual(resolveLanguage({ ...base, query: 'hi', cookie: 'en', acceptLanguage: 'en' }), { language: 'hi', fromQuery: true });
    assert.deepEqual(resolveLanguage({ ...base, cookie: 'en', acceptLanguage: 'hi' }), { language: 'en', fromQuery: false });
    assert.deepEqual(resolveLanguage({ ...base, acceptLanguage: 'hi-IN,en;q=0.5' }), { language: 'hi', fromQuery: false });
    assert.deepEqual(resolveLanguage({ ...base }), { language: 'gu', fromQuery: false });
  });
  it('ignores invalid values at every step', () => {
    const result = resolveLanguage({ ...base, query: ['hi', 'en'], cookie: 'fr', acceptLanguage: 'zz,;;;' });
    assert.deepEqual(result, { language: 'gu', fromQuery: false });
    assert.equal(resolveLanguage({ ...base, query: 'EN' }).fromQuery, false);
    assert.equal(isSupportedLanguage('constructor'), false);
    assert.equal(isSupportedLanguage(undefined), false);
  });
  it('honours q-values, drops q=0, and bounds the header', () => {
    assert.deepEqual(parseAcceptLanguage('en;q=0.5, gu;q=0.9, hi;q=0'), ['gu', 'en']);
    assert.deepEqual(parseAcceptLanguage('gu-IN, gu;q=0.8, en'), ['gu', 'en']);
    assert.deepEqual(parseAcceptLanguage('en;q=banana'), []);
    assert.deepEqual(parseAcceptLanguage('x'.repeat(400)), []);
    assert.deepEqual(parseAcceptLanguage(undefined), []);
  });
});

describe('pickField', () => {
  const translations = {
    gu: { approved: true, title: 'દીવો' },
    hi: { approved: false, title: 'दीया' },
    en: { approved: true, title: '   ' },
  };
  it('uses the visitor language only when approved and non-empty', () => {
    assert.deepEqual(pickField(translations, 'title', 'gu', 'gu'), { text: 'દીવો', lang: 'gu' });
    assert.deepEqual(pickField(translations, 'title', 'hi', 'gu'), { text: 'દીવો', lang: 'gu' });
    assert.deepEqual(pickField(translations, 'title', 'en', 'gu'), { text: 'દીવો', lang: 'gu' });
  });
  it('returns null when nothing is approved', () => {
    assert.equal(pickField({ gu: { approved: false, title: 'x' } }, 'title', 'gu', 'gu'), null);
    assert.equal(pickField(undefined, 'title', 'en', 'gu'), null);
  });
});

describe('publicStrings completeness', () => {
  it('has the same non-empty keys in every language', () => {
    assert.ok(STRING_KEYS.length >= 20);
    for (const language of ['en', 'gu', 'hi']) {
      assert.deepEqual(Object.keys(PUBLIC_STRINGS[language]).sort(), [...STRING_KEYS].sort(), language);
      for (const key of STRING_KEYS) {
        assert.ok(PUBLIC_STRINGS[language][key].trim().length > 0, `${language}.${key} empty`);
      }
    }
  });
  it('keeps placeholders identical and uses the right script', () => {
    const placeholders = (text) => (text.match(/\{\w+\}/g) ?? []).sort().join();
    for (const key of STRING_KEYS) {
      assert.equal(placeholders(PUBLIC_STRINGS.gu[key]), placeholders(PUBLIC_STRINGS.en[key]), key);
      assert.equal(placeholders(PUBLIC_STRINGS.hi[key]), placeholders(PUBLIC_STRINGS.en[key]), key);
    }
    assert.match(PUBLIC_STRINGS.gu.soldOut, /\p{Script=Gujarati}/u);
    assert.match(PUBLIC_STRINGS.hi.soldOut, /\p{Script=Devanagari}/u);
  });
  it('fills templates literally', () => {
    assert.equal(fillTemplate('{a} & {b} {c}', { a: '$&', b: '{a}' }), '$& & {a} {c}');
  });
});

describe('whatsapp', () => {
  it('normalises the accepted formats', () => {
    assert.equal(normalizeWhatsappNumber('98765 43210'), '919876543210');
    assert.equal(normalizeWhatsappNumber('+91 98765 43210'), '919876543210');
    assert.equal(normalizeWhatsappNumber('(98765) 43210'), '919876543210');
    assert.equal(normalizeWhatsappNumber('919876543210'), '919876543210');
    assert.equal(normalizeWhatsappNumber('+44 7911 123456'), '447911123456');
  });
  it('rejects unusable input', () => {
    for (const bad of ['', '12345', '98765abcde', '+1234567890123456', '9876543210x', '98765-4321x', undefined, 5, '9'.repeat(40)]) {
      assert.equal(normalizeWhatsappNumber(bad), null, String(bad));
    }
  });
  it('encodes Gujarati, Hindi, ampersand, hash and spaces in the link', () => {
    const message = 'નમસ્તે & नमस्ते #1 a b';
    const link = buildWhatsappLink('919876543210', message);
    assert.ok(link.startsWith('https://wa.me/919876543210?text='));
    assert.doesNotMatch(link.split('?text=')[1], /[ &#]/);
    assert.equal(decodeURIComponent(link.split('?text=')[1]), message);
  });
  it('refuses a malformed stored number', () => {
    assert.throws(() => buildWhatsappLink('+91 1', 'x'), { code: 'INVALID_WHATSAPP_NUMBER' });
  });
});

describe('seo helpers', () => {
  it('limits descriptions to 160 code points without newlines, cutting on grapheme boundaries', () => {
    const long = `${'કાળજીથી '.repeat(60)}\n\nend`;
    const out = metaDescription(long);
    assert.ok(Array.from(out).length <= 160);
    assert.doesNotMatch(out, /\n/);
    assert.ok(out.endsWith('…'));
    assert.equal(metaDescription('  short \n text '), 'short text');
    assert.doesNotMatch(out.slice(0, -1), /\s$/);
  });
  it('truncates by code points, not UTF-16 units', () => {
    const emoji = '😀'.repeat(400);
    assert.equal(Array.from(truncateText(emoji, 300)).length, 300);
  });
  it('adds ?lang only when it differs from the shop default', () => {
    assert.equal(withLang('/s/x', 'gu', 'gu'), '/s/x');
    assert.equal(withLang('/s/x', 'hi', 'gu'), '/s/x?lang=hi');
    assert.equal(withLang('/s/x', 'xx', 'gu'), '/s/x');
  });
  it('builds absolute URLs and stable image paths', () => {
    assert.equal(absoluteUrl('https://shop.example', '/s/a'), 'https://shop.example/s/a');
    assert.equal(productImagePath('a', 'id1'), '/s/a/p/id1/image');
    assert.equal(ogLocale('gu'), 'gu_IN');
  });
  it('builds head metadata with noindex for empty shops', () => {
    const meta = buildMeta({
      title: 'T', description: 'D', path: '/s/a?lang=hi', imagePath: '/s/a/p/1/image', language: 'hi',
      baseUrl: 'https://shop.example', type: 'website', indexable: false, siteName: 'T',
    });
    assert.equal(meta.canonical, 'https://shop.example/s/a?lang=hi');
    assert.equal(meta.ogImage, 'https://shop.example/s/a/p/1/image');
    assert.equal(meta.ogLocale, 'hi_IN');
    assert.equal(meta.robots, 'noindex');
    assert.equal(meta.twitterCard, 'summary_large_image');
  });
});

describe('shopSettingsSchema', () => {
  const valid = { tagline: ' Handmade  clay ', accentKey: 'teal', whatsappNumber: '98765 43210', whatsappEnabled: 'on', instagramHandle: '@mati.rang', upiId: ' asha@okhdfc ' };
  it('normalises valid input', () => {
    assert.deepEqual(shopSettingsSchema.parse(valid), {
      tagline: 'Handmade clay', accentKey: 'teal', whatsappNumber: '919876543210', whatsappEnabled: true,
      instagramHandle: 'mati.rang', upiId: 'asha@okhdfc',
    });
  });
  it('turns empty optionals into null and an absent checkbox into false', () => {
    const out = shopSettingsSchema.parse({ tagline: '', accentKey: 'plum', whatsappNumber: '', instagramHandle: '', upiId: '' });
    assert.deepEqual(out, { tagline: '', accentKey: 'plum', whatsappNumber: null, whatsappEnabled: false, instagramHandle: null, upiId: null });
  });
  it('rejects unknown keys, including store_id', () => {
    assert.equal(shopSettingsSchema.safeParse({ ...valid, store_id: 'x' }).success, false);
    assert.equal(shopSettingsSchema.safeParse({ ...valid, storeId: 'x' }).success, false);
  });
  it('rejects bad values', () => {
    const bad = [
      { tagline: 'x'.repeat(121) }, { accentKey: 'red' }, { whatsappNumber: '123' }, { instagramHandle: 'a b' },
      { instagramHandle: 'x'.repeat(31) }, { upiId: 'nohandle' }, { upiId: 'a b@bank' }, { whatsappEnabled: 'yes' },
      { whatsappNumber: '', whatsappEnabled: 'on' },
    ];
    for (const patch of bad) assert.equal(shopSettingsSchema.safeParse({ ...valid, ...patch }).success, false, JSON.stringify(patch));
  });
  it('counts the tagline limit in code points', () => {
    assert.equal(shopSettingsSchema.safeParse({ ...valid, tagline: 'અ'.repeat(120) }).success, true);
    assert.equal(shopSettingsSchema.safeParse({ ...valid, tagline: 'અ'.repeat(121) }).success, false);
  });
  it('strips newlines from the tagline', () => {
    assert.equal(shopSettingsSchema.parse({ ...valid, tagline: 'a\nb' }).tagline, 'a b');
  });
});
