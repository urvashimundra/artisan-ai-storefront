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

describe('T7 shop notes hooks', () => {
  it('puts the Claude form above the save form and keeps every hook', () => {
    const page = view('store-knowledge');
    assert.ok(page.indexOf('/store/knowledge/rules/find') < page.indexOf('action="/store/knowledge/rules<%='));
    hasAll(page, ['data-focus-alert', 'data-progress="find-progress"', 'id="find-progress"', '/js/product-generate.js', 'Saving new notes clears your confirmed bulk discounts', 'name="content"']);
    hasAll(page, ['name="minQty<%= row %>"', 'name="percentOff<%= row %>"', 'class="field-row"']);
  });
});

describe('T8 shop settings hooks', () => {
  it('keeps one settings form, every field, the approval forms and the back link', () => {
    const page = view('shop-settings');
    hasAll(page, ['action="/store/settings"', 'name="tagline"', 'name="story"', 'name="accentKey"', 'name="notifyEnquiryEmail"', 'partials/contact-fields', 'action="/store/settings/translations"', 'action="/store/settings/translations/draft"', 'name="language"', 'name="approved"', 'Back to dashboard', 'class="alert" role="alert"']);
    assert.equal(page.split('action="/store/settings"').length, 2);
    hasAll(page, ['<details class="language-block"', 'id="tr-<%= row.language %>-heading"']);
  });

  it('keeps the form measure selector for forms nested in a language block', () => {
    assert.match(readFileSync(new URL('../../public/css/app.css', import.meta.url), 'utf8'), /main > section > details > form\.stack/);
  });
});

describe('T9 review product hooks', () => {
  const page = view('product-edit');
  const css = readFileSync(new URL('../../public/css/app.css', import.meta.url), 'utf8');

  it('keeps forms, hidden story, approvals inside the publish form, intents and generate hooks', () => {
    hasAll(page, ['id="generate-form"', 'data-progress="generate-progress"', 'id="generate-button"', 'id="generate-progress"', '/js/product-generate.js', 'action="/products/<%= product.id %>/save"', '<input type="hidden" name="story"', 'name="intent" value="save"', 'name="intent" value="publish"', 'action="/products/<%= product.id %>/delete"', 'name="approved_<%= code %>"', 'lang="<%= code %>"']);
    const saveForm = page.slice(page.indexOf('/save"'), page.indexOf('</form>', page.indexOf('/save"')));
    assert.ok(saveForm.includes('name="approved_<%= code %>"') && saveForm.includes('value="publish"'));
  });

  it('keeps the save form and the generate form at the form measure (direct child of main, or of a section)', () => {
    assert.match(page, /\n    <form method="post" action="\/products\/<%= product.id %>\/save" class="stack"/);
    assert.match(css, /main > form\.stack, main > section > form\.stack/);
  });

  it('shows the story error beside the story field, and sets price beside stock', () => {
    assert.ok(page.indexOf('errors.story') < page.indexOf('id="generate-button"'));
    assert.match(page, /class="field-row">\s*<div class="field">\s*<label for="price">/);
  });

  it('makes the actions sticky only below 48rem with scroll padding and a solid background', () => {
    assert.match(page, /class="actions actions-sticky"/);
    assert.match(css, /max-width: 47\.99rem\) \{\s*html:has\(\.actions-sticky\) \{ scroll-padding-bottom/);
    assert.match(css, /\.actions-sticky \{ position: sticky; bottom: 0;[^}]*background: var\(--paper\)/);
  });
});
