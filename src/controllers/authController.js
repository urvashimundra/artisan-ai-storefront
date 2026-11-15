import { ZodError } from 'zod';
import { MAX_EMAIL_LENGTH } from '../domain/credentialRules.js';
import { clearCookie, serializeCookie } from '../lib/cookies.js';
import { EMAIL_ALREADY_REGISTERED, INVALID_CREDENTIALS, INVALID_INVITE } from '../services/authService.js';
import { SESSION_TTL_SECONDS } from '../services/sessionService.js';
import { echoValues, fieldErrors } from './formErrors.js';

const SEE_OTHER = 303;
const HTTP_OK = 200;
const HTTP_BAD_REQUEST = 400;
const HTTP_UNAUTHORIZED = 401;
const HTTP_FORBIDDEN = 403;
const HTTP_CONFLICT = 409;
const REGISTERED_NOTICE = 'Your account is ready. Please log in.';
const LOGIN_FAILED = 'Incorrect email or password.';
const SIGNUP_MESSAGES = {
  email: 'Enter a valid email address.',
  password: 'Use 12 to 128 characters for your password.',
  inviteCode: 'Enter the invite code.',
};

/**
 * Signup, login and logout handlers (HTTP only; rules live in the services).
 * @param {{ auth: object, sessions: object, stores: object, cookie: { name: string, secure: boolean } }} deps
 */
export function createAuthController({ auth, sessions, stores, cookie }) {
  const landingFor = async (ownerId) => ((await stores.findForOwner(ownerId)) ? '/dashboard' : '/store/new');
  const signupPage = (res, status, errors, values) =>
    res.status(status).render('signup', { title: 'Sign up', errors, values });

  function signupFailure(req, res, error) {
    const values = echoValues(req.body, ['email'], MAX_EMAIL_LENGTH);
    if (error instanceof ZodError) return signupPage(res, HTTP_BAD_REQUEST, fieldErrors(error, SIGNUP_MESSAGES), values);
    if (error.code === EMAIL_ALREADY_REGISTERED) {
      return signupPage(res, HTTP_CONFLICT, { email: 'That email is already registered.' }, values);
    }
    if (error.code === INVALID_INVITE) {
      return signupPage(res, HTTP_FORBIDDEN, { inviteCode: 'The invite code is not valid.' }, values);
    }
    throw error;
  }

  return {
    async showSignup(req, res) {
      if (req.owner) return res.redirect(SEE_OTHER, await landingFor(req.owner.id));
      return signupPage(res, HTTP_OK, {}, {});
    },

    async postSignup(req, res) {
      try {
        await auth.signup(req.body);
      } catch (error) {
        return signupFailure(req, res, error);
      }
      return res.redirect(SEE_OTHER, '/login?registered=1');
    },

    async showLogin(req, res) {
      if (req.owner) return res.redirect(SEE_OTHER, await landingFor(req.owner.id));
      const notice = req.query.registered === '1' ? REGISTERED_NOTICE : null;
      return res.render('login', { title: 'Log in', notice, error: null });
    },

    async postLogin(req, res) {
      try {
        const { ownerId, token } = await auth.login(req.body, req.sessionToken);
        res.append('Set-Cookie', serializeCookie(cookie, token, SESSION_TTL_SECONDS));
        return res.redirect(SEE_OTHER, await landingFor(ownerId));
      } catch (error) {
        if (error.code !== INVALID_CREDENTIALS) throw error;
        return res.status(HTTP_UNAUTHORIZED).render('login', { title: 'Log in', notice: null, error: LOGIN_FAILED });
      }
    },

    async postLogout(req, res) {
      await sessions.destroy(req.sessionToken);
      res.append('Set-Cookie', clearCookie(cookie));
      return res.redirect(SEE_OTHER, '/login');
    },
  };
}
