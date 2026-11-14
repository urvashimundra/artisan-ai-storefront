import { readFileSync } from 'node:fs';

const PACKAGE_JSON_URL = new URL('../../package.json', import.meta.url);

/**
 * Reads the app version from package.json.
 * @returns {string}
 */
export function readVersion() {
  return JSON.parse(readFileSync(PACKAGE_JSON_URL, 'utf8')).version;
}
