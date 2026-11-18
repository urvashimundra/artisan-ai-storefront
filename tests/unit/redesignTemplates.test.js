import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const view = (name) => readFileSync(new URL(`../../src/views/${name}.ejs`, import.meta.url), 'utf8');
const hasAll = (source, hooks) => hooks.forEach((hook) => assert.ok(source.includes(hook), hook));

describe('T6 dashboard and onboarding hooks', () => {
  it('dashboard keeps its share and welcome hooks', () => {
    hasAll(view('dashboard'), ['locals.welcome', 'data-share ', 'data-share-url', 'data-share-status', '/js/share.js']);
  });

  it('onboarding forms keep actions, field names and autosubmit hooks', () => {
    hasAll(view('store-new'), ['action="/store/new"', 'name="name"', 'name="slug"', 'name="defaultLanguage"', 'name="story"', 'name="tagline"', 'name="accentKey"', 'Step 1 of 4']);
    hasAll(view('store-contact'), ['action="/store/new/contact"', 'Skip for now', 'Step 2 of 4']);
    hasAll(view('store-languages'), ['data-autosubmit', 'data-autosubmit-skip', 'data-autosubmit-status', '/store/new/languages/approve', 'Step 3 of 4']);
  });

  it('shared contact fields keep names and put WhatsApp beside Instagram', () => {
    const fields = view('partials/contact-fields');
    hasAll(fields, ['name="whatsappNumber"', 'name="whatsappEnabled"', 'name="instagramHandle"', 'name="upiId"']);
    const row = fields.slice(fields.indexOf('field-row'), fields.indexOf('name="whatsappEnabled"'));
    assert.ok(row.includes('name="whatsappNumber"') && row.includes('name="instagramHandle"'));
  });
});
