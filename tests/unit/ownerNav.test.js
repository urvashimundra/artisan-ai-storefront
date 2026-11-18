import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import ejs from 'ejs';

const VIEWS = fileURLToPath(new URL('../../src/views/', import.meta.url));
const HEADER = `${VIEWS}partials/header.ejs`;
const FLAGS = { productsEnabled: '/products', ordersEnabled: '/orders', enquiriesEnabled: '/enquiries' };

function hrefs(html) {
  return [...html.matchAll(/<a href="([^"]+)"/g)].map((match) => match[1]);
}

describe('owner navigation', () => {
  it('lists links that match the enabled flags, in both the sidebar and the menu', async () => {
    for (const enabled of [[], ['productsEnabled'], Object.keys(FLAGS)]) {
      const locals = { owner: { id: 'o' }, ...Object.fromEntries(enabled.map((flag) => [flag, true])) };
      const html = await ejs.renderFile(HEADER, locals);
      const expected = ['/dashboard', ...enabled.map((flag) => FLAGS[flag])];
      assert.deepEqual(hrefs(html.slice(html.indexOf('class="nav-sidebar"'), html.indexOf('<details'))), expected);
      assert.deepEqual(hrefs(html.slice(html.indexOf('<details'), html.indexOf('</details>'))), expected);
    }
  });

  it('keeps the skip link first and uses no script or inline style', async () => {
    const html = await ejs.renderFile(HEADER, { owner: { id: 'o' } });
    assert.ok(html.indexOf('class="skip-link"') < html.indexOf('<header'));
    assert.doesNotMatch(html, /<script|style=|\son[a-z]+=/);
  });

  it('shows no owner navigation to visitors', async () => {
    const html = await ejs.renderFile(HEADER, { showAuthLinks: true, signupEnabled: true });
    assert.doesNotMatch(html, /nav-sidebar|nav-menu|\/dashboard|\/logout|owner-shell/);
  });

  it('is absent from the public templates', () => {
    const dir = `${VIEWS}public`;
    for (const name of readdirSync(dir, { recursive: true }).filter((file) => file.endsWith('.ejs'))) {
      const source = readFileSync(`${dir}/${name}`, 'utf8');
      assert.doesNotMatch(source, /owner-nav|partials\/header|nav-sidebar|nav-menu/, name);
    }
  });
});
