import express, { Router } from 'express';
import { createContactController } from '../controllers/contactController.js';
import { CONTACT_IP_LIMITS } from '../domain/contactRules.js';
import { originCheck } from '../middleware/originCheck.js';
import { createRateLimiter } from '../middleware/rateLimit.js';

export const CONTACT_FORM_BODY_LIMIT = '32kb';

const noStore = (_req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
};

/**
 * Contact routes of the main site: GET /contact, POST /contact (Origin check, per-IP limit, strict validation in the service)
 * and GET /contact/sent. No session is needed. The per-IP limiter is in memory, per process.
 * @param {{ config: { allowedOrigins: string[] }, contact: { submit: Function },
 *   rateLimits?: { ip?: { windowMs: number, limit: number } } }} deps
 * @returns {import('express').Router}
 */
export function createContactRouter({ config, contact, rateLimits = {} }) {
  const router = Router();
  const controller = createContactController({ contact });
  const pageLocals = (_req, res, next) => {
    Object.assign(res.locals, { showAuthLinks: true });
    next();
  };
  const form = express.urlencoded({ extended: false, limit: CONTACT_FORM_BODY_LIMIT });

  router.get('/contact', noStore, pageLocals, controller.showForm);
  router.get('/contact/sent', noStore, pageLocals, controller.showSent);
  router.post(
    '/contact',
    noStore,
    originCheck(config.allowedOrigins),
    createRateLimiter(rateLimits.ip ?? CONTACT_IP_LIMITS),
    form,
    pageLocals,
    controller.submit,
  );
  return router;
}
