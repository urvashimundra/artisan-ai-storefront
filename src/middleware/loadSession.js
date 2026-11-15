import { parseCookies } from '../lib/cookies.js';

const LOGIN_PATH = '/login';
const SEE_OTHER = 303;

/**
 * Resolves the session cookie to `req.owner` (id plus a read-only demo marker) or null. Unknown, expired and missing tokens mean
 * logged out. The owner id is the only identity the rest of the request uses.
 * @param {{ sessions: { resolve: (token: string | undefined) => Promise<object | null> },
 *   cookie: { name: string } }} deps
 * @returns {import('express').RequestHandler}
 */
export function loadSession({ sessions, cookie }) {
  return async (req, res, next) => {
    const token = parseCookies(req.get('cookie'))[cookie.name];
    req.sessionToken = token;
    req.owner = await sessions.resolve(token);
    res.locals.owner = req.owner;
    next();
  };
}

/**
 * Redirects anonymous visitors to the login page. Must run after loadSession.
 * @returns {import('express').RequestHandler}
 */
export function requireOwner() {
  return (req, res, next) => (req.owner ? next() : res.redirect(SEE_OTHER, LOGIN_PATH));
}
