import { z } from 'zod';
import { MAX_EXCERPT_LENGTH, SOURCE_LABELS } from '../knowledgeSources.js';
import { calculateQuoteSchema, checkProductSchema, searchProductsSchema } from './enquiryAnswer.js';

export const CONVERSATION_FINAL_TOOL_NAME = 'final_answer';
export const MAX_ANSWER_TEXT_LENGTH = 2000;
const MAX_TOPIC_LENGTH = 120;
const MAX_CITED_SOURCES = 4;
const MIN_CONFLICT_CLAIMS = 2;
const MAX_CONFLICT_CLAIMS = 4;

export const CONVERSATION_OUTCOMES = Object.freeze({ ANSWERED: 'answered', NEEDS_SELLER: 'needs_seller', CONFLICT: 'conflict' });

const label = z.enum(SOURCE_LABELS);
const excerpt = z.string().min(1).max(MAX_EXCERPT_LENGTH);
const citedSource = z.object({ label, excerpt: excerpt.optional() }).strict();
const conflictClaim = z.object({ label: z.enum(SOURCE_LABELS.filter((name) => name !== 'live_catalog')), excerpt }).strict();

/**
 * The model's final answer. Strict. `answered` needs text; `conflict` needs a conflict with at least two quoted claims and no answer text;
 * `needs_seller` may carry one short honest sentence. Nothing here is trusted: the agent verifies every quote against the real sources.
 */
export const conversationAnswerSchema = z
  .object({
    outcome: z.enum(Object.values(CONVERSATION_OUTCOMES)),
    text: z.string().min(1).max(MAX_ANSWER_TEXT_LENGTH).optional(),
    sources: z.array(citedSource).max(MAX_CITED_SOURCES).optional(),
    conflict: z.object({ topic: z.string().min(1).max(MAX_TOPIC_LENGTH), claims: z.array(conflictClaim).min(MIN_CONFLICT_CLAIMS).max(MAX_CONFLICT_CLAIMS) }).strict().optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const needsText = value.outcome === CONVERSATION_OUTCOMES.ANSWERED && value.text === undefined;
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
  { name: 'search_products', description: 'LIVE database: list the published products of this shop, optionally filtered by a word in the title. Prices are placeholders.', input_schema: jsonSchema(searchProductsSchema) },
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
    'Give the final result. outcome "answered": text plus the sources you used (quote each document excerpt exactly). outcome "needs_seller": the answer is not in any source. outcome "conflict": two written sources contradict each other; give the topic and a verbatim excerpt of each.',
  input_schema: jsonSchema(conversationAnswerSchema),
});
