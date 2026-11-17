import Anthropic from '@anthropic-ai/sdk';
import { estimateMaxCostMicroUsd } from '../domain/aiCost.js';
import { MAX_ANSWER_LENGTH, MAX_MODEL_CALLS, SELLER_NOTICE_PREFIX } from '../domain/enquiryRules.js';
import { MAX_KNOWLEDGE_LENGTH } from '../domain/knowledgeRules.js';
import { codePointLength } from '../domain/productRules.js';
import { LANGUAGE_NAMES_ENGLISH } from '../domain/language.js';
import { stringsFor } from '../domain/publicStrings.js';
import { formatInr } from '../lib/money.js';
import { withTimeout } from '../lib/timeout.js';
import { echoBlocks, finishTrace, runTools, toolUseBlocks } from './agentSupport.js';
import { buildSourceBook, descriptiveFigures, maskDocumentAmounts, normalizeForMatch, substituteDocumentAmounts, verifiedClaims, verifiedConflict } from './knowledgeSources.js';
import { INDIC_TOKENS_PER_CHARACTER } from './listingCost.js';
import { classifyFailure, readUsage } from './listingGenerator.js';
import { hasTypedAmount, resolveMoney } from './moneyPlaceholders.js';
import { CONVERSATION_PROMPT_VERSION, buildConversationSystemPrompt, buildConversationUserText } from './prompts/conversationV1.js';
import {
  CONVERSATION_FINAL_TOOL, CONVERSATION_FINAL_TOOL_NAME, CONVERSATION_OUTCOMES, CONVERSATION_TOOL_DEFINITIONS, conversationAnswerSchema,
} from './schemas/conversationAnswer.js';
import { hasEnglishLabelWords, requiredReplyLanguage, textUsesScript } from './scriptCheck.js';

/** Output cap per model call: tool calls are short and the final answer is a few sentences. */
export const CONVERSATION_STEP_MAX_OUTPUT_TOKENS = 1500;
const PROMPT_TOKEN_ALLOWANCE = 2500;
const BUDGET_ERROR_CODES = new Set(['AI_BUDGET_EXHAUSTED', 'AI_BUDGET_UNAVAILABLE']);
const REFUSAL_STOP_REASON = 'refusal';
const HTTP_TOO_MANY_REQUESTS = 429;
const HTTP_OVERLOADED = 529;
const ALLOWED_TOOLS = new Set(CONVERSATION_TOOL_DEFINITIONS.map((tool) => tool.name));
const FINAL_RETRY_MESSAGE = 'The final_answer was not valid. Call final_answer again. Set language to the language the text is really written in. For outcome answered give text using only money placeholders you were given and quote sources verbatim. For outcome needs_seller give text saying exactly what is missing. For outcome conflict give a topic, affects_question and at least two verbatim excerpts from two different sources.';
const CONFLICT_NOT_ASKED_MESSAGE = 'The conflict was refused: affects_question must be copied exactly from the part of the customer’s LATEST message that depends on the contested fact. If the latest message does not ask about the contested fact, do not use conflict: answer what was asked, leave the contested fact out completely, and put one short sentence about it in seller_notice. If you cannot answer, use needs_seller.';
const VOLUNTEERED_MESSAGE = 'The answer text repeats a fact you named in seller_notice as contested between sources. Never state a contested fact. Call final_answer again without it.';
const MIN_AFFECTS_LENGTH = 3;
const MIN_OVERLAP_WORDS = 3;
const WORD = /[\p{L}\p{N}]+/gu;
const wrongLanguageMessage = (language) => `The answer text is not written in ${LANGUAGE_NAMES_ENGLISH[language]}, which is the language this reply must be in. Call final_answer again with the whole text in ${LANGUAGE_NAMES_ENGLISH[language]}, keeping product names as they are written.`;
const NO_TOOL_MESSAGE = 'Call the final_answer tool now.';
const PLACEHOLDER_ANYWHERE = /{{[^}]*}}/g;
const withoutPlaceholders = (text) => text.replace(PLACEHOLDER_ANYWHERE, '');

const failed = (state, reason, detail) => ({ ok: false, reason, detail, language: state.replyLanguage, trace: finishTrace(state), steps: state.steps, charged: state.charged });
const succeeded = (state, { sellerNotice, ...fields }) => ({
  ok: true, text: null, sources: [], conflict: null, language: state.replyLanguage, ...fields, trace: finishTrace(state, sellerNotice ? [`${SELLER_NOTICE_PREFIX}${sellerNotice}`] : []), steps: state.steps, charged: state.charged,
});

