import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { randomUUID } from 'node:crypto';
import {
  PUBLIC_BASE_URL,
  SECRET_EMAIL,
  SECRET_NUMBER,
  SECRET_UPI,
  createFakePublicRepo,
  startPublicApp,
  translation,
} from '../helpers/publicFakes.js';

const GU_TITLE = 'માટીનો દીવો';
const HI_TITLE = 'मिट्टी का दीया';
const POTLI_TITLE = 'પોટલી બેગ';
const DUPATTA_TITLE = 'દુપટ્ટો';
const allLangs = (gu, hi, en) => ({
  gu: translation(gu, 'હાથે બનાવેલો.', `${gu} ફોટો`),
  ...(hi ? { hi: translation(hi, 'हाथ से बना।', `${hi} फोटो`) } : {}),
  ...(en ? { en: translation(en, 'Hand made.', `${en} photo`) } : {}),
});

/** Gujarati shop (default gu) with four published products, one draft, plus a Hindi shop with one product. */
function seed(repo) {
  const gu = repo.addShop({
    slug: 'mati-no-rang', name: 'માટીનો રંગ', defaultLanguage: 'gu', story: 'અમે માટીના દીવા બનાવીએ છીએ.', tagline: 'હાથે બનાવેલી માટીની વસ્તુઓ',
    whatsappNumber: SECRET_NUMBER, whatsappEnabled: true, instagramHandle: 'mati.no.rang', accentKey: 'indigo',
  });
  const diya = repo.addProduct(gu, { createdAt: '2026-11-10T10:00:00Z', pricePaise: 25000, translations: allLangs(GU_TITLE, HI_TITLE) });
  const potli = repo.addProduct(gu, { createdAt: '2026-11-10T11:00:00Z', pricePaise: 125000, stock: 0, translations: allLangs(POTLI_TITLE) });
  const dupatta = repo.addProduct(gu, {
    createdAt: '2026-11-10T12:00:00Z', pricePaise: 12500000, stock: 3,
    translations: { gu: translation(DUPATTA_TITLE, 'સુંદર.', 'દુપટ્ટો ફોટો'), hi: translation('दुपट्टा', 'सुंदर।', 'दुपट्टा फोटो', false) },
  });
  const extra = repo.addProduct(gu, { createdAt: '2026-11-10T09:00:00Z', pricePaise: 9900, translations: allLangs('વાસણ') });
  const draft = repo.addProduct(gu, { status: 'draft', translations: allLangs('ડ્રાફ્ટ ઉત્પાદન') });
  const hi = repo.addShop({ slug: 'rangrez-hastakala', name: 'रंगरेज़ हस्तकला', defaultLanguage: 'hi', story: 'हम हाथ से रंगते हैं।' });
  const hiProduct = repo.addProduct(hi, { translations: { hi: translation('हाथ की रंगी चुनरी', 'सुंदर।', 'चुनरी का फोटो') } });
  return { gu, hi, diya, potli, dupatta, extra, draft, hiProduct };
}

const productUrl = (shop, product, query = '') => `/s/${shop.slug}/p/${product.id}${query}`;
const metaContent = (html, selector) => new RegExp(`<meta ${selector} content="([^"]*)"`).exec(html)?.[1];
const withApp = (fn, options) => async () => {
  const app = await startPublicApp(options);
  try {
    await fn(app, seed(app.repo));
  } finally {
    await app.close();
  }
};

