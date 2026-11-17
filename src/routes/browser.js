import express, { Router } from 'express';
import { createProductController } from '../controllers/productController.js';
import { createAuthController } from '../controllers/authController.js';
import { createOwnerOrderController } from '../controllers/ownerOrderController.js';
import { createKnowledgeController } from '../controllers/knowledgeController.js';
import { createOnboardingController } from '../controllers/onboardingController.js';
import { createShopSettingsController } from '../controllers/shopSettingsController.js';
import { createStoreController } from '../controllers/storeController.js';
import { createAuthLimiters } from '../middleware/authRateLimits.js';
import { loadSession, requireOwner } from '../middleware/loadSession.js';
import { loadStore } from '../middleware/loadStore.js';
import { originCheck } from '../middleware/originCheck.js';
import { createProductLimiters } from '../middleware/productRateLimits.js';
import { MAX_IMAGE_BYTES } from '../domain/imageUpload.js';

export const PRODUCT_FORM_BODY_LIMIT = '128kb';
/** 20,000 Gujarati characters are 9 bytes each URL-encoded, so the notes form needs a larger limit. */
export const KNOWLEDGE_FORM_BODY_LIMIT = '256kb';
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
  const productLimiters = createProductLimiters(productRateLimits);
  const pageLocals = (_req, res, next) => {
    Object.assign(res.locals, { signupEnabled, showAuthLinks: true, productsEnabled: Boolean(services.products && services.listings),
      ordersEnabled: Boolean(services.orders), knowledgeEnabled: Boolean(services.knowledge) });
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
  const store = createStoreController({
    stores: services.stores,
    baseUrl: config.baseUrl,
    translations: services.translations,
    products: services.products,
    orders: services.orders,
    canDraft: Boolean(services.translationDrafts),
  });
  const settings = createShopSettingsController({
    stores: services.stores,
    translations: services.translations,
    drafts: services.translationDrafts,
  });
  const onboarding = createOnboardingController({
    stores: services.stores,
    translations: services.translations,
    drafts: services.translationDrafts,
  });
  const settingsForm = express.urlencoded({ extended: false, limit: PRODUCT_FORM_BODY_LIMIT });
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
  router.post('/store/new', ...ownerOnly, settingsForm, store.postNewStore);
  router.get('/store/new/contact', ...storeGuard, onboarding.showContact);
  router.post('/store/new/contact', ...storeGuard, settingsForm, onboarding.postContact);
  router.get('/store/new/languages', ...storeGuard, onboarding.showLanguages);
  router.post('/store/new/languages', ...storeGuard, productLimiters.draft, onboarding.draftLanguages);
  router.post('/store/new/languages/approve', ...storeGuard, onboarding.approveLanguages);
  router.get('/store/settings', ...storeGuard, settings.show);
  router.post('/store/settings', ...storeGuard, settingsForm, settings.save);
  router.post('/store/settings/translations', ...storeGuard, settingsForm, settings.saveTranslation);
  if (services.translationDrafts) {
    router.post('/store/settings/translations/draft', ...storeGuard, productLimiters.draft, settings.draftTranslations);
  }
  if (services.products && services.listings) {
    mountProductRoutes(router, { ownerOnly, services, limiters: productLimiters });
  }
  if (services.orders) mountOrderRoutes(router, { storeGuard, orders: services.orders });
  if (services.knowledge) mountKnowledgeRoutes(router, { storeGuard, knowledge: services.knowledge, limiters: productLimiters });
  return router;
}

/**
 * Owner Orders routes. Guard order: no-store, Origin check, session, owner, store (from the session). The order id in the URL
 * is only ever looked up inside that store; state changes are POST-only.
 */
function mountOrderRoutes(router, { storeGuard, orders }) {
  const controller = createOwnerOrderController({ orders });
  router.get('/orders', ...storeGuard, controller.list);
  router.get('/orders/:id', ...storeGuard, controller.detail);
  router.post('/orders/:id/paid', ...storeGuard, controller.markPaid);
  router.post('/orders/:id/not-received', ...storeGuard, controller.markNotReceived);
  router.post('/orders/:id/cancel', ...storeGuard, controller.cancel);
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

/**
 * Owner shop-notes routes. Guard order: no-store, Origin check, session, owner, store (from the session). The Claude search has its own
 * limiter (the same one as translation drafts) and runs before the body is parsed.
 */
function mountKnowledgeRoutes(router, { storeGuard, knowledge, limiters }) {
  const controller = createKnowledgeController({ knowledge });
  const form = express.urlencoded({ extended: false, limit: KNOWLEDGE_FORM_BODY_LIMIT });
  router.get('/store/knowledge', ...storeGuard, controller.show);
  router.post('/store/knowledge', ...storeGuard, form, controller.saveDocument);
  router.post('/store/knowledge/rules', ...storeGuard, form, controller.saveRules);
  router.post('/store/knowledge/rules/find', ...storeGuard, limiters.draft, controller.findRules);
}

