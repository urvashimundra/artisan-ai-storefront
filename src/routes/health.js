import { Router } from 'express';
import { rootController } from '../controllers/rootController.js';
import { healthController } from '../controllers/healthController.js';

/**
 * @param {{ version: string }} deps
 * @returns {import('express').Router}
 */
export function createHealthRouter({ version }) {
  const router = Router();
  router.get('/', rootController());
  router.get('/health', healthController({ version }));
  return router;
}
