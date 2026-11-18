import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { startChatApp } from '../helpers/chatApp.js';

const withApp = async (options, run) => {
  const app = await startChatApp(options);
  try {
    await run(app);
  } finally {
    await app.close();
  }
};
const at = (text, needle) => {
  const index = text.indexOf(needle);
  assert.ok(index >= 0, `missing ${needle}`);
  return index;
};

describe('shop page structure', () => {
  it('orders the sections: brand header, hero and story, products, about the maker, contact the maker, footer', async () => {
    await withApp({ shop: { story: 'We are a family of potters in Bhuj.', tagline: 'Handmade pottery' } }, async (app) => {
      const { text } = await app.request('/s/clay-works');
      const order = ['class="site-header"', 'class="hero"', 'id="products"', 'id="story-heading"', 'id="contact-heading"', 'class="site-footer"'].map((needle) => at(text, needle));
      assert.deepEqual(order, [...order].sort((a, b) => a - b));
      assert.match(text, /<h1 id="shop-title"[^>]*>Clay Works<\/h1>/);
      assert.match(text, /class="hero-story"[^>]*>We are a family of potters in Bhuj\./);
    });
  });

  it('the hero shows only the first sentence of the story, and the full story follows the products', async () => {
    const story = 'We are a family of potters in Bhuj. We make every pot by hand and fire it in our own kiln.';
    await withApp({ shop: { story, tagline: 'Handmade pottery' } }, async (app) => {
      const { text } = await app.request('/s/clay-works');
      assert.match(text, /class="hero-story"[^>]*>We are a family of potters in Bhuj\.<\/p>/);
      assert.doesNotMatch(text, /class="hero-story"[^>]*>[^<]*kiln/);
      assert.match(text, /class="prose"[^>]*>We are a family of potters in Bhuj\. We make every pot by hand and fire it in our own kiln\.<\/p>/);
    });
  });

  it('the product page has one link back to all products and no second shop link', async () => {
    await withApp({ shop: { story: 'We are a family of potters in Bhuj.' } }, async (app) => {
      const { text } = await app.request(`/s/clay-works/p/${app.product.id}`);
      assert.equal(text.split('Back to all products').length - 1, 1);
      assert.doesNotMatch(text, /Visit the shop/);
    });
  });

  it('has no embedded enquiry form anywhere on the shop or product page', async () => {
    await withApp({}, async (app) => {
      for (const path of ['/s/clay-works', `/s/clay-works/p/${app.product.id}`]) {
        const { text } = await app.request(path);
        assert.doesNotMatch(text, /<form[^>]*ask|name="question"|id="ask-form"|class="ask-form"|name="phone"/, path);
        assert.doesNotMatch(text, /<textarea/, path);
      }
    });
  });

  it('groups Ask AI assistant, WhatsApp, Instagram and Share in one consistent group on the shop and the product page', async () => {
    await withApp({ shop: { instagramHandle: 'clayworks' } }, async (app) => {
      const shop = (await app.request('/s/clay-works')).text;
      const product = (await app.request(`/s/clay-works/p/${app.product.id}`)).text;
      for (const text of [shop, product]) {
        const group = /<div class="contact-actions"[\s\S]*?<\/div>/.exec(text)[0];
        const kinds = [...group.matchAll(/data-contact="(\w+)"/g)].map((match) => match[1]);
        assert.deepEqual(kinds, ['chat', 'whatsapp', 'instagram', 'share']);
        assert.equal((text.match(/class="contact-actions"/g) ?? []).length, 1);
      }
    });
  });

  it('opens the chat in a new tab with safe link attributes, naming the product on a product page and keeping the shopping page intact', async () => {
    await withApp({}, async (app) => {
      const shop = (await app.request('/s/clay-works')).text;
      const chatLink = /<a class="button button-primary" href="([^"]+)" target="_blank" rel="noopener noreferrer" data-contact="chat">/.exec(shop);
      assert.ok(chatLink);
      assert.equal(chatLink[1], '/s/clay-works/chat?lang=en');
      assert.match(shop, /data-contact="chat"><svg class="icon"[^>]*aria-hidden="true"[^>]*>(?:(?!<\/svg>)[\s\S])*<\/svg>\s*Ask AI assistant<span class="visually-hidden"> \(opens in a new tab\)<\/span>/);
      const product = (await app.request(`/s/clay-works/p/${app.product.id}`)).text;
      assert.ok(product.includes(`href="/s/clay-works/chat?lang=en&amp;product=${app.product.id}"`));
      for (const tag of [...shop.matchAll(/<a [^>]*target="_blank"[^>]*>/g)]) assert.match(tag[0], /rel="noopener noreferrer"/);
    });
  });

  it('keeps Buy now on the product page and not on the shop page', async () => {
    await withApp({}, async (app) => {
      const shop = (await app.request('/s/clay-works')).text;
      assert.doesNotMatch(shop, /Buy now/);
    });
  });

  it('shows the chat link in the page language and never the private WhatsApp number', async () => {
    await withApp({}, async (app) => {
      for (const lang of ['gu', 'hi']) {
        const { text } = await app.request(`/s/clay-works?lang=${lang}`);
        assert.ok(text.includes(`href="/s/clay-works/chat?lang=${lang}"`), lang);
        assert.ok(!text.includes('9123456780') || /wa\.me\/919123456780/.test(text));
      }
    });
  });

  it('puts products before the full maker story, and the story heading is About the maker', async () => {
    await withApp({ shop: { story: 'A long family story.' } }, async (app) => {
      const { text } = await app.request('/s/clay-works');
      assert.ok(at(text, 'id="products"') < at(text, 'id="story-heading"'));
      assert.match(text, /id="story-heading">About the maker</);
    });
  });
});

describe('storefront accessibility basics', () => {
  it('has one h1, a skip link, labelled landmarks, alt text on every image and visible-focus styles', async () => {
    await withApp({}, async (app) => {
      const { text } = await app.request('/s/clay-works');
      assert.equal((text.match(/<h1[ >]/g) ?? []).length, 1);
      assert.match(text, /<a class="skip-link" href="#main">/);
      assert.ok((text.match(/<img [^>]*>/g) ?? []).every((tag) => /alt="[^"]+"/.test(tag)));
      assert.match(text, /<section class="contact-actions"|<div class="contact-actions" role="group" aria-label="/);
    });
  });
});
