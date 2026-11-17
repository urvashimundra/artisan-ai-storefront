import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const template = readFileSync(fileURLToPath(new URL('../../public/knowledge-template.md', import.meta.url)), 'utf8');
const SECTIONS = [
  'About us', 'Ordering process', 'Delivery and shipping', 'Returns and refunds', 'Custom orders', 'Bulk orders and discounts',
  'Gifting and packaging', 'Care instructions', 'Materials and sizes', 'Making time and dispatch', 'Payment', 'Contact hours and languages',
  'FAQs', 'Anything else',
];

describe('knowledge template file', () => {
  it('has every required section heading, each with an example', () => {
    const parts = template.split(/^## /m).slice(1);
    assert.equal(parts.length, SECTIONS.length);
    SECTIONS.forEach((name, index) => {
      assert.ok(parts[index].startsWith(name), name);
      assert.match(parts[index], /Example:/, `${name} example`);
    });
  });

  it('says that any language works, warns about private information, and shows explicit bulk tiers', () => {
    assert.match(template, /Any language works/);
    assert.match(template, /Do not write bank details/);
    assert.match(template, /10 or more: 5% off/);
  });

  it('is plain text and short enough to read', () => {
    assert.ok(template.length < 5000);
    assert.doesNotMatch(template, /<script|<\/?[a-z]+>/i);
  });
});
