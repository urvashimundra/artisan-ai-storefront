import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SCANNED_DIRS = ['src', 'scripts', 'public', 'db', 'tests'];
const SCANNED_EXTENSIONS = /\.(js|ejs|sql|css|json|md|example)$/;
const SKIPPED_DIRS = new Set(['fonts']);
const SECRET_PATTERNS = Object.freeze({
  'Anthropic key': /sk-ant-[A-Za-z0-9_-]{16,}/,
  'JWT (Supabase key)': /eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}/,
  'private key': /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  'filled-in secret assignment': /^(?:SUPABASE_SERVICE_ROLE_KEY|ANTHROPIC_API_KEY|SIGNUP_INVITE_CODE|DIAGNOSTICS_TOKEN)=\S+/m,
});

function* walk(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && !SKIPPED_DIRS.has(entry.name)) yield* walk(`${directory}${entry.name}/`);
    else if (entry.isFile() && SCANNED_EXTENSIONS.test(entry.name)) yield `${directory}${entry.name}`;
  }
}

describe('no secrets in the repository', () => {
  it('source, scripts, public files, SQL, tests and .env.example hold no key, token or filled-in secret', () => {
    const files = [...SCANNED_DIRS.flatMap((dir) => [...walk(`${ROOT}${dir}/`)]), `${ROOT}.env.example`];
    assert.ok(files.length > 100);
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      for (const [name, pattern] of Object.entries(SECRET_PATTERNS)) {
        if (file.endsWith('noSecrets.test.js')) continue;
        assert.doesNotMatch(text, pattern, `${name} in ${file.slice(ROOT.length)}`);
      }
    }
  });

  it('.env is ignored by git and not present among the files that would ship', () => {
    assert.match(readFileSync(`${ROOT}.gitignore`, 'utf8'), /^\.env$/m);
    assert.ok(existsSync(`${ROOT}.env.example`));
  });
});
