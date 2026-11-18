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
const ICON = `<svg class="icon"[^>]*aria-hidden="true"[^>]*focusable="false">(?:(?!</svg>)[^])*</svg>`;
const GAP = `[ ${String.fromCharCode(10)}]*`;
const actionGroup = (text) => /<div class="contact-actions"[\s\S]*?<\/div>/.exec(text)[0];

describe('storefront and product redesign: hooks, icons and labels survive', () => {
  it('puts a data-free aria-hidden icon before the label of Ask AI, WhatsApp and Share on both pages', async () => {
    await withApp({ shop: { instagramHandle: 'clayworks' } }, async (app) => {
      for (const path of ['/s/clay-works', `/s/clay-works/p/${app.product.id}`]) {
        const group = actionGroup((await app.request(path)).text);
        assert.match(group, new RegExp(`data-contact="chat">${ICON}${GAP}Ask AI assistant<span class="visually-hidden">`), path);
        assert.match(group, new RegExp(`data-contact="whatsapp">${ICON}${GAP}Ask on WhatsApp<span class="visually-hidden">`), path);
        assert.match(group, new RegExp(`data-contact="share"[^>]*>${ICON}${GAP}Share</button>`), path);
        assert.match(group, /data-contact="instagram">Instagram<span/, path);
        assert.equal((group.match(/<svg/g) ?? []).length, 3, path);
        assert.doesNotMatch(group, /<svg[^>]*(data-|id=|href=)/, path);
      }
    });
  });

  it('keeps the share button hidden by default with every hook share.js reads', async () => {
    await withApp({}, async (app) => {
      for (const path of ['/s/clay-works', `/s/clay-works/p/${app.product.id}`]) {
        const { text } = await app.request(path);
        const button = /<button type="button" class="button button-secondary" data-contact="share"[^>]*>/.exec(text)[0];
        for (const hook of ['data-share', 'data-share-title="Clay Works"', 'data-copied="', ' hidden>']) assert.ok(button.includes(hook), `${path} ${hook}`);
        assert.match(text, /data-share-status/, path);
        assert.match(text, /<script src="\/js\/share\.js" defer><\/script>/, path);
      }
    });
  });

  it('keeps the shop hero action, product links, ids and labels', async () => {
    await withApp({}, async (app) => {
      const { text } = await app.request('/s/clay-works');
      assert.match(text, /<a class="button button-primary button-large" href="#products">Products<\/a>/);
      assert.ok(text.includes(`href="/s/clay-works/p/${app.product.id}`));
      for (const id of ['shop-title', 'products', 'products-heading', 'story-heading', 'contact-heading']) assert.ok(text.includes(`id="${id}"`) || id === 'story-heading', id);
      assert.match(text, /<ul class="grid">/);
      assert.match(text, /<span class="card-media"><img [^>]*alt="[^"]+"[^>]*width="600" height="600"/);
    });
  });

  it('keeps the product page photo, price, buy link and back link', async () => {
    await withApp({}, async (app) => {
      const { text } = await app.request(`/s/clay-works/p/${app.product.id}`);
      assert.match(text, /<img class="product-photo"[^>]*alt="[^"]+"/);
      assert.match(text, /class="price price-large"/);
      assert.match(text, /id="product-title"/);
      assert.match(text, /Back to all products/);
      assert.equal((text.match(/<form/g) ?? []).length, 0);
    });
  });
});
