import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createFakePublicRepo, startPublicApp, translation } from '../helpers/publicFakes.js';

const EN = { tagline: 'Hand made in Kutch', story: 'English story of the workshop.' };
const HI = { tagline: 'कच्छ में हस्तनिर्मित', story: 'कार्यशाला की कहानी।' };
const SHOP_NAME = 'માટીનો રંગ';
const metaContent = (html, selector) => new RegExp(`<meta ${selector} content="([^"]*)"`).exec(html)?.[1];

function seed(repo, shopOverrides = {}) {
  const shop = repo.addShop({
    slug: 'mati-no-rang', name: SHOP_NAME, defaultLanguage: 'gu', story: 'અમે માટીના દીવા બનાવીએ છીએ.', tagline: 'હાથે બનાવેલી વસ્તુઓ', ...shopOverrides,
  });
  const product = repo.addProduct(shop, {
    translations: {
      gu: translation('દીવો', 'હાથે બનાવેલો.', 'દીવાનો ફોટો'),
      en: translation('Diya', 'Hand made.', 'Photo of a diya'),
      hi: translation('दीया', 'हाथ से बना।', 'दीये की फोटो'),
    },
  });
  return { shop, product };
}

const addRow = (repo, shop, language, fields, approved = true) =>
  repo.storeTranslations.push({ storeId: shop.id, language, tagline: '', story: '', source: 'owner', approved, ...fields });

const withApp = (fn, options) => async () => {
  const app = await startPublicApp(options);
  try {
    await fn(app, seed(app.repo));
  } finally {
    await app.close();
  }
};

describe('public shop: translated tagline and story', () => {
  it('shows the approved translation with its own lang, and never translates the shop name', withApp(async (app, { shop }) => {
    addRow(app.repo, shop, 'en', EN);
    const { text } = await app.request('/s/mati-no-rang?lang=en');
    assert.ok(text.includes(`<p class="tagline" lang="en">${EN.tagline}</p>`));
    assert.ok(text.includes(`lang="en">${EN.story}</p>`));
    assert.ok(text.includes(`<h1 id="shop-title" lang="gu">${SHOP_NAME}</h1>`));
  }));

  it('falls back to the shop default per field, with the default language as lang on the fallback text', withApp(async (app, { shop }) => {
    addRow(app.repo, shop, 'en', { tagline: EN.tagline, story: '' });
    const { text } = await app.request('/s/mati-no-rang?lang=en');
    assert.ok(text.includes(`<p class="tagline" lang="en">${EN.tagline}</p>`), 'tagline translated');
    assert.ok(text.includes('lang="gu">અમે માટીના દીવા બનાવીએ છીએ.</p>'), 'story falls back to the default with lang gu');
  }));

  it('falls back for a field that is empty in an approved row, and for a language with no row', withApp(async (app, { shop }) => {
    addRow(app.repo, shop, 'en', { tagline: '', story: EN.story });
    const en = (await app.request('/s/mati-no-rang?lang=en')).text;
    assert.ok(en.includes('<p class="tagline" lang="gu">હાથે બનાવેલી વસ્તુઓ</p>'));
    const hi = (await app.request('/s/mati-no-rang?lang=hi')).text;
    assert.ok(hi.includes('<p class="tagline" lang="gu">હાથે બનાવેલી વસ્તુઓ</p>'));
    assert.ok(hi.includes('lang="gu">અમે માટીના'));
  }));

  it('never shows an unapproved or draft row, even when it is the only text in that language', withApp(async (app, { shop }) => {
    addRow(app.repo, shop, 'en', { tagline: 'DRAFT-TAGLINE-XYZ', story: 'DRAFT-STORY-XYZ', source: 'ai' }, false);
    for (const lang of ['en', 'hi', 'gu']) {
      const { text } = await app.request(`/s/mati-no-rang?lang=${lang}`);
      assert.ok(!text.includes('DRAFT-TAGLINE-XYZ') && !text.includes('DRAFT-STORY-XYZ'), lang);
    }
    const product = await app.request(`/s/mati-no-rang/p/${app.repo.products[0].id}?lang=en`);
    assert.ok(!product.text.includes('DRAFT-STORY-XYZ'));
  }));

  it('escapes script payloads in translated tagline and story', withApp(async (app, { shop }) => {
    const payload = '<script>alert(1)</script><img src=x onerror=alert(2)>';
    addRow(app.repo, shop, 'en', { tagline: payload, story: payload });
    for (const path of ['/s/mati-no-rang?lang=en', `/s/mati-no-rang/p/${app.repo.products[0].id}?lang=en`]) {
      const { text } = await app.request(path);
      assert.ok(!text.includes('<script>alert') && !text.includes('<img src=x'), path);
      assert.ok(text.includes('&lt;script&gt;alert(1)&lt;/script&gt;'), path);
    }
  }));

  it('the product page About the maker excerpt and lang follow the language, cut at 300 code points', withApp(async (app, { shop, product }) => {
    addRow(app.repo, shop, 'hi', { story: `${'क'.repeat(299)}😀😀😀` });
    const hi = (await app.request(`/s/mati-no-rang/p/${product.id}?lang=hi`)).text;
    const excerpt = />(क+…)<\/p>/.exec(hi.slice(hi.indexOf('maker-heading')))[1];
    assert.equal(Array.from(excerpt).length, 300);
    assert.match(hi.slice(hi.indexOf('maker-heading')), /<p class="prose" lang="hi">/);
    const gu = (await app.request(`/s/mati-no-rang/p/${product.id}?lang=gu`)).text;
    assert.match(gu.slice(gu.indexOf('maker-heading')), /<p class="prose" lang="gu">અમે માટીના/);
  }));

  it('og:description on the shop page follows the language and never uses an unapproved row', withApp(async (app, { shop }) => {
    addRow(app.repo, shop, 'hi', HI);
    addRow(app.repo, shop, 'en', { tagline: 'HIDDEN', story: 'HIDDEN-STORY' }, false);
    const hi = metaContent((await app.request('/s/mati-no-rang?lang=hi')).text, 'property="og:description"');
    assert.equal(hi, `${HI.tagline} | ${HI.story}`);
    const en = metaContent((await app.request('/s/mati-no-rang?lang=en')).text, 'property="og:description"');
    assert.ok(en.startsWith('હાથે બનાવેલી વસ્તુઓ') && !en.includes('HIDDEN'));
  }));

  it('product pages use the translated shop story and keep the original shop name', withApp(async (app, { shop, product }) => {
    addRow(app.repo, shop, 'en', EN);
    const { text } = await app.request(`/s/mati-no-rang/p/${product.id}?lang=en`);
    assert.ok(text.includes(EN.story));
    assert.ok(text.includes(SHOP_NAME));
  }));

  it('ignores a translation row for the shop default language and reads no rows for it', withApp(async (app, { shop }) => {
    addRow(app.repo, shop, 'gu', { tagline: 'SHOULD-NOT-SHOW', story: 'SHOULD-NOT-SHOW' });
    const { text } = await app.request('/s/mati-no-rang?lang=gu');
    assert.ok(!text.includes('SHOULD-NOT-SHOW'));
    assert.ok(!app.repo.calls.includes('listStoreTranslations'));
    app.repo.calls.length = 0;
    await app.request('/s/mati-no-rang?lang=en');
    assert.ok(app.repo.calls.includes('listStoreTranslations'));
  }));

  it('reads only the rows of the shop being shown', withApp(async (app, { shop }) => {
    const other = app.repo.addShop({ slug: 'other-shop', name: 'Other', defaultLanguage: 'gu', story: 'other' });
    addRow(app.repo, other, 'en', { tagline: 'OTHER-SHOP-TAGLINE', story: 'OTHER-SHOP-STORY' });
    addRow(app.repo, shop, 'en', EN);
    const { text } = await app.request('/s/mati-no-rang?lang=en');
    assert.ok(!text.includes('OTHER-SHOP'));
  }));

});

