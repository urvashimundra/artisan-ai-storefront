import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { withTimeout } from '../lib/timeout.js';
import { LISTING_MAX_OUTPUT_TOKENS } from './listingCost.js';
import { LISTING_PROMPT_VERSION, buildListingSystemPrompt, buildListingUserText } from './prompts/listingV1.js';
import { LISTING_TOOL_NAME, buildListingTool, parseListingOutput } from './schemas/listing.js';

/** One Claude call may take at most this long (the SDK aborts it; withTimeout is a second, slightly later guard). */
export const LISTING_TIMEOUT_MS = 30_000;
const BACKSTOP_MARGIN_MS = 2_000;
const REFUSAL_STOP_REASON = 'refusal';
const TIMEOUT_ERROR_NAMES = new Set(['TimeoutError', 'APIConnectionTimeoutError']);

const usageSchema = z.object({ input_tokens: z.number().int().min(0), output_tokens: z.number().int().min(0) });

/**
 * A failed provider call. `kind` is 'http' when the provider answered with an error status (nothing was billed),
 * 'timeout' or 'network' when the outcome is unknown (the call may still have been billed).
 */
export class ListingProviderError extends Error {
  /** @param {'http' | 'timeout' | 'network'} kind @param {number} [status] */
  constructor(kind, status) {
    super(`Listing provider call failed (${kind})`);
    this.name = 'ListingProviderError';
    this.kind = kind;
    this.status = status;
  }
}

export function classifyFailure(error) {
  if (typeof error?.status === 'number') return new ListingProviderError('http', error.status);
  if (TIMEOUT_ERROR_NAMES.has(error?.name)) return new ListingProviderError('timeout');
  return new ListingProviderError('network');
}

export function readUsage(response) {
  const parsed = usageSchema.safeParse(response?.usage);
  return parsed.success ? { inputTokens: parsed.data.input_tokens, outputTokens: parsed.data.output_tokens } : null;
}

function findToolInput(response) {
  const blocks = Array.isArray(response?.content) ? response.content : [];
  return blocks.find((block) => block?.type === 'tool_use' && block.name === LISTING_TOOL_NAME)?.input;
}

function buildRequest({ model, story, image }) {
  return {
    model,
    max_tokens: LISTING_MAX_OUTPUT_TOKENS,
    thinking: { type: 'disabled' },
    system: buildListingSystemPrompt(),
    tools: [buildListingTool()],
    tool_choice: { type: 'tool', name: LISTING_TOOL_NAME, disable_parallel_tool_use: true },
    messages: [
      {
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: image.mediaType, data: image.data } },
          { type: 'text', text: buildListingUserText(story) },
        ],
      },
    ],
  };
}

/**
 * Claude vision call that proposes a three-language listing through the forced `propose_listing` tool. No retries
 * here (maxRetries 0); the service decides whether to try again, because each attempt needs its own budget
 * reservation. The model's output is untrusted: it is only ever accepted through the strict Zod schema.
 * @param {{ config: { apiKey: string, model: string }, createClient?: (options: object) => any }} deps
 */
export function createListingGenerator({ config, createClient = (options) => new Anthropic(options) }) {
  const client = createClient({ apiKey: config.apiKey, timeout: LISTING_TIMEOUT_MS, maxRetries: 0 });

  return {
    model: config.model,
    promptVersion: LISTING_PROMPT_VERSION,

    /**
     * @param {{ story: string, image: { mediaType: string, data: string } }} input `data` is base64.
     * @returns {Promise<{ ok: true, translations: object, usage: object | null }
     *   | { ok: false, reason: 'refused' | 'invalid_output', usage: object | null }>}
     * @throws {ListingProviderError} When the provider call itself fails.
     */
    async generate({ story, image }) {
      let response;
      try {
        const call = () => client.messages.create(buildRequest({ model: config.model, story, image }));
        response = await withTimeout(call, LISTING_TIMEOUT_MS + BACKSTOP_MARGIN_MS, 'listing');
      } catch (error) {
        throw classifyFailure(error);
      }
      const usage = readUsage(response);
      if (response?.stop_reason === REFUSAL_STOP_REASON) return { ok: false, reason: 'refused', usage };
      const parsed = parseListingOutput(findToolInput(response));
      return parsed.ok ? { ok: true, translations: parsed.translations, usage } : { ok: false, reason: 'invalid_output', usage };
    },
  };
}