/** True when the text quotes part of the customer's latest message (whitespace and case ignored): the part that depends on a contested fact. */
export const quotesLatestMessage = (quote, latest) => {
  const needle = normalizeForMatch(quote);
  return codePointLength(needle) >= MIN_AFFECTS_LENGTH && normalizeForMatch(latest).includes(needle);
};

const wordsOf = (text) => normalizeForMatch(text).match(WORD) ?? [];

/** True when the answer repeats a run of words from the seller notice: the model named a contested fact and then stated it anyway. */
export function repeatsNotice(answer, notice) {
  const words = wordsOf(answer);
  const runs = new Set(wordsOf(notice).flatMap((_word, index, all) => (index + MIN_OVERLAP_WORDS <= all.length ? [all.slice(index, index + MIN_OVERLAP_WORDS).join(' ')] : [])));
  return words.some((_word, index) => runs.has(words.slice(index, index + MIN_OVERLAP_WORDS).join(' ')));
}

/** The seller notice as stored, or undefined when the model typed an amount or a placeholder into it (it is never shown to the customer). */
const usableNotice = (notice) => (notice === undefined || notice.includes('{{') || hasTypedAmount(notice) ? undefined : notice);

/**
 * Why a run threw: budget refusal, a timeout, the provider's 429/529 (rate limit or overload), another provider error, or the network.
 * @param {any} error @returns {{ reason: string, detail: string }}
 */
export function failureOf(error) {
  if (BUDGET_ERROR_CODES.has(error?.code)) return { reason: 'budget', detail: error.code };
  if (error?.name === 'TimeoutError' || error?.kind === 'timeout') return { reason: 'timeout', detail: 'timeout' };
  if (error?.kind === 'http') {
    const limited = error.status === HTTP_TOO_MANY_REQUESTS || error.status === HTTP_OVERLOADED;
    return { reason: limited ? 'provider_limit' : 'provider_error', detail: `http_${error.status}` };
  }
  if (error?.kind === 'network') return { reason: 'network', detail: 'network' };
  return { reason: 'unavailable', detail: 'unexpected' };
}

/** Tools the model may call: only the live-data ones. Anything else (for example the document reader) is answered as an unknown tool. */
const guardTools = (tools) => ({ trace: tools.trace, run: (name, input) => tools.run(ALLOWED_TOOLS.has(name) ? name : '__not_offered__', input) });

/**
 * The conversation assistant: an Anthropic Messages tool-use loop over READ-ONLY live-data tools, with the whole seller document preloaded
 * (never truncated: a document that cannot be included whole stops the run before any model call). Every call is reserved and settled
 * through the budget guard; the ending is validated by code: strict Zod output, money substituted by the server (document amounts too),
 * quotes verified against the real sources, a conflict accepted only when two different quotes check out, and a trace built from the tool
 * calls that really ran. It never throws: every failure is a result with a reason that maps to a customer message.
 * @param {{ config: { apiKey: string, model: string }, createClient?: (options: object) => any,
 *   send?: (request: object, options: { timeoutMs: number }) => Promise<{ response: object, usage: object | null }> }} deps
 */