describe('public shop: product cap', () => {
  const build = (count) => async () => {
    const app = await startPublicApp();
    try {
      const shop = app.repo.addShop({ slug: 'big-shop', name: 'Big', defaultLanguage: 'en' });
      for (let index = 0; index < count; index += 1) {
        const stamp = new Date(Date.UTC(2026, 10, 1, 0, 0, index)).toISOString();
        app.repo.addProduct(shop, { createdAt: stamp, translations: { en: translation(`Item ${index}`, 'd', 'a') } });
      }
      return { app, text: (await app.request('/s/big-shop')).text, hi: (await app.request('/s/big-shop?lang=hi')).text };
    } catch (error) {
      await app.close();
      throw error;
    }
  };
  const cards = (html) => (html.match(/<li class="product-card">/g) ?? []).length;

  it('renders 48 with no note at 48 or fewer products', async () => {
    for (const count of [10, 20, 48]) {
      const { app, text } = await build(count)();
      try {
        assert.equal(cards(text), count);
        assert.ok(!text.includes('Showing the first 48 products'), String(count));
      } finally {
        await app.close();
      }
    }
  });

  it('renders 48 and says so, in the visitor language, when a 49th exists', async () => {
    for (const count of [49, 60]) {
      const { app, text, hi } = await build(count)();
      try {
        assert.equal(cards(text), 48);
        assert.ok(text.includes('Showing the first 48 products'));
        assert.ok(hi.includes('पहले 48 उत्पाद दिखाए जा रहे हैं'));
      } finally {
        await app.close();
      }
    }
  });
});

describe('public repository: translated text is public-safe', () => {
  it('the fake repository mirrors the real one: only approved rows', async () => {
    const repo = createFakePublicRepo();
    const shop = repo.addShop({ defaultLanguage: 'gu' });
    addRow(repo, shop, 'en', EN);
    addRow(repo, shop, 'hi', HI, false);
    assert.deepEqual(Object.keys(await repo.listStoreTranslations(shop.id)), ['en']);
  });
});

describe('public shop: translation lookup failure', () => {
  it('shows the default-language text and logs a warning with IDs only, on the shop page and the product page', withApp(async (app, { shop, product }) => {
    addRow(app.repo, shop, 'en', EN);
    app.repo.failures.listStoreTranslations = true;
    for (const path of ['/s/mati-no-rang?lang=en', `/s/mati-no-rang/p/${product.id}?lang=en`]) {
      const { status, text } = await app.request(path);
      assert.equal(status, 200, path);
      assert.ok(text.includes('અમે માટીના દીવા બનાવીએ છીએ.'), path);
      assert.ok(!text.includes(EN.story) && !text.includes(EN.tagline), path);
    }
    const warnings = app.warnings.filter((entry) => entry.message.startsWith('store translations unavailable'));
    assert.equal(warnings.length, 2);
    for (const entry of warnings) {
      assert.deepEqual(Object.keys(entry).sort(), ['language', 'message', 'storeId']);
      assert.equal(entry.storeId, shop.id);
    }
    assert.ok(!JSON.stringify(warnings).includes('Kutch'));
  }));

  it('still reports a failure of the shop lookup itself as an error page', withApp(async (app) => {
    app.repo.failures.findShopBySlug = true;
    assert.equal((await app.request('/s/mati-no-rang?lang=en')).status, 500);
  }));
});