describe('public storefront: tenancy and 404 behaviour', () => {
  it('shows only published products of the shop, newest first', withApp(async (app, world) => {
    const { text, status } = await app.request('/s/mati-no-rang');
    assert.equal(status, 200);
    assert.ok(!text.includes('ડ્રાફ્ટ ઉત્પાદન'));
    const order = [DUPATTA_TITLE, POTLI_TITLE, GU_TITLE, 'વાસણ'].map((title) => text.indexOf(`>${title}<`));
    assert.ok(order.every((index) => index > 0), JSON.stringify(order));
    assert.deepEqual([...order].sort((a, b) => a - b), order);
    assert.ok(!text.includes(world.hiProduct.id));
  }));

  it('draft, other-shop, bad-id and unknown-slug requests give one identical 404 on all three routes', withApp(async (app, world) => {
    const paths = (suffix) => [
      `/s/mati-no-rang/p/${world.draft.id}${suffix}`,
      `/s/mati-no-rang/p/${world.hiProduct.id}${suffix}`,
      `/s/mati-no-rang/p/not-a-uuid${suffix}`,
      `/s/mati-no-rang/p/${randomUUID()}${suffix}`,
      `/s/no-such-shop/p/${world.diya.id}${suffix}`,
    ];
    const all = [await app.request('/s/no-such-shop'), ...(await Promise.all([...paths(''), ...paths('/image')].map((path) => app.request(path))))];
    for (const response of all) {
      assert.equal(response.status, 404);
      assert.equal(response.text, all[0].text);
      assert.equal(response.headers.get('cache-control'), 'no-store');
    }
    assert.doesNotMatch(all[0].text, /correlation|[0-9a-f]{8}-[0-9a-f]{4}-/i);
  }));

  it('invalid and reserved slugs never reach the repository', withApp(async (app) => {
    for (const slug of ['admin', 'www', 'api', 'internal', 'support', 'ADMIN', '-bad', 'bad-', 'a_b', 'a.b', 'x'.repeat(41)]) {
      for (const suffix of ['', `/p/${randomUUID()}`, `/p/${randomUUID()}/image`]) {
        assert.equal((await app.request(`/s/${slug}${suffix}`)).status, 404, `${slug}${suffix}`);
      }
    }
    assert.deepEqual(app.repo.calls, []);
  }));

  it('redirects an uppercase slug to lowercase with 301 before any lookup', withApp(async (app, world) => {
    const shop = await app.request('/s/Mati-No-Rang?lang=hi');
    assert.equal(shop.status, 301);
    assert.equal(shop.location, '/s/mati-no-rang?lang=hi');
    const image = await app.request(`/s/MATI-NO-RANG/p/${world.diya.id}/image`);
    assert.equal(image.location, `/s/mati-no-rang/p/${world.diya.id}/image`);
    const upper = await app.request('/S/Mati-No-Rang');
    assert.equal(upper.location, '/s/mati-no-rang');
    assert.deepEqual(app.repo.calls, []);
  }));

  it('never loads a session and ignores the session cookie', withApp(async (app, world) => {
    let resolved = 0;
    app.sessions.resolve = async () => (resolved += 1, null);
    const plain = await app.request('/s/mati-no-rang');
    const withCookie = await app.request('/s/mati-no-rang', { cookie: 'session=abc; __Host-session=def' });
    await app.request(productUrl(world.gu, world.diya), { cookie: 'session=abc' });
    assert.equal(resolved, 0);
    assert.equal(withCookie.text, plain.text);
  }));
});

