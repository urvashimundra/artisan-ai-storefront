import { z } from 'zod';
import { CHECK_NAMES, DEFAULT_CHECKS } from '../services/diagnosticsService.js';

const checkList = z
  .string()
  .transform((value) => value.split(','))
  .pipe(z.array(z.enum(CHECK_NAMES)).min(1).max(CHECK_NAMES.length));

const querySchema = z.object({ checks: checkList.optional() }).strict();

/**
 * Runs the requested connectivity checks. Never sends email and returns no secrets.
 * @param {{ diagnostics: { run: (names: string[]) => Promise<object> } }} deps
 * @returns {import('express').RequestHandler}
 */
export function diagnosticsController({ diagnostics }) {
  return async (req, res) => {
    const query = querySchema.parse(req.query);
    const names = query.checks ? [...new Set(query.checks)] : DEFAULT_CHECKS;
    res.json(await diagnostics.run(names));
  };
}
