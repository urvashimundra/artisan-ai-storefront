import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { actualCostMicroUsd, estimateMaxCostMicroUsd, parseUsdToMicroUsd } from '../../src/domain/aiCost.js';

const SOURCE_FILES = ['../../src/domain/aiCost.js', '../../src/repositories/aiBudgetRepository.js', '../../src/services/aiBudgetService.js'];

describe('parseUsdToMicroUsd', () => {
  it('parses decimal strings exactly', () => {
    assert.equal(parseUsdToMicroUsd('1'), 1_000_000);
    assert.equal(parseUsdToMicroUsd('1.5'), 1_500_000);
    assert.equal(parseUsdToMicroUsd('0.000001'), 1);
    assert.equal(parseUsdToMicroUsd('0'), 0);
    assert.equal(parseUsdToMicroUsd('5.00'), 5_000_000);
  });

  it('rejects more than 6 decimals, negatives, empty, junk and exponents', () => {
    for (const bad of ['1.0000001', '-1', '', 'abc', '1e3', ' 1', '1.', '.5', '1,5', null, 1]) {
      assert.throws(() => parseUsdToMicroUsd(bad), RangeError, String(bad));
    }
  });
});

describe('actualCostMicroUsd', () => {
  it('uses the standard tier up to and including 100,000 input tokens', () => {
    assert.equal(actualCostMicroUsd({ inputTokens: 100_000, outputTokens: 0 }), 10_000);
    assert.equal(actualCostMicroUsd({ inputTokens: 100_000, outputTokens: 1_000 }), 10_000 + 500);
  });

  it('uses the long tier for the whole request above 100,000 input tokens', () => {
    assert.equal(actualCostMicroUsd({ inputTokens: 100_001, outputTokens: 1_000 }), 50_001 + 2_500);
  });

  it('rounds up per side', () => {
    assert.equal(actualCostMicroUsd({ inputTokens: 1, outputTokens: 0 }), 1);
    assert.equal(actualCostMicroUsd({ inputTokens: 0, outputTokens: 1 }), 1);
    assert.equal(actualCostMicroUsd({ inputTokens: 1, outputTokens: 1 }), 2);
    assert.equal(actualCostMicroUsd({ inputTokens: 0, outputTokens: 0 }), 0);
  });

  it('rejects invalid token counts', () => {
    for (const bad of [-1, 1.5, NaN, '5', undefined]) {
      assert.throws(() => actualCostMicroUsd({ inputTokens: bad, outputTokens: 0 }), RangeError);
      assert.throws(() => actualCostMicroUsd({ inputTokens: 0, outputTokens: bad }), RangeError);
    }
  });
});

describe('estimateMaxCostMicroUsd', () => {
  it('applies a 130% margin to the worst case', () => {
    assert.equal(estimateMaxCostMicroUsd({ inputTokens: 100_000, maxOutputTokens: 1_000 }), 13_650);
    assert.equal(estimateMaxCostMicroUsd({ inputTokens: 100_001, maxOutputTokens: 1_000 }), 68_252);
  });

  it('rounds the margin up', () => {
    assert.equal(estimateMaxCostMicroUsd({ inputTokens: 1, maxOutputTokens: 0 }), 2);
    assert.equal(estimateMaxCostMicroUsd({ inputTokens: 0, maxOutputTokens: 0 }), 0);
  });
});

describe('budget money code', () => {
  it('never uses floating-point helpers on money', () => {
    for (const relative of SOURCE_FILES) {
      const source = readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');
      assert.doesNotMatch(source, /parseFloat|toFixed|Math\.round|Math\.floor|Math\.ceil/, relative);
    }
  });
});
