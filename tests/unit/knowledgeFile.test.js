import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const read = (relative) => readFileSync(fileURLToPath(new URL(`../../${relative}`, import.meta.url)), 'utf8');

/** Runs the browser script in a bare sandbox with no document, and returns the helper it publishes. */
function loadHelper() {
  const sandbox = { globalThis: undefined };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(read('public/js/knowledge-file.js'), sandbox);
  return sandbox.KnowledgeFile;
}

const file = (name, size, type = 'text/plain') => ({ name, size, type });

describe('knowledge file reader (browser helper)', () => {
  const helper = loadHelper();

  it('accepts .txt and .md files within the size limit', () => {
    assert.equal(helper.check(file('notes.txt', 500)), null);
    assert.equal(helper.check(file('Notes.MD', 500, 'text/markdown')), null);
    assert.equal(helper.check(file('notes.md', 500, '')), null);
  });

  it('rejects other types, a missing file and big files', () => {
    assert.match(helper.check(file('notes.pdf', 500, 'application/pdf')), /\.txt or \.md/);
    assert.match(helper.check(file('notes.txt', 500, 'application/pdf')), /\.txt or \.md/);
    assert.match(helper.check(file('notes.exe', 500, '')), /\.txt or \.md/);
    assert.match(helper.check(file('notes.txt', helper.MAX_FILE_BYTES + 1)), /too big/);
    assert.match(helper.check(null), /Choose a file/);
  });

  it('rejects text longer than 20,000 characters, counting code points', () => {
    assert.equal(helper.checkText('અ'.repeat(helper.MAX_CHARACTERS)), null);
    assert.match(helper.checkText('x'.repeat(helper.MAX_CHARACTERS + 1)), /longer than/);
  });

  it('does no upload: the script never touches the network or a form', () => {
    const source = read('public/js/knowledge-file.js');
    assert.doesNotMatch(source, /fetch\(|XMLHttpRequest|sendBeacon|FormData|\.submit\(/);
  });
});
