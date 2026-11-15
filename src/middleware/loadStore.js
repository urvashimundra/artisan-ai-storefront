const NEW_STORE_PATH = '/store/new';
const SEE_OTHER = 303;

/**
 * Resolves the authenticated owner's store into `req.store`. The store is found by the session's owner id and
 * never by anything the client sent. Owners without a store are sent to create one. Must run after requireOwner.
 * @param {{ stores: { findForOwner: (ownerId: string) => Promise<object | null> } }} deps
 * @returns {import('express').RequestHandler}
 */
export function loadStore({ stores }) {
  return async (req, res, next) => {
    const store = await stores.findForOwner(req.owner.id);
    if (!store) return res.redirect(SEE_OTHER, NEW_STORE_PATH);
    req.store = store;
    return next();
  };
}