describe('public storefront: sitemap and robots', () => {
  it('lists only shops with a published product plus those products, absolute, ordered, memoised', withApp(async (app, world) => {
    const emptyShop = app.repo.addShop({ slug: 'empty-shop' });
    app.repo.addProduct(emptyShop, { status: 'draft' });
    const res = await app.request('/sitemap.xml');
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /application\/xml/);
    const locs = [...res.text.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => match[1]);
    assert.ok(locs.every((loc) => loc.startsWith(`${PUBLIC_BASE_URL}/s/`)));
    assert.ok(!locs.some((loc) => loc.includes('empty-shop') || loc.includes(world.draft.id)));
    assert.deepEqual(locs.filter((loc) => !loc.includes('/p/')), [`${PUBLIC_BASE_URL}/s/mati-no-rang`, `${PUBLIC_BASE_URL}/s/rangrez-hastakala`]);
    const guProducts = locs.filter((loc) => loc.includes('/s/mati-no-rang/p/'));
    assert.equal(guProducts.length, 4);
    assert.deepEqual(guProducts, [...guProducts].sort());
    assert.equal(locs.length, 7);
    assert.match(res.text, /<lastmod>2026-11-10T08:00:00\.000Z<\/lastmod>/);
    assert.equal((await app.request('/sitemap.xml')).text, res.text);
    assert.equal(app.repo.calls.filter((call) => call === 'listSitemapEntries').length, 1);
    app.clock.now += 10 * 60_000 + 1;
    await app.request('/sitemap.xml');
    assert.equal(app.repo.calls.filter((call) => call === 'listSitemapEntries').length, 2);
  }));

  it('contains no private data', withApp(async (app) => {
    const { text } = await app.request('/sitemap.xml');
    for (const secret of [SECRET_EMAIL, SECRET_UPI, SECRET_NUMBER, '98765', 'owner', 'whatsapp', 'wa.me']) {
      assert.ok(!text.toLowerCase().includes(secret.toLowerCase()), secret);
    }
  }));

  it('serves robots.txt with the disallow rules and an absolute Sitemap line', withApp(async (app) => {
    const res = await app.request('/robots.txt');
    assert.match(res.headers.get('content-type'), /text\/plain/);
    assert.match(res.text, /^Allow: \/s\/$/m);
    for (const path of ['/dashboard', '/products', '/store', '/login', '/signup', '/internal']) {
      assert.ok(res.text.includes(`Disallow: ${path}\n`), path);
    }
    assert.match(res.text, new RegExp(`^Sitemap: ${PUBLIC_BASE_URL}/sitemap\\.xml$`, 'm'));
  }));

  it('renders a noindex coming-soon page for a shop with no published products', withApp(async (app) => {
    const shop = app.repo.addShop({ slug: 'new-shop', name: 'New Shop' });
    app.repo.addProduct(shop, { status: 'draft' });
    const res = await app.request('/s/new-shop');
    assert.equal(res.status, 200);
    assert.match(res.text, /<meta name="robots" content="noindex">/);
    assert.match(res.text, /Coming soon/);
    const full = await app.request('/s/mati-no-rang');
    assert.doesNotMatch(full.text, /noindex/);
  }));
});