export function createConversationAgent({ config, createClient = (options) => new Anthropic(options), send }) {
  const client = send ? null : createClient({ apiKey: config.apiKey, maxRetries: 0 });
  const transport = send ?? (async (request, { timeoutMs }) => {
    try {
      const response = await client.messages.create(request, { timeout: timeoutMs });
      return { response, usage: readUsage(response) };
    } catch (error) {
      throw classifyFailure(error);
    }
  });

  async function callModel(state, { forceFinal, budgetedCall, owner, context, now, deadline }) {
    const remainingMs = deadline - now();
    const request = {
      model: config.model,
      max_tokens: CONVERSATION_STEP_MAX_OUTPUT_TOKENS,
      thinking: { type: 'disabled' },
      system: state.system,
      tools: [...CONVERSATION_TOOL_DEFINITIONS, CONVERSATION_FINAL_TOOL],
      tool_choice: forceFinal ? { type: 'tool', name: CONVERSATION_FINAL_TOOL_NAME, disable_parallel_tool_use: true } : { type: 'auto' },
      messages: state.messages,
    };
    const inputTokens = PROMPT_TOKEN_ALLOWANCE + (state.system.length + JSON.stringify(state.messages).length) * INDIC_TOKENS_PER_CHARACTER;
    const estimateMicroUsd = estimateMaxCostMicroUsd({ inputTokens, maxOutputTokens: CONVERSATION_STEP_MAX_OUTPUT_TOKENS });
    const call = () => withTimeout(() => transport(request, { timeoutMs: remainingMs }), remainingMs, 'conversation step');
    const { result, charged } = await budgetedCall({ owner, estimateMicroUsd, context: { ...context, step: state.steps }, call });
    state.charged.inputTokens += charged.inputTokens;
    state.charged.outputTokens += charged.outputTokens;
    state.charged.costMicroUsd += charged.costMicroUsd;
    return result.response;
  }

  const sourceBook = (state) => buildSourceBook({
    maskedDocument: state.document.masked, document: state.document.original, profileTexts: state.profileTexts, descriptions: state.tools.descriptionTexts(),
  });

  /** The words the server inserts for the label placeholders, in the language the answer is written in. */
  const labelsFor = (language) => {
    const strings = stringsFor(language);
    return { unit_price: strings.chatLabelUnitPrice, subtotal: strings.chatLabelSubtotal, discount: strings.chatLabelDiscount, total: strings.chatLabelTotal, in_stock: strings.chatLabelInStock, sold_out: strings.chatLabelSoldOut, available: strings.chatLabelAvailable };
  };

  /** The text of a needs_seller note, or null (the fixed localised notice is used) when it states an unverifiable amount or is not in its language. */
  function sellerNote(text, money, language) {
    return text !== undefined && money.ok && textUsesScript(withoutPlaceholders(text), language) ? money.text : null;
  }

  /** Every text the model was shown that may carry plain figures: product titles and descriptions, the seller notes and the shop profile. */
  const figureTexts = (state) => [...state.tools.shownTexts(), state.document.masked, ...state.profileTexts];

  async function evaluateFinal(block, state, { quoteNote }) {
    const parsed = conversationAnswerSchema.safeParse(block.input);
    if (!parsed.success) return { retry: true };
    const { outcome, text, sources = [], conflict, seller_notice: rawNotice } = parsed.data;
    const sellerNotice = usableNotice(rawNotice);
    const language = state.replyLanguage;
    const refs = new Map([...state.tools.refs, ...state.document.refs]);
    const [allowedPercents, allowedNumbers] = await Promise.all([state.tools.allowedPercents(), state.tools.verifiedNumbers()]);
    const money = text === undefined ? { ok: false } : resolveMoney(text, { refs, percentRefs: state.tools.percentRefs, tiers: await state.tools.confirmedTiers(), allowedPercents, allowedNumbers, descriptive: descriptiveFigures(figureTexts(state)), labels: labelsFor(language), maxLength: MAX_ANSWER_LENGTH - quoteNote.length - 2 });
    const stockShortage = state.tools.stockShortage();
    if (stockShortage) return { result: succeeded(state, { outcome: CONVERSATION_OUTCOMES.NEEDS_SELLER, stockShortage }) };
    if (outcome === CONVERSATION_OUTCOMES.CONFLICT) {
      if (!quotesLatestMessage(conflict.affects_question, state.latestCustomer)) return { retry: true, message: CONFLICT_NOT_ASKED_MESSAGE };
      const checked = verifiedConflict(conflict, sourceBook(state), (excerpt) => substituteDocumentAmounts(excerpt, state.document.refs, formatInr));
      return checked ? { result: succeeded(state, { outcome, conflict: checked }) } : { retry: true };
    }
    if (outcome === CONVERSATION_OUTCOMES.NEEDS_SELLER) return { result: succeeded(state, { outcome, text: sellerNote(text, money, language), sellerNotice }) };
    if (!money.ok && money.reason === 'unverified_amount') return { result: failed(state, 'unverified_amount', 'typed_amount') };
    const bare = withoutPlaceholders(text);
    if (!money.ok) return { retry: true };
    if (!textUsesScript(bare, language)) return state.retried ? { result: succeeded(state, { outcome: CONVERSATION_OUTCOMES.NEEDS_SELLER }) } : { retry: true, message: wrongLanguageMessage(language) };
    if (hasEnglishLabelWords(bare, language, state.tools.shownTitles())) return { retry: true };
    if (sellerNotice && repeatsNotice(money.text, sellerNotice)) return { retry: true, message: VOLUNTEERED_MESSAGE };
    const verified = verifiedClaims(sources, sourceBook(state), { usedLiveData: state.tools.usedLiveData() });
    const answer = money.usedQuote ? `${money.text}\n\n${quoteNote}` : money.text;
    return { result: succeeded(state, { outcome, text: answer, sources: verified, sellerNotice }) };
  }

  async function loop(state, input) {
    for (state.steps = 1; state.steps <= MAX_MODEL_CALLS; state.steps += 1) {
      if (input.now() >= input.deadline) return failed(state, 'timeout', 'wall_clock');
      const response = await callModel(state, { ...input, forceFinal: state.steps === MAX_MODEL_CALLS });
      if (response?.stop_reason === REFUSAL_STOP_REASON) return failed(state, 'refused', 'refused');
      const blocks = toolUseBlocks(response);
      state.messages.push({ role: 'assistant', content: echoBlocks(response) });
      const final = blocks.find((block) => block.name === CONVERSATION_FINAL_TOOL_NAME);
      const results = await runTools(blocks.filter((block) => block !== final), guardTools(state.tools));
      if (final) {
        const verdict = await evaluateFinal(final, state, input);
        if (verdict.result) return verdict.result;
        results.push({ type: 'tool_result', tool_use_id: final.id, content: verdict.message ?? FINAL_RETRY_MESSAGE, is_error: true });
      }
      if (blocks.length === 0) results.push({ type: 'text', text: NO_TOOL_MESSAGE });
      if ((final || blocks.length === 0) && state.retried) return failed(state, 'invalid_output', 'invalid_output');
      state.retried ||= Boolean(final) || blocks.length === 0;
      state.messages.push({ role: 'user', content: results });
    }
    return failed(state, 'too_complex', 'step_cap');
  }

  return {
    model: config.model,
    promptVersion: CONVERSATION_PROMPT_VERSION,

    /**
     * @param {{ shop: { name: string, story: string, tagline: string }, language: 'en' | 'gu' | 'hi',
     *   messages: { role: string, body: string }[], knowledge: { content: string }, productId?: string | null,
     *   tools: ReturnType<typeof import('./tools/enquiryTools.js').createEnquiryTools>, quoteNote: string, budgetedCall: Function,
     *   owner: { id: string, isDemo: boolean }, context?: object, now?: () => number, wallClockMs: number }} input
     *   messages: the latest messages (at most eight), oldest first, the last one is the customer's new message.
     * @returns {Promise<{ ok: true, outcome: 'answered' | 'needs_seller' | 'conflict', text: string | null, sources: object[], conflict: object | null,
     *   trace: string[], steps: number, charged: object } | { ok: false, reason: string, detail: string, trace: string[], steps: number, charged: object }>}
     */
    async run({ shop, language, messages, knowledge, productId = null, tools, quoteNote, budgetedCall, owner, context = {}, now = Date.now, wallClockMs }) {
      const state = { tools, steps: 0, retried: false, charged: { inputTokens: 0, outputTokens: 0, costMicroUsd: 0 } };
      if (codePointLength(knowledge.content) > MAX_KNOWLEDGE_LENGTH) return failed(state, 'knowledge_too_long', 'document_too_long');
      const masked = maskDocumentAmounts(knowledge.content);
      state.document = { masked: masked.text, original: knowledge.content, refs: masked.refs };
      state.profileTexts = [shop.story, shop.tagline].filter((text) => typeof text === 'string' && text !== '');
      const customerTexts = messages.filter((message) => message.role === 'customer').map((message) => message.body);
      state.latestCustomer = customerTexts.at(-1) ?? '';
      state.replyLanguage = requiredReplyLanguage(state.latestCustomer, language);
      state.system = buildConversationSystemPrompt({ shopName: shop.name, language: state.replyLanguage, maskedDocument: masked.text, story: shop.story, tagline: shop.tagline });
      try {
        const records = await tools.recordsFor(customerTexts, productId);
        state.messages = [{ role: 'user', content: buildConversationUserText({ messages, productId, records }) }];
        return await loop(state, { quoteNote, budgetedCall, owner, context, now, deadline: now() + wallClockMs });
      } catch (error) {
        const { reason, detail } = failureOf(error);
        return failed(state, reason, detail);
      }
    },
  };
}
