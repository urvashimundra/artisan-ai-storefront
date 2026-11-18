import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { MAX_DESCRIPTION_LENGTH, MAX_TITLE_LENGTH } from '../../src/domain/productRules.js';

const sql = readFileSync(new URL('../../db/migrations/016_product_translation_drafts.sql', import.meta.url), 'utf8');

describe('migration 016 text (L2)', () => {
  it('mirrors the text limits and writes only title and description as unapproved AI drafts', () => {
    assert.match(sql, new RegExp(`'title'\\) NOT BETWEEN 1 AND ${MAX_TITLE_LENGTH}`));
    assert.match(sql, new RegExp(`'description'\\) NOT BETWEEN 1 AND ${MAX_DESCRIPTION_LENGTH}`));
    assert.match(sql, /source = 'ai', approved = false/);
    assert.equal(/alt_text = EXCLUDED/.test(sql), false);
  });

  it('skips approved owner text, locks the product row and refuses the default language', () => {
    assert.match(sql, /v_row\.approved AND v_row\.source = 'owner'/);
    assert.match(sql, /FOR UPDATE/);
    assert.match(sql, /v_lang = v_default/);
  });

  it('pins search_path and grants only service_role', () => {
    assert.match(sql, /CREATE OR REPLACE FUNCTION public\.save_product_translation_drafts\([\s\S]*?SET search_path = public, pg_temp/);
    assert.match(sql, /REVOKE EXECUTE ON FUNCTION public\.save_product_translation_drafts\(uuid, uuid, jsonb\) FROM PUBLIC, anon, authenticated;/);
    assert.match(sql, /GRANT EXECUTE ON FUNCTION public\.save_product_translation_drafts\(uuid, uuid, jsonb\) TO service_role;/);
  });
});
