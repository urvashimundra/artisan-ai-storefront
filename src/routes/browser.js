import express, { Router } from 'express';
import { createProductController } from '../controllers/productController.js';
import { createAuthController } from '../controllers/authController.js';
import { createShopSettingsController } from '../controllers/shopSettingsController.js';
import { createStoreController } from '../controllers/storeController.js';
import { createAuthLimiters } from '../middleware/authRateLimits.js';
import { loadSession, requireOwner } from '../middleware/loadSession.js';
import { loadStore } from '../middleware/loadStore.js';
import { originCheck } from '../middleware/originCheck.js';
import { createProductLimiters } from '../middleware/productRateLimits.js';
import { MAX_IMAGE_BYTES } from '../domain/imageUpload.js';

export const PRODUCT_FORM_BODY_LIMIT = '128kb';
const IMAGE_BODY_TYPES = ['image/*', 'application/octet-stream'];

const noStore = (_req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
};

/**
 * Browser routes: shop settings, signup (only when an invite code is configured), login, logout, dashboard and store creation.
 * The guard is applied per route so unmatched paths keep their plain 404. Order per route: no-store, Origin check
 * (state-changing requests), session, limiters, authentication, controller.
 * Product routes are mounted only when `services.products` and `services.listings` are provided.
 * @param {{ config: object, services: { auth: object, sessions: object, stores: object, products?: object, listings?: object },
 *   authRateLimits?: object, productRateLimits?: object }} deps
 * @returns {import('express').Router}
 */
export function createBrowserRouter({ config, services, authRateLimits, productRateLimits }) {
  const router = Router();
  const signupEnabled = Boolean(config.signupInviteCode);
  const limiters = createAuthLimiters(authRateLimits);
  const pageLocals = (_req, res, next) => {
    Object.assign(res.locals, { signupEnabled, showAuthLinks: true, productsEnabled: Boolean(services.products && services.listings) });
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
  const store = createStoreController({ stores: services.stores, baseUrl: config.baseUrl });
  const settings = createShopSettingsController({ stores: services.stores });
  const storeGuard = [...ownerOnly, loadStore({ stores: services.stores })];

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
  router.get('/store/settings', ...storeGuard, settings.show);
  router.post('/store/settings', ...storeGuard, settings.save);
  if (services.products && services.listings) {
    mountProductRoutes(router, { ownerOnly, services, limiters: createProductLimiters(productRateLimits) });
  }
  return router;
}

/**
 * Owner product routes. Order: guard (no-store, Origin check, session, owner), store, limiter, body parser, handler.
 * Limiters run before any body is read, so an over-limit client costs no parsing.
 */
function mountProductRoutes(router, { ownerOnly, services, limiters }) {
  const controller = createProductController({ products: services.products, listings: services.listings });
  const guard = [...ownerOnly, loadStore({ stores: services.stores })];
  const form = express.urlencoded({ extended: false, limit: PRODUCT_FORM_BODY_LIMIT });
  const image = express.raw({ type: IMAGE_BODY_TYPES, limit: MAX_IMAGE_BYTES });

  router.get('/products', ...guard, controller.list);
  router.get('/products/new', ...guard, controller.showNew);
  router.post('/products/image', ...guard, limiters.upload, image, controller.postImage);
  router.get('/products/:id/edit', ...guard, controller.showEdit);
  router.post('/products/:id/generate', ...guard, limiters.generate, form, controller.postGenerate);
  router.post('/products/:id/save', ...guard, form, controller.postSave);
  router.post('/products/:id/delete', ...guard, controller.postDelete);
}
