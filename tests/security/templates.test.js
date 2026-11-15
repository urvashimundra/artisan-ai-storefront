import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const VIEWS_DIR = fileURLToPath(new URL('../../src/views', import.meta.url));
const ALLOWED_RAW_OUTPUT = /^<%- include\('[a-z0-9/_-]+'\) %>$/;

/** The only script allowed: an external, self-hosted file under /js (the CSP blocks everything else). */
const ALLOWED_SCRIPT_TAG = /<script src="\/js\/[a-z-]+\.js" defer><\/script>/g;

function templateFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? templateFiles(join(dir, entry.name)) : entry.name.endsWith('.ejs') ? [join(dir, entry.name)] : [],
  );
}

describe('EJS templates never emit unescaped output', () => {
  it('finds templates to check', () => {
    assert.ok(templateFiles(VIEWS_DIR).length >= 3);
  });

  it("the only allowed <%- is the exact form <%- include('...') %> for partials", () => {
    for (const file of templateFiles(VIEWS_DIR)) {
      const source = readFileSync(file, 'utf8');
      const uses = source.match(/<%-[^%]*%>|<%-/g) ?? [];
      for (const use of uses) assert.match(use, ALLOWED_RAW_OUTPUT, `${file}: ${use}`);
    }
  });

  it('the guard itself rejects other raw forms', () => {
    for (const bad of ['<%- name %>', "<%- include('a', { x: 1 }) %>", '<%-name%>', "<%- include(name) %>"]) {
      assert.doesNotMatch(bad, ALLOWED_RAW_OUTPUT, bad);
    }
  });

  it('templates use no inline scripts or styles', () => {
    for (const file of templateFiles(VIEWS_DIR)) {
      const source = readFileSync(file, 'utf8').replace(ALLOWED_SCRIPT_TAG, '');
      assert.doesNotMatch(source, /<script|<style|\sstyle=|\son\w+=/i, file);
    }
  });
});
