import { INVITE_CODE, buildFakeServices } from './fakes.js';
import { startTestApp } from './testApp.js';

export const ORIGIN = 'http://localhost';
export const PASSWORD = 'a-long-enough-password';
const HIGH = { windowMs: 60_000, limit: 1000 };
export const HIGH_LIMITS = { loginFailure: HIGH, loginIp: HIGH, signup: HIGH };

/**
 * Sends a request without following redirects. Adds a matching Origin to every request unless `origin: null`.
 * @returns {Promise<{ status: number, headers: Headers, location: string | null, setCookie: string[], text: string }>}
 */
export function createClient(baseUrl, defaultOrigin = ORIGIN) {
  return async function request(path, { method = 'GET', form, cookie, headers = {}, origin = defaultOrigin } = {}) {
    const sent = { accept: 'text/html', ...headers };
    if (origin) sent.origin = origin;
    if (cookie) sent.cookie = cookie;
    let body;
    if (form) {
      sent['content-type'] = 'application/x-www-form-urlencoded';
      body = new URLSearchParams(form).toString();
    }
    const res = await fetch(`${baseUrl}${path}`, { method, headers: sent, body, redirect: 'manual' });
    const text = await res.text();
    return { status: res.status, headers: res.headers, location: res.headers.get('location'), setCookie: res.headers.getSetCookie(), text };
  };
}

/** The `name=value` pair of every Set-Cookie header, joined for a Cookie request header. */
export const cookieFrom = (response) => response.setCookie.map((value) => value.split(';')[0]).join('; ');

/**
 * Starts the real app (routes, middleware, views) over real services with in-memory repositories.
 * @param {{ inviteCode?: string | null, config?: object, authRateLimits?: object, servicesOptions?: object,
 *   extraServices?: object, appDeps?: object }} [options] appDeps are extra createApp dependencies (for example publicRateLimits).
 */
export async function startAuthApp({
  inviteCode = INVITE_CODE,
  config = {},
  authRateLimits = HIGH_LIMITS,
  servicesOptions = {},
  extraServices = {},
  appDeps = {},
} = {}) {
  const fakes = await buildFakeServices({ inviteCode, ...servicesOptions });
  const { auth, sessions, stores, translations } = fakes;
  const app = await startTestApp({
    config: { signupInviteCode: inviteCode ?? undefined, ...config },
    services: { auth, sessions, stores, translations, ...extraServices },
    authRateLimits,
    ...appDeps,
  });
  const request = createClient(app.url, config.allowedOrigins?.[0] ?? ORIGIN);
  return { ...app, ...fakes, request };
}

/** Signs up and logs in through HTTP. Returns the Cookie header for later requests. */
export async function signupAndLogin(app, email = 'maker@example.com') {
  const signup = await app.request('/signup', { method: 'POST', form: { email, password: PASSWORD, inviteCode: INVITE_CODE } });
  if (signup.status !== 303) throw new Error(`signup failed with ${signup.status}`);
  const login = await app.request('/login', { method: 'POST', form: { email, password: PASSWORD } });
  if (login.status !== 303) throw new Error(`login failed with ${login.status}`);
  return cookieFrom(login);
}

export const STORE_FORM = { name: 'Clay Works', slug: 'clay-works', defaultLanguage: 'gu', story: 'Hand made pots.' };
