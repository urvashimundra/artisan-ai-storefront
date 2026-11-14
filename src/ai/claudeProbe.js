import Anthropic from '@anthropic-ai/sdk';
import { withTimeout } from '../lib/timeout.js';

export const CLAUDE_TIMEOUT_MS = 15000;
const PROBE_MAX_TOKENS = 16;
const PROBE_PROMPT = 'Reply with the single word: ok';

/**
 * Claude connectivity probe: one tiny call, no retries.
 * @param {{ config: { apiKey: string, model: string }, createClient?: (options: object) => any }} deps
 * @returns {() => Promise<void>} Resolves on success; rejects otherwise.
 */
export function createClaudeProbe({ config, createClient = (options) => new Anthropic(options) }) {
  return async function checkClaude() {
    const client = createClient({ apiKey: config.apiKey, timeout: CLAUDE_TIMEOUT_MS, maxRetries: 0 });
    await withTimeout(
      () =>
        client.messages.create({
          model: config.model,
          max_tokens: PROBE_MAX_TOKENS,
          messages: [{ role: 'user', content: PROBE_PROMPT }],
        }),
      CLAUDE_TIMEOUT_MS,
      'claude',
    );
  };
}
