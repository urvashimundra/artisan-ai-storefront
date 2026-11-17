import { z } from 'zod';
import { MAX_TIER_QUANTITY } from '../../domain/knowledgeRules.js';

/** Name of the structured tool that ends the run. */
export const FINAL_TOOL_NAME = 'final_answer';
export const MAX_MODEL_TEXT_LENGTH = 2000;
const MAX_QUERY_LENGTH = 80;
const MAX_ID_LENGTH = 60;

export const OUTCOMES = Object.freeze({ ANSWERED: 'answered', NEEDS_SELLER: 'needs_seller' });

/** The model's final answer. Strict: nothing but the outcome and the text. */
export const finalAnswerSchema = z.object({ outcome: z.enum(Object.values(OUTCOMES)), text: z.string().min(1).max(MAX_MODEL_TEXT_LENGTH) }).strict();

/** Tool inputs. Strict: an unknown key (for example a store id) is rejected, and the store is never a parameter. */
export const searchProductsSchema = z.object({ query: z.string().max(MAX_QUERY_LENGTH).optional() }).strict();
export const checkProductSchema = z.object({ productId: z.string().min(1).max(MAX_ID_LENGTH) }).strict();
export const calculateQuoteSchema = z
  .object({ productId: z.string().min(1).max(MAX_ID_LENGTH), quantity: z.number().int().min(1).max(MAX_TIER_QUANTITY) })
  .strict();
const noInputSchema = z.object({}).strict();

const jsonSchema = (schema) => {
  const { $schema: _omitted, ...rest } = z.toJSONSchema(schema, { io: 'input' });
  return rest;
};

/** The read-only tools offered to the model, and the forced-structure final tool. No tool can write anything. */
export const TOOL_DEFINITIONS = Object.freeze([
  { name: 'get_shop_info', description: "The shop's name, tagline, story and the languages it serves. No contact details.", input_schema: jsonSchema(noInputSchema) },
  { name: 'read_knowledge', description: "The seller's own notes (delivery, returns, custom orders, care and so on) and the CONFIRMED bulk discount tiers.", input_schema: jsonSchema(noInputSchema) },
  { name: 'search_products', description: 'List the published products of this shop, optionally filtered by a word in the title. Prices are placeholders.', input_schema: jsonSchema(searchProductsSchema) },
  { name: 'check_product', description: 'Details of one published product: title, description, stock and a price placeholder.', input_schema: jsonSchema(checkProductSchema) },
  {
    name: 'calculate_quote',
    description: 'Exact quote for a quantity of one published product. Applies only the confirmed bulk tiers. All amounts are placeholders to copy into your answer.',
    input_schema: jsonSchema(calculateQuoteSchema),
  },
]);

/** The final tool definition, derived from the same Zod schema as the validation. */
export const FINAL_TOOL = Object.freeze({
  name: FINAL_TOOL_NAME,
  description: 'Give the final answer to the customer. Use outcome needs_seller when the answer is not in the shop notes or data.',
  input_schema: jsonSchema(finalAnswerSchema),
});
