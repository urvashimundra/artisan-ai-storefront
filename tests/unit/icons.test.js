import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (path) => readFileSync(fileURLToPath(new URL(`../../${path}`, import.meta.url)), 'utf8');

describe('icon partials', () => {
  for (const name of ['whatsapp', 'chat', 'share']) {
    it(`${name} is decorative, data-free inline SVG`, () => {
      const source = read(`src/views/partials/icons/${name}.ejs`);
      assert.match(source, /aria-hidden="true"/);
      assert.match(source, /focusable="false"/);
      assert.match(source, /viewBox="0 0 24 24"/);
      assert.match(source, /stroke="currentColor"/);
      assert.match(source, /fill="none"/);
      assert.match(source, /stroke-width="1\.75"/);
      assert.doesNotMatch(source, /style=|<script|<%|\son[a-z]+=|href=/i);
    });
  }

  it('both stylesheets define .icon', () => {
    for (const css of ['public/css/app.css', 'public/css/public.css']) {
      assert.match(read(css), /\.icon \{ width: 1\.25em; height: 1\.25em; flex-shrink: 0; margin-inline-end: 0\.4em; \}/, css);
    }
  });
});
