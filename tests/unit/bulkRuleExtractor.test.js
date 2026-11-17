import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createBulkRuleExtractor } from '../../src/ai/bulkRuleExtractor.js';
import { BULK_RULES_TOOL_NAME, parseBulkRulesOutput } from '../../src/ai/schemas/bulkRules.js';

const reply = (input) => ({ content: [{ type: 'tool_use', name: BULK_RULES_TOOL_NAME, input }], usage: { input_tokens: 50, output_tokens: 10 } });
const extractorFor = (response) => {
  const requests = [];
  const createClient = () => ({ messages: { create: async (request) => (requests.push(request), response) } });
  return { requests, extractor: createBulkRuleExtractor({ config: { apiKey: 'k', model: 'fake' }, createClient }) };
};

describe('bulk rule extraction output', () => {
  it('accepts valid tiers, sorting them by quantity, and an empty list', () => {
    assert.deepEqual(parseBulkRulesOutput({ tiers: [{ minQty: 25, percentOff: 10 }, { minQty: 10, percentOff: 5 }] }).tiers.map((t) => t.minQty), [10, 25]);
    assert.deepEqual(parseBulkRulesOutput({ tiers: [] }), { ok: true, tiers: [] });
  });

  it('rejects out-of-range, duplicate, extra-key and over-long output', () => {
    for (const bad of [{ tiers: [{ minQty: 1, percentOff: 5 }] }, { tiers: [{ minQty: 5, percentOff: 90 }] }, { tiers: [{ minQty: 5, percentOff: 5 }, { minQty: 5, percentOff: 6 }] },
      { tiers: [], extra: 1 }, { tiers: Array.from({ length: 6 }, (_, i) => ({ minQty: i + 2, percentOff: 5 })) }, { tiers: 'x' }, null]) {
      assert.equal(parseBulkRulesOutput(bad).ok, false, JSON.stringify(bad));
    }
  });
});

describe('bulk rule extractor', () => {
  it('makes one forced-tool call with the document in a data block and returns usage', async () => {
    const { requests, extractor } = extractorFor(reply({ tiers: [{ minQty: 10, percentOff: 5 }] }));
    const result = await extractor.extract('10 or more: 5% off');
    assert.equal(result.ok, true);
    assert.deepEqual(result.usage, { inputTokens: 50, outputTokens: 10 });
    assert.equal(requests.length, 1);
    assert.deepEqual(requests[0].tool_choice, { type: 'tool', name: BULK_RULES_TOOL_NAME, disable_parallel_tool_use: true });
    assert.match(requests[0].messages[0].content, /<document>/);
    assert.match(requests[0].system, /DATA/);
  });

  it('reports invalid output without throwing, and raises provider failures', async () => {
    assert.equal((await extractorFor(reply({ tiers: [{ minQty: 1, percentOff: 5 }] })).extractor.extract('x')).ok, false);
    const failing = createBulkRuleExtractor({ config: { apiKey: 'k', model: 'm' }, createClient: () => ({ messages: { create: async () => { throw Object.assign(new Error('x'), { status: 500 }); } } }) });
    await assert.rejects(() => failing.extract('x'), { kind: 'http' });
  });
});
