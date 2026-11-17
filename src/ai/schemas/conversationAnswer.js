import { z } from 'zod';
import { LANGUAGES } from '../../domain/storeRules.js';
import { MAX_EXCERPT_LENGTH, SOURCE_LABELS } from '../knowledgeSources.js';
import { calculateQuoteSchema, checkProductSchema, searchProductsSchema } from './enquiryAnswer.js';

export const CONVERSATION_FINAL_TOOL_NAME = 'final_answer';
export const MAX_ANSWER_TEXT_LENGTH = 2000;
const MAX_TOPIC_LENGTH = 120;
const MAX_CITED_SOURCES = 4;
const MAX_AFFECTS_LENGTH = 300;
export const MAX_SELLER_NOTICE_LENGTH = 100;
const MIN_CONFLICT_CLAIMS = 2;
const MAX_CONFLICT_CLAIMS = 4;

export const CONVERSATION_OUTCOMES = Object.freeze({ ANSWERED: 'answered', NEEDS_SELLER: 'needs_seller', CONFLICT: 'conflict' });

const label = z.enum(SOURCE_LABELS);
const excerpt = z.string().min(1).max(MAX_EXCERPT_LENGTH);
const citedSource = z.object({ label, excerpt: excerpt.optional() }).strict();
const conflictClaim = z.object({ label: z.enum(SOURCE_LABELS.filter((name) => name !== 'live_catalog')), excerpt }).strict();

/**
 * The model's final answer. Strict. `answered` needs text; `conflict` needs a conflict with at least two quoted claims and no answer text;
 * `needs_seller` needs one or two honest sentences saying exactly what is missing. `language` is the language the text is written in (the
 * agent checks the text really is in that script). Nothing here is trusted: the agent verifies every quote against the real sources.
 */
export const conversationAnswerSchema = z
  .object({
    outcome: z.enum(Object.values(CONVERSATION_OUTCOMES)),
    text: z.string().min(1).max(MAX_ANSWER_TEXT_LENGTH).optional(),
    language: z.enum(LANGUAGES).optional(),
    sources: z.array(citedSource).max(MAX_CITED_SOURCES).optional(),
    seller_notice: z.string().min(1).max(MAX_SELLER_NOTICE_LENGTH).optional(),
    conflict: z.object({
      topic: z.string().min(1).max(MAX_TOPIC_LENGTH),
      affects_question: z.string().min(1).max(MAX_AFFECTS_LENGTH),
      claims: z.array(conflictClaim).min(MIN_CONFLICT_CLAIMS).max(MAX_CONFLICT_CLAIMS),
    }).strict().optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const needsText = value.outcome !== CONVERSATION_OUTCOMES.CONFLICT && value.text === undefined;
    const needsConflict = value.outcome === CONVERSATION_OUTCOMES.CONFLICT && value.conflict === undefined;
    const strayConflict = value.outcome !== CONVERSATION_OUTCOMES.CONFLICT && value.conflict !== undefined;
    if (needsText || needsConflict || strayConflict) context.addIssue({ code: 'custom', message: 'outcome does not match the fields given' });
  });

const noInputSchema = z.object({}).strict();
const jsonSchema = (schema) => {
  const { $schema: _omitted, ...rest } = z.toJSONSchema(schema, { io: 'input' });
  return rest;
};

/** The read-only tools of the conversation agent. Documents are preloaded, so there is no read_knowledge; confirmed discounts come from the database. */
export const CONVERSATION_TOOL_DEFINITIONS = Object.freeze([
  {
    name: 'search_products',
    description: 'LIVE database: the published products of this shop, each with title, description, stock and a price placeholder. Call it with NO query to list the whole catalogue (to show products, compare them or recommend one). With a query, the closest matches come first; if nothing matches, the whole catalogue is returned.',
    input_schema: jsonSchema(searchProductsSchema),
  },
  { name: 'check_product', description: 'LIVE database: one published product: title, description, stock and a price placeholder.', input_schema: jsonSchema(checkProductSchema) },
  {
    name: 'calculate_quote',
    description: 'LIVE database: exact quote for a quantity of one published product with the confirmed bulk tiers. All amounts are placeholders to copy into your answer.',
    input_schema: jsonSchema(calculateQuoteSchema),
  },
  { name: 'get_bulk_discounts', description: 'LIVE database: the CONFIRMED bulk discount tiers (minimum quantity and percent off).', input_schema: jsonSchema(noInputSchema) },
]);

export const CONVERSATION_FINAL_TOOL = Object.freeze({
  name: CONVERSATION_FINAL_TOOL_NAME,
  description:
    'Give the final result. Always set language to the language the text is written in. outcome "answered": text plus the sources you used (quote each document excerpt exactly). outcome "needs_seller": the answer is not in any source or the live data; text says exactly what is missing (one or two sentences, no guessing). outcome "conflict": ONLY when the customer’s latest message asks about a fact that two written sources state differently; give the topic, affects_question (the words of the customer’s latest message that depend on that fact, copied exactly) and a verbatim excerpt of each source. seller_notice (optional, one short sentence): a contested fact you noticed that the customer did not ask about; the customer never sees it and you must not mention that fact in text.',
  input_schema: jsonSchema(conversationAnswerSchema),
});
