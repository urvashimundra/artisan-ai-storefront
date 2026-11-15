const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Guard for every repository method on a store-scoped table: storeId is the required first argument and has no
 * fallback. Throws instead of letting a query run unscoped.
 * @param {unknown} storeId
 * @returns {string}
 */
export function requireStoreId(storeId) {
  if (typeof storeId !== 'string' || !UUID.test(storeId)) throw new TypeError('storeId is required');
  return storeId;
}
