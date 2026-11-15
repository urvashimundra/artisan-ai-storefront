import { Router } from 'express';
import { createAuthController } from '../controllers/authController.js';
import { createStoreController } from '../controllers/storeController.js';
import { createAuthLimiters } from '../middleware/authRateLimits.js';
import { loadSession, requireOwner } from '../middleware/loadSession.js';
import { originCheck } from '../middleware/originCheck.js';

const noStore = (_req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
};

/**
 * Browser routes: signup (only when an invite code is configured), login, logout, dashboard and store creation.
 * The guard is applied per route so unmatched paths keep their plain 404. Order per route: no-store, Origin check
 * (state-changing requests), session, limiters, authentication, controller.
 * @param {{ config: object, services: { auth: object, sessions: object, stores: object }, authRateLimits?: object }} deps
 * @returns {import('express').Router}
 */
export function createBrowserRouter({ config, services, authRateLimits }) {
  const router = Router();
  const signupEnabled = Boolean(config.signupInviteCode);
  const limiters = createAuthLimiters(authRateLimits);
  const pageLocals = (_req, res, next) => {
    Object.assign(res.locals, { signupEnabled, showAuthLinks: true });
    next();
  };
  const guard = [
    noStore,
    originCheck(config.allowedOrigins),
    loadSession({ sessions: services.sessions, cookie: config.cookie }),
    pageLocals,
  ];
  const ownerOnly = [...guard, requireOwner()];
  const auth = createAuthController({ ...services, cookie: config.cookie });
  const store = createStoreController({ stores: services.stores });

  if (signupEnabled) {
    router.get('/signup', ...guard, auth.showSignup);
    router.post('/signup', ...guard, limiters.signup, auth.postSignup);
  }
  router.get('/login', ...guard, auth.showLogin);
  router.post('/login', ...guard, limiters.loginIp, limiters.loginFailure, auth.postLogin);
  router.post('/logout', ...guard, auth.postLogout);
  router.get('/dashboard', ...ownerOnly, store.dashboard);
  router.get('/store/new', ...ownerOnly, store.showNewStore);
  router.post('/store/new', ...ownerOnly, store.postNewStore);
  return router;
}
