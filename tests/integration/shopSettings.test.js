import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { STORE_FORM, signupAndLogin, startAuthApp } from '../helpers/appHarness.js';

const VALID = {
  tagline: 'Hand made in Kutch',
  story: 'A new story of the workshop.',
  accentKey: 'teal',
  whatsappNumber: '98765 43210',
  whatsappEnabled: 'on',
  instagramHandle: '@mati.no.rang',
  upiId: 'asha@okhdfcbank',
};

async function withOwners(fn) {
  const app = await startAuthApp();
  try {
    const cookieA = await signupAndLogin(app, 'a@example.com');
    await app.request('/store/new', { method: 'POST', form: STORE_FORM, cookie: cookieA });
    const cookieB = await signupAndLogin(app, 'b@example.com');
    await app.request('/store/new', { method: 'POST', form: { ...STORE_FORM, slug: 'other-shop', name: 'Other' }, cookie: cookieB });
    const [storeA, storeB] = app.storesRepo.rows;
    await fn({ app, cookieA, cookieB, storeA, storeB });
  } finally {
    await app.close();
  }
}

const post = (app, cookie, form, extra = {}) => app.request('/store/settings', { method: 'POST', form, cookie, ...extra });

describe('shop settings page', () => {
  it('applies the owner guard stack: login required, store required, no-store, Origin check', async () => {
    const app = await startAuthApp();
    try {
      assert.equal((await app.request('/store/settings')).location, '/login');
      assert.equal((await post(app, undefined, VALID)).location, '/login');
      const cookie = await signupAndLogin(app);
      assert.equal((await app.request('/store/settings', { cookie })).location, '/store/new');
      await app.request('/store/new', { method: 'POST', form: STORE_FORM, cookie });
      const page = await app.request('/store/settings', { cookie });
      assert.equal(page.status, 200);
      assert.equal(page.headers.get('cache-control'), 'no-store');
      assert.match(page.text, /Customers can see this number when they tap the WhatsApp button/);
      const forged = await post(app, cookie, VALID, { origin: 'https://evil.test' });
      assert.equal(forged.status, 403);
      assert.equal(app.storesRepo.rows[0].tagline, '');
    } finally {
      await app.close();
    }
  });

  it('saves normalised settings and shows them again', async () => {
    await withOwners(async ({ app, cookieA, storeA }) => {
      const res = await post(app, cookieA, VALID);
      assert.equal(res.status, 303);
      assert.equal(res.location, '/store/settings?saved=1');
      assert.deepEqual(
        { ...storeA },
        { ...storeA, tagline: 'Hand made in Kutch', story: 'A new story of the workshop.', accentKey: 'teal', whatsappNumber: '919876543210', whatsappEnabled: true, instagramHandle: 'mati.no.rang', upiId: 'asha@okhdfcbank' },
      );
      const page = await app.request('/store/settings?saved=1', { cookie: cookieA });
      assert.match(page.text, /Your shop settings were saved/);
      assert.match(page.text, /value="919876543210"/);
      assert.match(page.text, /<option value="teal" selected>/);
      assert.match(page.text, /id="whatsappEnabled" name="whatsappEnabled" value="on" checked/);
    });
  });

  it('rejects invalid values with field messages, echoes the input and saves nothing', async () => {
    await withOwners(async ({ app, cookieA, storeA }) => {
      const res = await post(app, cookieA, { ...VALID, whatsappNumber: '123', instagramHandle: 'a b', upiId: 'nope', tagline: 'x'.repeat(121) });
      assert.equal(res.status, 400);
      for (const id of ['whatsappNumber-error', 'instagramHandle-error', 'upiId-error', 'tagline-error']) assert.ok(res.text.includes(`id="${id}"`), id);
      assert.match(res.text, /value="a b"/);
      assert.equal(storeA.tagline, '');
      assert.equal(storeA.whatsappNumber, null);
    });
  });

  it('refuses to enable WhatsApp without a number, and clears the number and flag together', async () => {
    await withOwners(async ({ app, cookieA, storeA }) => {
      assert.equal((await post(app, cookieA, { ...VALID, whatsappNumber: '' })).status, 400);
      assert.equal(storeA.whatsappEnabled, false);
      await post(app, cookieA, VALID);
      const { whatsappEnabled: _unticked, ...cleared } = VALID;
      await post(app, cookieA, { ...cleared, whatsappNumber: '', upiId: '', instagramHandle: '' });
      assert.deepEqual([storeA.whatsappNumber, storeA.whatsappEnabled, storeA.instagramHandle, storeA.upiId], [null, false, null, null]);
    });
  });

  it('never reads a store id from the request: extra keys are rejected and nothing changes', async () => {
    await withOwners(async ({ app, cookieA, storeA, storeB }) => {
      for (const key of ['store_id', 'storeId', 'id', 'owner_id']) {
        const res = await post(app, cookieA, { ...VALID, [key]: storeB.id });
        assert.equal(res.status, 400, key);
      }
      assert.equal(storeA.tagline, '');
      assert.equal(storeB.tagline, '');
    });
  });

  it("owner A can only change owner A's shop", async () => {
    await withOwners(async ({ app, cookieA, cookieB, storeA, storeB }) => {
      await post(app, cookieA, { ...VALID, tagline: 'Shop A' });
      assert.equal(storeA.tagline, 'Shop A');
      assert.equal(storeB.tagline, '');
      await post(app, cookieB, { ...VALID, tagline: 'Shop B', accentKey: 'plum' });
      assert.deepEqual([storeA.tagline, storeA.accentKey, storeB.tagline, storeB.accentKey], ['Shop A', 'teal', 'Shop B', 'plum']);
    });
  });

  it('the dashboard links to the shop, a copy-link control and the settings page', async () => {
    await withOwners(async ({ app, cookieA }) => {
      const { text } = await app.request('/dashboard', { cookie: cookieA });
      assert.match(text, /<a class="button" href="\/s\/clay-works" target="_blank" rel="noopener noreferrer">View your shop<\/a>/);
      assert.match(text, /data-share data-share-url="http:\/\/localhost\/s\/clay-works"/);
      assert.match(text, /href="\/store\/settings">Shop settings</);
      assert.ok(text.includes('<script src="/js/share.js" defer></script>'));
      assert.ok(!text.includes('asha@') && !text.includes('9198765'));
    });
  });
});

