import Anthropic from '@anthropic-ai/sdk';
import { estimateMaxCostMicroUsd } from '../domain/aiCost.js';
import { AGENT_WALL_CLOCK_MS, MAX_ANSWER_LENGTH, MAX_MODEL_CALLS, MAX_TRACE_ITEMS, MAX_TRACE_ITEM_LENGTH } from '../domain/enquiryRules.js';
import { withTimeout } from '../lib/timeout.js';
import { classifyFailure, readUsage } from './listingGenerator.js';
import { INDIC_TOKENS_PER_CHARACTER } from './listingCost.js';
import { resolveMoney } from './moneyPlaceholders.js';
import { ENQUIRY_PROMPT_VERSION, buildEnquirySystemPrompt, buildEnquiryUserText } from './prompts/enquiryV1.js';
import { FINAL_TOOL, FINAL_TOOL_NAME, OUTCOMES, TOOL_DEFINITIONS, finalAnswerSchema } from './schemas/enquiryAnswer.js';
import { textUsesScript } from './scriptCheck.js';

/** Output cap per model call: small, because tool calls are short and the final answer is a few sentences. */
export const STEP_MAX_OUTPUT_TOKENS = 1500;
/** Tokens reserved for the system prompt, the tool definitions and message framing. */
const PROMPT_TOKEN_ALLOWANCE = 2500;
const BUDGET_ERROR_CODES = new Set(['AI_BUDGET_EXHAUSTED', 'AI_BUDGET_UNAVAILABLE']);
const REFUSAL_STOP_REASON = 'refusal';
const FINAL_RETRY_MESSAGE = 'The final_answer was not valid. Call final_answer again with a valid outcome, and text in the customer\'s language that uses only the money placeholders the tools gave you.';
const NO_TOOL_MESSAGE = 'Call the final_answer tool now.';

/** Why a run ended without an answer. `reason` maps to the enquiry's flag_reason; `detail` is for logs only. */
const failed = (state, reason, detail) => ({ ok: false, reason, detail, trace: finishTrace(state), steps: state.steps, charged: state.charged });
const finishTrace = (state) => state.tools.trace.slice(0, MAX_TRACE_ITEMS).map((item) => Array.from(item).slice(0, MAX_TRACE_ITEM_LENGTH).join(''));

function failureOf(error) {
  if (BUDGET_ERROR_CODES.has(error?.code)) return { reason: 'budget', detail: error.code };
  const timedOut = error?.name === 'TimeoutError' || error?.kind === 'timeout';
  return { reason: 'error', detail: timedOut ? 'timeout' : (error?.kind ?? 'unexpected') };
}

const toolUseBlocks = (response) => (Array.isArray(response?.content) ? response.content : []).filter((block) => block?.type === 'tool_use');

/** Re-sends only the block fields the API needs, never anything else the response happened to carry. */
const echoBlocks = (response) =>
  (Array.isArray(response?.content) ? response.content : []).flatMap((block) => {
    if (block?.type === 'text') return [{ type: 'text', text: String(block.text ?? '') }];
    if (block?.type === 'tool_use') return [{ type: 'tool_use', id: block.id, name: block.name, input: block.input ?? {} }];
    return [];
  });

/**
 * The shop assistant: an Anthropic Messages tool-use loop over READ-ONLY tools. At most six model calls, a wall-clock cap, every call
 * reserved and settled through the budget guard, and an ending that is validated by code: a strict final_answer, money placeholders
 * substituted by the server, typed amounts and unconfirmed percentages discarded, and a trace built from the tool calls that really ran.
 * It never throws: every failure is a result with a reason.
 * @param {{ config: { apiKey: string, model: string }, createClient?: (options: object) => any,
 *   send?: (request: object, options: { timeoutMs: number }) => Promise<{ response: object, usage: object | null }> }} deps
 *   `send` replaces the real provider call (tests).
 */
