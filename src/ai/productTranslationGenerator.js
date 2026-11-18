import Anthropic from '@anthropic-ai/sdk';
import { withTimeout } from '../lib/timeout.js';
import { classifyFailure, readUsage } from './listingGenerator.js';
import { PRODUCT_TRANSLATION_PROMPT_VERSION, buildProductTranslationSystemPrompt, buildProductTranslationUserText } from './prompts/productTranslationV1.js';
import { PRODUCT_TRANSLATION_TOOL_NAME, buildProductTranslationTool, parseProductTranslationOutput } from './schemas/productTranslation.js';
import { TRANSLATION_MAX_OUTPUT_TOKENS } from './translationCost.js';

/** One Claude call may take at most this long; the whole request stays under 60 s (withTimeout is a later backstop). */
export const PRODUCT_TRANSLATION_TIMEOUT_MS = 45_000;
const BACKSTOP_MARGIN_MS = 2_000;
const REFUSAL_STOP_REASON = 'refusal';

function findToolInput(response) {
  const blocks = Array.isArray(response?.content) ? response.content : [];
  return blocks.find((block) => block?.type === 'tool_use' && block.name === PRODUCT_TRANSLATION_TOOL_NAME)?.input;
}

function buildRequest({ model, title, description, targets }) {
  return {
    model,
    max_tokens: TRANSLATION_MAX_OUTPUT_TOKENS,
    thinking: { type: 'disabled' },
    system: buildProductTranslationSystemPrompt(),
    tools: [buildProductTranslationTool(targets)],
    tool_choice: { type: 'tool', name: PRODUCT_TRANSLATION_TOOL_NAME, disable_parallel_tool_use: true },
    messages: [{ role: 'user', content: buildProductTranslationUserText({ title, description, targets }) }],
  };
}

/**
 * Claude call that translates one product's title and description through the forced `propose_product_translations` tool. Text only:
 * no photo is sent. No retries here (maxRetries 0): the service decides, because every attempt needs its own budget reservation. The
 * output is untrusted and is only accepted through the strict Zod schema.
 * @param {{ config: { apiKey: string, model: string }, createClient?: (options: object) => any }} deps
 */
export function createProductTranslationGenerator({ config, createClient = (options) => new Anthropic(options) }) {
  const client = createClient({ apiKey: config.apiKey, timeout: PRODUCT_TRANSLATION_TIMEOUT_MS, maxRetries: 0 });

  return {
    model: config.model,
    promptVersion: PRODUCT_TRANSLATION_PROMPT_VERSION,

    /**
     * @param {{ title: string, description: string, targets: string[] }} input
     * @returns {Promise<{ ok: true, translations: object, usage: object | null } | { ok: false, reason: 'refused' | 'invalid_output', usage: object | null }>}
     * @throws {import('./listingGenerator.js').ListingProviderError} When the provider call itself fails.
     */
    async translate({ title, description, targets }) {
      let response;
      try {
        const call = () => client.messages.create(buildRequest({ model: config.model, title, description, targets }));
        response = await withTimeout(call, PRODUCT_TRANSLATION_TIMEOUT_MS + BACKSTOP_MARGIN_MS, 'product translation');
      } catch (error) {
        throw classifyFailure(error);
      }
      const usage = readUsage(response);
      if (response?.stop_reason === REFUSAL_STOP_REASON) return { ok: false, reason: 'refused', usage };
      const parsed = parseProductTranslationOutput(findToolInput(response), targets);
      return parsed.ok ? { ok: true, translations: parsed.translations, usage } : { ok: false, reason: 'invalid_output', usage };
    },
  };
}
