import Anthropic from '@anthropic-ai/sdk';
import { estimateMaxCostMicroUsd } from '../domain/aiCost.js';
import { codePointLength } from '../domain/productRules.js';
import { withTimeout } from '../lib/timeout.js';
import { classifyFailure, readUsage } from './listingGenerator.js';
import { INDIC_TOKENS_PER_CHARACTER } from './listingCost.js';
import { BULK_RULES_PROMPT_VERSION, buildBulkRulesSystemPrompt, buildBulkRulesUserText } from './prompts/bulkRulesV1.js';
import { BULK_RULES_TOOL_NAME, buildBulkRulesTool, parseBulkRulesOutput } from './schemas/bulkRules.js';

/** One Claude call may take at most this long; the request stays well under 60 s. */
export const BULK_RULES_TIMEOUT_MS = 30_000;
const BACKSTOP_MARGIN_MS = 2_000;
export const BULK_RULES_MAX_OUTPUT_TOKENS = 400;
const PROMPT_TOKEN_ALLOWANCE = 800;

/**
 * Micro-USD to reserve before the extraction call: worst case with the safety margin from aiCost.
 * @param {string} content
 * @returns {number}
 */
export function estimateBulkRulesReservationMicroUsd(content) {
  return estimateMaxCostMicroUsd({
    inputTokens: PROMPT_TOKEN_ALLOWANCE + codePointLength(content) * INDIC_TOKENS_PER_CHARACTER,
    maxOutputTokens: BULK_RULES_MAX_OUTPUT_TOKENS,
  });
}

const findToolInput = (response) =>
  (Array.isArray(response?.content) ? response.content : []).find((block) => block?.type === 'tool_use' && block.name === BULK_RULES_TOOL_NAME)?.input;

/**
 * One forced-tool Claude call that proposes bulk-discount tiers from the seller's document. No retries here: the service decides,
 * because each attempt needs its own budget reservation. Output is untrusted and only accepted through the strict schema.
 * @param {{ config: { apiKey: string, model: string }, createClient?: (options: object) => any }} deps
 */
export function createBulkRuleExtractor({ config, createClient = (options) => new Anthropic(options) }) {
  const client = createClient({ apiKey: config.apiKey, timeout: BULK_RULES_TIMEOUT_MS, maxRetries: 0 });

  return {
    model: config.model,
    promptVersion: BULK_RULES_PROMPT_VERSION,

    /**
     * @param {string} content
     * @returns {Promise<{ ok: true, tiers: object[], usage: object | null } | { ok: false, usage: object | null }>}
     * @throws {import('./listingGenerator.js').ListingProviderError} When the provider call itself fails.
     */
    async extract(content) {
      const request = {
        model: config.model,
        max_tokens: BULK_RULES_MAX_OUTPUT_TOKENS,
        thinking: { type: 'disabled' },
        system: buildBulkRulesSystemPrompt(),
        tools: [buildBulkRulesTool()],
        tool_choice: { type: 'tool', name: BULK_RULES_TOOL_NAME, disable_parallel_tool_use: true },
        messages: [{ role: 'user', content: buildBulkRulesUserText(content) }],
      };
      let response;
      try {
        response = await withTimeout(() => client.messages.create(request), BULK_RULES_TIMEOUT_MS + BACKSTOP_MARGIN_MS, 'bulk rules');
      } catch (error) {
        throw classifyFailure(error);
      }
      const usage = readUsage(response);
      const parsed = parseBulkRulesOutput(findToolInput(response));
      return parsed.ok ? { ok: true, tiers: parsed.tiers, usage } : { ok: false, usage };
    },
  };
}
