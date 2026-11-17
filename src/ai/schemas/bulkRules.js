import { z } from 'zod';
import { MAX_BULK_TIERS, tiersSchema } from '../../domain/knowledgeRules.js';

/** Name of the forced tool the model must call. */
export const BULK_RULES_TOOL_NAME = 'report_bulk_rules';

const reportSchema = z
  .object({ tiers: z.array(z.object({ minQty: z.number().int(), percentOff: z.number().int() }).strict()).max(MAX_BULK_TIERS) })
  .strict();

/**
 * Validates the model's report. The tiers are sorted by quantity first (order is not the model's job), then must pass the same
 * schema the owner's own entry passes. Anything else is invalid output. The result is only a PREFILL: nothing is used until the owner saves.
 * @param {unknown} input
 * @returns {{ ok: true, tiers: { minQty: number, percentOff: number }[] } | { ok: false }}
 */
export function parseBulkRulesOutput(input) {
  const report = reportSchema.safeParse(input);
  if (!report.success) return { ok: false };
  const sorted = [...report.data.tiers].sort((a, b) => a.minQty - b.minQty);
  const tiers = tiersSchema.safeParse(sorted);
  return tiers.success ? { ok: true, tiers: tiers.data } : { ok: false };
}

/** The forced tool definition. JSON Schema is derived from the same Zod schema so the two cannot drift. */
export function buildBulkRulesTool() {
  const { $schema: _omitted, ...schema } = z.toJSONSchema(reportSchema, { io: 'input' });
  return {
    name: BULK_RULES_TOOL_NAME,
    description: 'Report the explicit bulk-discount tiers stated in the seller notes. Use an empty list when there are none.',
    input_schema: schema,
  };
}
