import { STORES_OWNER_ID_KEY, STORES_SLUG_KEY } from '../domain/dbConstraints.js';
import { shopSettingsSchema } from '../domain/shopSettings.js';
import { storeSchema } from '../domain/storeRules.js';
import { AppError, notFound } from '../lib/errors.js';
import { UniqueViolation } from '../repositories/pgErrors.js';

const HTTP_CONFLICT = 409;

export const SLUG_TAKEN = 'SLUG_TAKEN';
export const STORE_EXISTS = 'STORE_EXISTS';

const CONFLICTS = {
  [STORES_SLUG_KEY]: () => new AppError(SLUG_TAKEN, HTTP_CONFLICT, 'That store address is already taken'),
  [STORES_OWNER_ID_KEY]: () => new AppError(STORE_EXISTS, HTTP_CONFLICT, 'You already have a store'),
};

/**
 * Store rules. The owner id always comes from the authenticated session (or the seed script), never from input.
 * @param {{ stores: ReturnType<import('../repositories/storeRepository.js').createStoreRepository> }} deps
 */
export function createStoreService({ stores }) {
  return {
    /** @param {string} ownerId @returns {ReturnType<typeof stores.findByOwnerId>} */
    findForOwner: (ownerId) => stores.findByOwnerId(ownerId),

    /**
     * Creates the owner's one store. Unique violations map by constraint name to distinct conflicts.
     * @param {string} ownerId
     * @param {unknown} rawInput Validated here with a strict schema.
     */
    async create(ownerId, rawInput) {
      const input = storeSchema.parse(rawInput);
      try {
        return await stores.insert({ ownerId, ...input });
      } catch (error) {
        if (error instanceof UniqueViolation && CONFLICTS[error.constraint]) throw CONFLICTS[error.constraint]();
        throw error;
      }
    },

    /**
     * Updates the storefront settings of the OWNER'S store. The store is resolved from the owner id (the session), never
     * from input, so one owner cannot change another's shop; a store_id in the input is rejected by the strict schema.
     * @param {string} ownerId
     * @param {unknown} rawInput Validated here with a strict schema.
     * @throws {import('zod').ZodError} for invalid input; {AppError} NOT_FOUND when the owner has no store.
     */
    async updateSettings(ownerId, rawInput) {
      const settings = shopSettingsSchema.parse(rawInput);
      const store = await stores.findByOwnerId(ownerId);
      const updated = store ? await stores.updateSettings(store.id, settings) : null;
      if (!updated) throw notFound('Store not found');
      return updated;
    },
  };
}
