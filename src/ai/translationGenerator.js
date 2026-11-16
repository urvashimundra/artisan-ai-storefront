import Anthropic from '@anthropic-ai/sdk';
import { withTimeout } from '../lib/timeout.js';
import { classifyFailure, readUsage } from './listingGenerator.js';
import { TRANSLATION_PROMPT_VERSION, buildTranslationSystemPrompt, buildTranslationUserText } from './prompts/translationV1.js';
import { TRANSLATION_MAX_OUTPUT_TOKENS } from './translationCost.js';
import { TRANSLATION_TOOL_NAME, buildTranslationTool, parseTranslationOutput } from './schemas/translation.js';

/** One Claude call may take at most this long; the whole request stays under 60 s (withTimeout is a later backstop). */
export const TRANSLATION_TIMEOUT_MS = 45_000;
const BACKSTOP_MARGIN_MS = 2_000;
const REFUSAL_STOP_REASON = 'refusal';

function findToolInput(response) {
  const blocks = Array.isArray(response?.content) ? response.content : [];
  return blocks.find((block) => block?.type === 'tool_use' && block.name === TRANSLATION_TOOL_NAME)?.input;
}

function buildRequest({ model, tagline, story, targets }) {
  return {
    model,
    max_tokens: TRANSLATION_MAX_OUTPUT_TOKENS,
    thinking: { type: 'disabled' },
    system: buildTranslationSystemPrompt(),
    tools: [buildTranslationTool(targets)],
    tool_choice: { type: 'tool', name: TRANSLATION_TOOL_NAME, disable_parallel_tool_use: true },
    messages: [{ role: 'user', content: buildTranslationUserText({ tagline, story, targets }) }],
  };
}

/**
 * Claude call that proposes the tagline and story in the other languages through the forced `propose_translations`
 * tool. It sends ONLY the tagline and story. No retries here (maxRetries 0): the service decides, because every attempt
 * needs its own budget reservation. The output is untrusted and is only accepted through the strict Zod schema.
 * @param {{ config: { apiKey: string, model: string }, createClient?: (options: object) => any }} deps
 */
export function createTranslationGenerator({ config, createClient = (options) => new Anthropic(options) }) {
  const client = createClient({ apiKey: config.apiKey, timeout: TRANSLATION_TIMEOUT_MS, maxRetries: 0 });

  return {
    model: config.model,
    promptVersion: TRANSLATION_PROMPT_VERSION,

    /**
     * @param {{ tagline: string, story: string, targets: string[] }} input
     * @returns {Promise<{ ok: true, translations: object, usage: object | null }
     *   | { ok: false, reason: 'refused' | 'invalid_output', usage: object | null }>}
     * @throws {import('./listingGenerator.js').ListingProviderError} When the provider call itself fails.
     */
    async translate({ tagline, story, targets }) {
      let response;
      try {
        const call = () => client.messages.create(buildRequest({ model: config.model, tagline, story, targets }));
        response = await withTimeout(call, TRANSLATION_TIMEOUT_MS + BACKSTOP_MARGIN_MS, 'translation');
      } catch (error) {
        throw classifyFailure(error);
      }
      const usage = readUsage(response);
      if (response?.stop_reason === REFUSAL_STOP_REASON) return { ok: false, reason: 'refused', usage };
      const parsed = parseTranslationOutput(findToolInput(response), targets);
      return parsed.ok ? { ok: true, translations: parsed.translations, usage } : { ok: false, reason: 'invalid_output', usage };
    },
  };
}