export function createEnquiryAgent({ config, createClient = (options) => new Anthropic(options), send }) {
  const client = send ? null : createClient({ apiKey: config.apiKey, maxRetries: 0 });
  const transport = send ?? (async (request, { timeoutMs }) => {
    try {
      const response = await client.messages.create(request, { timeout: timeoutMs });
      return { response, usage: readUsage(response) };
    } catch (error) {
      throw classifyFailure(error);
    }
  });

  /** One budgeted, time-boxed model call. */
  async function callModel(state, { forceFinal, budgetedCall, owner, context, now, deadline }) {
    const remainingMs = deadline - now();
    const request = {
      model: config.model,
      max_tokens: STEP_MAX_OUTPUT_TOKENS,
      thinking: { type: 'disabled' },
      system: state.system,
      tools: [...TOOL_DEFINITIONS, FINAL_TOOL],
      tool_choice: forceFinal ? { type: 'tool', name: FINAL_TOOL_NAME, disable_parallel_tool_use: true } : { type: 'auto' },
      messages: state.messages,
    };
    const inputTokens = PROMPT_TOKEN_ALLOWANCE + JSON.stringify(state.messages).length * INDIC_TOKENS_PER_CHARACTER;
    const estimateMicroUsd = estimateMaxCostMicroUsd({ inputTokens, maxOutputTokens: STEP_MAX_OUTPUT_TOKENS });
    const call = () => withTimeout(() => transport(request, { timeoutMs: remainingMs }), remainingMs, 'enquiry step');
    const { result, charged } = await budgetedCall({ owner, estimateMicroUsd, context: { ...context, step: state.steps }, call });
    state.charged.inputTokens += charged.inputTokens;
    state.charged.outputTokens += charged.outputTokens;
    state.charged.costMicroUsd += charged.costMicroUsd;
    return result.response;
  }

  async function runTools(blocks, tools) {
    const results = [];
    for (const block of blocks) {
      const { content, isError } = await tools.run(block.name, block.input);
      results.push({ type: 'tool_result', tool_use_id: block.id, content: JSON.stringify(content), ...(isError ? { is_error: true } : {}) });
    }
    return results;
  }

  /** Validates the final_answer. @returns {Promise<{ result: object } | { retry: true }>} */
  async function evaluateFinal(block, state, { language, quoteNote }) {
    const parsed = finalAnswerSchema.safeParse(block.input);
    if (!parsed.success) return { retry: true };
    const { outcome, text } = parsed.data;
    const [allowedPercents, allowedNumbers] = await Promise.all([state.tools.allowedPercents(), state.tools.verifiedNumbers()]);
    const money = resolveMoney(text, { refs: state.tools.refs, allowedPercents, allowedNumbers, maxLength: MAX_ANSWER_LENGTH - quoteNote.length - 2 });
    if (state.tools.hasStockShortage()) {
      return { result: { ok: true, outcome: OUTCOMES.NEEDS_SELLER, text: null, trace: finishTrace(state), steps: state.steps, charged: state.charged } };
    }
    if (outcome === OUTCOMES.NEEDS_SELLER) {
      return { result: { ok: true, outcome, text: money.ok ? money.text : null, trace: finishTrace(state), steps: state.steps, charged: state.charged } };
    }
    if (!money.ok && money.reason === 'unverified_amount') return { result: failed(state, 'unverified_amount', 'typed_amount') };
    if (!money.ok || !textUsesScript(text.replace(/\{\{[^}]*\}\}/g, ''), language)) return { retry: true };
    const answer = money.usedQuote ? `${money.text}\n\n${quoteNote}` : money.text;
    return { result: { ok: true, outcome, text: answer, trace: finishTrace(state), steps: state.steps, charged: state.charged } };
  }

  async function loop(state, input) {
    for (state.steps = 1; state.steps <= MAX_MODEL_CALLS; state.steps += 1) {
      if (input.now() >= input.deadline) return failed(state, 'error', 'timeout');
      const response = await callModel(state, { ...input, forceFinal: state.steps === MAX_MODEL_CALLS });
      if (response?.stop_reason === REFUSAL_STOP_REASON) return failed(state, 'error', 'refused');
      const blocks = toolUseBlocks(response);
      state.messages.push({ role: 'assistant', content: echoBlocks(response) });
      const final = blocks.find((block) => block.name === FINAL_TOOL_NAME);
      const results = await runTools(blocks.filter((block) => block !== final), state.tools);
      if (final) {
        const verdict = await evaluateFinal(final, state, input);
        if (verdict.result) return verdict.result;
        results.push({ type: 'tool_result', tool_use_id: final.id, content: FINAL_RETRY_MESSAGE, is_error: true });
      }
      if (blocks.length === 0) results.push({ type: 'text', text: NO_TOOL_MESSAGE });
      if ((final || blocks.length === 0) && state.retried) return failed(state, 'error', 'invalid_output');
      state.retried ||= Boolean(final) || blocks.length === 0;
      state.messages.push({ role: 'user', content: results });
    }
    return failed(state, 'too_complex', 'step_cap');
  }

  return {
    model: config.model,
    promptVersion: ENQUIRY_PROMPT_VERSION,

    /**
     * @param {{ shopName: string, language: 'en' | 'gu' | 'hi', question: string, productId: string | null,
     *   tools: ReturnType<typeof import('./tools/enquiryTools.js').createEnquiryTools>, quoteNote: string,
     *   budgetedCall: Function, owner: { id: string, isDemo: boolean }, context?: object, now?: () => number, wallClockMs?: number }} input
     * @returns {Promise<{ ok: true, outcome: 'answered' | 'needs_seller', text: string | null, trace: string[], steps: number, charged: object }
     *   | { ok: false, reason: 'budget' | 'error' | 'too_complex' | 'unverified_amount', detail: string, trace: string[], steps: number, charged: object }>}
     */
    async run({ shopName, language, question, productId, tools, quoteNote, budgetedCall, owner, context = {}, now = Date.now, wallClockMs = AGENT_WALL_CLOCK_MS }) {
      const state = {
        tools,
        system: buildEnquirySystemPrompt({ shopName, language }),
        messages: [{ role: 'user', content: buildEnquiryUserText({ question, productId }) }],
        steps: 0,
        retried: false,
        charged: { inputTokens: 0, outputTokens: 0, costMicroUsd: 0 },
      };
      try {
        return await loop(state, { language, quoteNote, budgetedCall, owner, context, now, deadline: now() + wallClockMs });
      } catch (error) {
        const { reason, detail } = failureOf(error);
        return failed(state, reason, detail);
      }
    },
  };
}