describe('public storefront: privacy and escaping', () => {
  it('escapes payloads in every user-controlled field', withApp(async (app) => {
    const payload = (tag) => `<script>alert(${tag})</script>"'&`;
    const shop = app.repo.addShop({
      slug: 'xss-shop', name: payload('name'), tagline: payload('tagline'), story: payload('story'), defaultLanguage: 'en',
      instagramHandle: `x"><script>alert('handle')</script>`, upiId: `${payload('upi')}@bank`,
    });
    const product = app.repo.addProduct(shop, {
      translations: { en: translation(payload('title'), payload('description'), payload('alt')) },
    });
    for (const path of ['/s/xss-shop', `/s/xss-shop/p/${product.id}`]) {
      const { text } = await app.request(path);
      assert.doesNotMatch(text, /<script>alert/);
      assert.match(text, /&lt;script&gt;alert\((name|title)\)/);
      assert.ok(!text.includes('alert(upi)'));
      assert.ok(!text.includes(`alert('handle')</script>`));
    }
    const shopPage = await app.request('/s/xss-shop');
    assert.match(shopPage.text, /&lt;script&gt;alert\(tagline\)/);
    assert.match(shopPage.text, /&lt;script&gt;alert\(story\)/);
    assert.match((await app.request(`/s/xss-shop/p/${product.id}`)).text, /alt="&lt;script&gt;alert\(alt\)/);
  }));

  it('never exposes contact email, UPI id, owner id or the WhatsApp number outside the wa.me link', withApp(async (app, world) => {
    const pages = [await app.request('/s/mati-no-rang'), await app.request(productUrl(world.gu, world.diya))];
    for (const { text } of pages) {
      for (const secret of [SECRET_EMAIL, SECRET_UPI, world.gu.ownerId]) assert.ok(!text.includes(secret), secret);
      const withoutLink = text.replace(/https:\/\/wa\.me\/[0-9]+\?text=[^"]*/g, '');
      for (const number of [SECRET_NUMBER, '98765 43210', '9876543210']) assert.ok(!withoutLink.includes(number), number);
      assert.ok(text.includes(`https://wa.me/${SECRET_NUMBER}?text=`));
    }
  }));

  it('shows no WhatsApp button before the owner opts in, even when a number is stored', withApp(async (app, world) => {
    world.gu.whatsappEnabled = false;
    for (const { text } of [await app.request('/s/mati-no-rang'), await app.request(productUrl(world.gu, world.diya))]) {
      assert.ok(!text.includes('wa.me') && !text.includes(SECRET_NUMBER));
    }
  }));

  it('puts rel on every external link and never links to a draft or foreign product', withApp(async (app, world) => {
    for (const { text } of [await app.request('/s/mati-no-rang'), await app.request(productUrl(world.gu, world.diya))]) {
      const external = [...text.matchAll(/<a [^>]*href="https?:[^"]*"[^>]*>/g)].map((match) => match[0]);
      assert.ok(external.length >= 2);
      for (const tag of external) assert.match(tag, /rel="noopener noreferrer"/);
    }
  }));
});

describe('public storefront: language', () => {
  it('resolves ?lang, then cookie, then Accept-Language, then the shop default', withApp(async (app) => {
    const lang = async (path, headers = {}) => /<html lang="(\w+)"/.exec((await app.request(path, { headers })).text)[1];
    assert.equal(await lang('/s/mati-no-rang'), 'gu');
    assert.equal(await lang('/s/mati-no-rang', { 'accept-language': 'hi-IN,hi;q=0.9,en;q=0.5' }), 'hi');
    assert.equal(await lang('/s/mati-no-rang', { 'accept-language': 'en;q=0.4, hi;q=0.8', cookie: 'lang=en' }), 'en');
    assert.equal(await lang('/s/mati-no-rang?lang=hi', { 'accept-language': 'en', cookie: 'lang=en' }), 'hi');
    assert.equal(await lang('/s/mati-no-rang?lang=fr', { cookie: 'lang=en' }), 'en');
    assert.equal(await lang('/s/mati-no-rang', { cookie: 'lang=fr' }), 'gu');
    assert.equal(await lang('/s/mati-no-rang', { 'accept-language': 'fr,de;q=0.8' }), 'gu');
  }));

  it('sets the lang cookie only for a valid ?lang, with flags that follow BASE_URL, not NODE_ENV', async () => {
    for (const [baseUrl, nodeEnv, secure] of [['https://shop.example.test', 'development', true], ['http://localhost', 'production', false]]) {
      const app = await startPublicApp({ config: { baseUrl, nodeEnv } });
      try {
        seed(app.repo);
        const good = await app.request('/s/mati-no-rang?lang=hi');
        assert.equal(good.setCookie.length, 1);
        const cookie = good.setCookie[0];
        for (const flag of ['lang=hi', 'HttpOnly', 'SameSite=Lax', 'Path=/', 'Max-Age=31536000']) assert.ok(cookie.includes(flag), flag);
        assert.equal(cookie.includes('Secure'), secure);
        assert.equal(/Domain=/i.test(cookie), false);
        assert.deepEqual((await app.request('/s/mati-no-rang?lang=xx')).setCookie, []);
        assert.deepEqual((await app.request('/s/mati-no-rang')).setCookie, []);
      } finally {
        await app.close();
      }
    }
  });

  it('falls back per field with its own lang attribute, and only to approved text', withApp(async (app, world) => {
    const hindi = (await app.request('/s/mati-no-rang?lang=hi')).text;
    assert.match(hindi, new RegExp(`<span class="card-title" lang="hi">${HI_TITLE}</span>`));
    assert.match(hindi, new RegExp(`<span class="card-title" lang="gu">${DUPATTA_TITLE}</span>`));
    assert.ok(!hindi.includes('दुपट्टा'));
    const english = (await app.request('/s/mati-no-rang?lang=en')).text;
    assert.match(english, new RegExp(`<span class="card-title" lang="gu">${GU_TITLE}</span>`));
    const page = (await app.request(productUrl(world.gu, world.diya, '?lang=hi'))).text;
    assert.match(page, new RegExp(`<h1 id="product-title" lang="hi">${HI_TITLE}</h1>`));
    assert.match(page, /<p class="prose" lang="hi">/);
  }));

  it('carries ?lang on internal links only when it differs from the shop default', withApp(async (app, world) => {
    const guPage = (await app.request('/s/mati-no-rang')).text;
    assert.ok(guPage.includes(`href="/s/mati-no-rang/p/${world.diya.id}"`));
    const hiPage = (await app.request('/s/mati-no-rang?lang=hi')).text;
    assert.ok(hiPage.includes(`href="/s/mati-no-rang/p/${world.diya.id}?lang=hi"`));
    const product = (await app.request(productUrl(world.gu, world.diya, '?lang=hi'))).text;
    assert.ok(product.includes('href="/s/mati-no-rang?lang=hi"'));
  }));

  it('renders a switcher of links with lang, hreflang and aria-current', withApp(async (app) => {
    const { text } = await app.request('/s/mati-no-rang?lang=hi');
    for (const lang of ['en', 'gu', 'hi']) {
      assert.match(text, new RegExp(`<a href="/s/mati-no-rang\\?lang=${lang}" lang="${lang}" hreflang="${lang}"`));
    }
    assert.equal(text.match(/aria-current="true"/g).length, 1);
    assert.match(text, /lang="hi" hreflang="hi" aria-current="true"/);
  }));

  it('shows Sold out only at stock 0 and groups prices the Indian way', withApp(async (app, world) => {
    const { text } = await app.request('/s/mati-no-rang');
    assert.equal(text.match(/class="badge"/g).length, 1);
    const card = (product) => new RegExp(`<a class="card-link" href="/s/mati-no-rang/p/${product.id}">([\\s\\S]*?)</a>`).exec(text)[1];
    assert.match(card(world.potli), /પોટલી બેગ/);
    assert.match(card(world.potli), /₹1,250</);
    assert.match(card(world.potli), /વેચાઈ ગયું/);
    assert.match(card(world.dupatta), /₹1,25,000</);
    assert.doesNotMatch(card(world.dupatta), /વેચાઈ ગયું/);
    assert.match(card(world.diya), /₹250</);
    assert.doesNotMatch(text, /\.00/);
    world.diya.pricePaise = 12550;
    assert.match((await app.request('/s/mati-no-rang')).text, /₹125\.50</);
  }));
});

describe('public storefront: previews, links and structure', () => {
  it('emits title, description, canonical and Open Graph tags in the first response', withApp(async (app, world) => {
    const shop = (await app.request('/s/mati-no-rang?lang=hi')).text;
    assert.equal(metaContent(shop, 'property="og:locale"'), 'hi_IN');
    assert.equal(metaContent(shop, 'property="og:url"'), `${PUBLIC_BASE_URL}/s/mati-no-rang?lang=hi`);
    assert.equal(metaContent(shop, 'property="og:image"'), `${PUBLIC_BASE_URL}/s/mati-no-rang/p/${world.dupatta.id}/image`);
    assert.equal(metaContent(shop, 'property="og:type"'), 'website');
    assert.equal(metaContent(shop, 'name="twitter:card"'), 'summary_large_image');
    assert.ok(shop.includes(`<link rel="canonical" href="${PUBLIC_BASE_URL}/s/mati-no-rang?lang=hi">`));
    assert.match(shop, /<title>માટીનો રંગ<\/title>/);
    const product = (await app.request(productUrl(world.gu, world.diya))).text;
    assert.equal(metaContent(product, 'property="og:locale"'), 'gu_IN');
    assert.equal(metaContent(product, 'property="og:type"'), 'product');
    assert.equal(metaContent(product, 'property="og:image"'), `${PUBLIC_BASE_URL}/s/mati-no-rang/p/${world.diya.id}/image`);
    assert.ok(product.includes(`<link rel="canonical" href="${PUBLIC_BASE_URL}/s/mati-no-rang/p/${world.diya.id}">`));
    assert.equal(metaContent((await app.request('/s/rangrez-hastakala')).text, 'property="og:locale"'), 'hi_IN');
    assert.equal(metaContent((await app.request('/s/mati-no-rang?lang=en')).text, 'property="og:locale"'), 'en_IN');
  }));

  it('keeps the meta description under 160 code points with no newlines', withApp(async (app) => {
    const shop = app.repo.addShop({ slug: 'long-story', defaultLanguage: 'en', story: `${'Line one of a long story.\n'.repeat(40)}` });
    app.repo.addProduct(shop);
    const description = metaContent((await app.request('/s/long-story')).text, 'name="description"');
    assert.ok(Array.from(description).length <= 160);
    assert.doesNotMatch(description, /\n/);
  }));

  it('builds a WhatsApp message in the page language naming the shop, the product and the page URL', withApp(async (app, world) => {
    const href = /href="(https:\/\/wa\.me\/[^"]+)"/.exec((await app.request(productUrl(world.gu, world.diya, '?lang=hi'))).text)[1];
    const message = decodeURIComponent(new URL(href).searchParams.get('text'));
    assert.ok(message.startsWith('नमस्ते'));
    assert.ok(message.includes('માટીનો રંગ'));
    assert.ok(message.includes(HI_TITLE));
    assert.ok(message.includes(`${PUBLIC_BASE_URL}/s/mati-no-rang/p/${world.diya.id}?lang=hi`));
  }));

  it('has landmarks, one h1, a skip link, alt text, eager then lazy images and a hidden JS-only share button', withApp(async (app, world) => {
    const { text } = await app.request('/s/mati-no-rang');
    assert.equal(text.match(/<h1[ >]/g).length, 1);
    assert.match(text, /<a class="skip-link" href="#main">/);
    assert.match(text, /<main id="main" tabindex="-1">/);
    assert.match(text, /<header /);
    assert.match(text, /<footer /);
    const images = text.match(/<img [^>]*>/g);
    assert.equal(images.length, 4);
    assert.ok(images.every((tag) => /alt="[^"]+"/.test(tag) && /lang="\w+"/.test(tag)));
    assert.deepEqual(images.map((tag) => /loading="(\w+)"/.exec(tag)[1]), ['eager', 'eager', 'lazy', 'lazy']);
    assert.match(text, /<button type="button" class="button button-secondary" data-share[^>]* hidden>/);
    assert.ok(text.includes('<script src="/js/share.js" defer></script>'));
    const product = (await app.request(productUrl(world.gu, world.diya))).text;
    assert.match(product, /<img class="product-photo"[^>]*fetchpriority="high"/);
    assert.equal(product.match(/<h1[ >]/g).length, 1);
    assert.match(product, /માટીનો રંગ<\/a>/);
  }));

  it('redirects the image route to a fresh signed URL with a short private cache', withApp(async (app, world) => {
    const first = await app.request(`/s/mati-no-rang/p/${world.diya.id}/image`);
    const second = await app.request(`/s/mati-no-rang/p/${world.diya.id}/image`);
    assert.equal(first.status, 302);
    assert.equal(first.headers.get('cache-control'), 'private, max-age=60');
    assert.match(first.location, /^https:\/\/project\.supabase\.test\/storage\/v1\/object\/sign\//);
    assert.notEqual(first.location, second.location);
  }));
});

describe('public storefront: limits', () => {
  it('is not starved by the global limiter, and the image route still returns 429 past its own limit', async () => {
    const appDeps = { globalRateLimit: { windowMs: 60_000, limit: 1 }, publicRateLimits: { image: { windowMs: 60_000, limit: 2 } } };
    const app = await startPublicApp({ appOptions: { appDeps } });
    try {
      const world = seed(app.repo);
      assert.equal((await app.request('/health')).status, 200);
      assert.equal((await app.request('/health')).status, 429);
      for (let index = 0; index < 3; index += 1) assert.equal((await app.request('/s/mati-no-rang')).status, 200);
      const image = `/s/mati-no-rang/p/${world.diya.id}/image`;
      assert.deepEqual([await app.request(image), await app.request(image), await app.request(image)].map((res) => res.status), [302, 302, 429]);
      assert.equal((await app.request('/s/mati-no-rang')).status, 200);
    } finally {
      await app.close();
    }
  });
});

describe('public storefront: failure paths', () => {
  it('answers 404 once a shop is deleted or a product is unpublished after a prior visit', withApp(async (app, world) => {
    assert.equal((await app.request(productUrl(world.gu, world.diya))).status, 200);
    world.diya.status = 'draft';
    assert.equal((await app.request(productUrl(world.gu, world.diya))).status, 404);
    assert.equal((await app.request(`/s/mati-no-rang/p/${world.diya.id}/image`)).status, 404);
    assert.ok(!(await app.request('/s/mati-no-rang')).text.includes(GU_TITLE));
    app.repo.shops.splice(app.repo.shops.indexOf(world.gu), 1);
    assert.equal((await app.request('/s/mati-no-rang')).status, 404);
  }));

  it('shows a friendly page, in the visitor language, when the database is unavailable', withApp(async (app) => {
    app.repo.failures.findShopBySlug = true;
    const res = await app.request('/s/mati-no-rang', { headers: { 'accept-language': 'gu' } });
    assert.equal(res.status, 500);
    assert.match(res.text, /કંઈક ખોટું થયું/);
    assert.match(res.text, /<html lang="gu">/);
    assert.doesNotMatch(res.text, /DATABASE_ERROR|supabase|stack/i);
    assert.equal((await app.request('/sitemap.xml')).status, 200);
  }));

  it('reports a storage failure as a generic 502 and a bad image path as 404 with IDs only in the log', async () => {
    const app = await startPublicApp({ imageOptions: { sign: true } });
    try {
      const world = seed(app.repo);
      const failed = await app.request(`/s/mati-no-rang/p/${world.diya.id}/image`);
      assert.equal(failed.status, 502);
      assert.doesNotMatch(failed.text, /storage/i);
      world.potli.imagePath = `${world.hi.id}/${world.potli.id}/${randomUUID()}.jpg`;
      world.dupatta.imagePath = '';
      for (const product of [world.potli, world.dupatta]) {
        assert.equal((await app.request(`/s/mati-no-rang/p/${product.id}/image`)).status, 404);
      }
      assert.equal(app.warnings.length, 2);
      for (const warning of app.warnings) assert.deepEqual(Object.keys(warning).sort(), ['message', 'productId', 'storeId']);
    } finally {
      await app.close();
    }
  });

  it('skips a published product with no approved translation and logs only IDs', withApp(async (app, world) => {
    const orphan = app.repo.addProduct(world.gu, { translations: { gu: translation('છુપાયેલ', 'x', 'x', false) } });
    const { text } = await app.request('/s/mati-no-rang');
    assert.ok(!text.includes('છુપાયેલ') && !text.includes(orphan.id));
    assert.deepEqual(app.warnings, [{ message: 'published product has no approved translation', storeId: world.gu.id, productId: orphan.id }]);
    assert.equal((await app.request(productUrl(world.gu, orphan))).status, 404);
  }));
});