describe('enquiry email setting', () => {
  it('is a labelled checkbox, ticked by default, described by a hint', async () => {
    await withOwners(async ({ app, cookieA }) => {
      const page = await app.request('/store/settings', { cookie: cookieA });
      assert.match(page.text, /<label for="notifyEnquiryEmail"><input type="checkbox" id="notifyEnquiryEmail" name="notifyEnquiryEmail" value="on" checked aria-describedby="notifyEnquiryEmail-hint"> Email me when a customer enquiry needs me<\/label>/);
      assert.match(page.text, /id="notifyEnquiryEmail-hint" class="hint">/);
    });
  });

  it('saves on and off for the session store only, as part of the one settings update', async () => {
    await withOwners(async ({ app, cookieA, storeA, storeB }) => {
      assert.equal((await post(app, cookieA, VALID)).status, 303);
      assert.equal(storeA.notifyEnquiryEmail, false, 'an unticked box is saved as off');
      assert.equal(storeB.notifyEnquiryEmail, true, 'the other store is untouched');
      const page = await app.request('/store/settings', { cookie: cookieA });
      assert.doesNotMatch(page.text, /name="notifyEnquiryEmail" value="on" checked/);
      assert.equal((await post(app, cookieA, { ...VALID, notifyEnquiryEmail: 'on' })).status, 303);
      assert.equal(storeA.notifyEnquiryEmail, true);
    });
  });

  it('rejects values other than on, and a smuggled store id, without changing anything', async () => {
    await withOwners(async ({ app, cookieA, storeA, storeB }) => {
      assert.equal((await post(app, cookieA, { ...VALID, notifyEnquiryEmail: 'yes' })).status, 400);
      assert.equal((await post(app, cookieA, { ...VALID, notifyEnquiryEmail: 'on', store_id: storeB.id })).status, 400);
      assert.equal(storeA.notifyEnquiryEmail, true);
      assert.equal(storeB.notifyEnquiryEmail, true);
    });
  });

  it('keeps what the owner ticked when another field fails validation', async () => {
    await withOwners(async ({ app, cookieA }) => {
      const res = await post(app, cookieA, { ...VALID, upiId: 'bad upi' });
      assert.equal(res.status, 400);
      assert.doesNotMatch(res.text, /name="notifyEnquiryEmail" value="on" checked/);
    });
  });
});

describe('enquiry email setting and onboarding step 2', () => {
  it('saving the contact step leaves the owner choice as it was', async () => {
    await withOwners(async ({ app, cookieA, storeA }) => {
      await post(app, cookieA, VALID);
      assert.equal(storeA.notifyEnquiryEmail, false);
      const res = await app.request('/store/new/contact', { method: 'POST', cookie: cookieA, form: { whatsappNumber: '', instagramHandle: '', upiId: '' } });
      assert.equal(res.status, 303);
      assert.equal(storeA.notifyEnquiryEmail, false);
    });
  });
});
