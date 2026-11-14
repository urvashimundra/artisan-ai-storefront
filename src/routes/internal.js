import { Router } from 'express';
import { diagnosticsController } from '../controllers/diagnosticsController.js';
import { requireDiagnosticsEnabled, requireDiagnosticsToken } from '../middleware/diagnosticsAccess.js';
import { createRateLimiter } from '../middleware/rateLimit.js';

export const DIAGNOSTICS_WINDOW_MS = 60_000;
export const DIAGNOSTICS_LIMIT = 5;

/**
 * Internal routes. The diagnostics route is invisible (404) unless a token is configured, is rate
 * limited before the token check so guessing is throttled, and requires the token header.
 * @param {{ diagnosticsToken: string | undefined, diagnostics: object }} deps
 * @returns {import('express').Router}
 */
export function createInternalRouter({ diagnosticsToken, diagnostics }) {
  const router = Router();
  router.get(
    '/internal/diagnostics',
    requireDiagnosticsEnabled(diagnosticsToken),
    createRateLimiter({ windowMs: DIAGNOSTICS_WINDOW_MS, limit: DIAGNOSTICS_LIMIT }),
    requireDiagnosticsToken(diagnosticsToken),
    diagnosticsController({ diagnostics }),
  );
  return router;
}
