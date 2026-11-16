import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { INVITE_CODE } from '../helpers/fakes.js';
import { PASSWORD, STORE_FORM, cookieFrom, signupAndLogin, startAuthApp } from '../helpers/appHarness.js';

const SIGNUP = { email: 'maker@example.com', password: PASSWORD, inviteCode: INVITE_CODE };
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

describe('owner journey', () => {
  it('signs up, logs in, creates a store, sees it on the dashboard, and logs out', async () => {
    const app = await startAuthApp();
    try {
      const form = await app.request('/signup');
      assert.equal(form.status, 200);
      assert.match(form.text, /<html lang="en">/);
      assert.match(form.text, /<label for="email">/);

      const signup = await app.request('/signup', { method: 'POST', form: SIGNUP });
      assert.equal(signup.status, 303);
      assert.equal(signup.location, '/login?registered=1');
      assert.deepEqual(signup.setCookie, []);

      const notice = await app.request('/login?registered=1');
      assert.match(notice.text, /Your account is ready/);

      const login = await app.request('/login', { method: 'POST', form: { email: SIGNUP.email, password: PASSWORD } });
      assert.equal(login.status, 303);
      assert.equal(login.location, '/store/new');
      const cookie = cookieFrom(login);

      const early = await app.request('/dashboard', { cookie });
      assert.equal(early.location, '/store/new');

      const created = await app.request('/store/new', { method: 'POST', cookie, form: { ...STORE_FORM, name: '<b>Clay</b> & Co' } });
      assert.equal(created.status, 303);
      assert.equal(created.location, '/store/new/contact');

      const dashboard = await app.request('/dashboard', { cookie });
      assert.equal(dashboard.status, 200);
      assert.match(dashboard.text, /&lt;b&gt;Clay&lt;\/b&gt; &amp; Co/);
      assert.doesNotMatch(dashboard.text, /<b>Clay/);
      assert.match(dashboard.text, /\/s\/clay-works/);
      assert.match(dashboard.text, /Gujarati/);
      assert.match(dashboard.text, /<dd lang="gu">Hand made pots\.<\/dd>/);

      const again = await app.request('/login', { method: 'POST', form: { email: SIGNUP.email, password: PASSWORD } });
      assert.equal(again.location, '/dashboard');

      const logout = await app.request('/logout', { method: 'POST', cookie });
      assert.equal(logout.status, 303);
      assert.equal(logout.location, '/login');
      assert.match(logout.setCookie[0], /^session=; Max-Age=0; Path=\/; HttpOnly; SameSite=Lax$/);
      const after = await app.request('/dashboard', { cookie });
      assert.equal(after.location, '/login');
    } finally {
      await app.close();
    }
  });

  it('logout deletes the current session row from the database', async () => {
    const app = await startAuthApp();
    try {
      const cookie = await signupAndLogin(app);
      assert.equal(app.sessionsRepo.rows.length, 1);
      await app.request('/logout', { method: 'POST', cookie });
      assert.equal(app.sessionsRepo.rows.length, 0);
    } finally {
      await app.close();
    }
  });

  it('logging in again revokes the session token that came with the request', async () => {
    const app = await startAuthApp();
    try {
      const oldCookie = await signupAndLogin(app);
      const relogin = await app.request('/login', { method: 'POST', form: { email: 'maker@example.com', password: PASSWORD }, cookie: oldCookie });
      assert.equal(relogin.status, 303);
      assert.equal(app.sessionsRepo.rows.length, 1);
      assert.equal((await app.request('/dashboard', { cookie: oldCookie })).location, '/login');
      assert.equal((await app.request('/dashboard', { cookie: cookieFrom(relogin) })).location, '/store/new');
    } finally {
      await app.close();
    }
  });

  it('a failed login leaves the existing session alone', async () => {
    const app = await startAuthApp();
    try {
      const cookie = await signupAndLogin(app);
      const failed = await app.request('/login', { method: 'POST', form: { email: 'maker@example.com', password: 'wrong-password-here' }, cookie });
      assert.equal(failed.status, 401);
      assert.equal(app.sessionsRepo.rows.length, 1);
    } finally {
      await app.close();
    }
  });

  it('an expired session is treated as logged out and its row is deleted', async () => {
    let now = Date.parse('2026-11-15T00:00:00.000Z');
    const app = await startAuthApp({ servicesOptions: { now: () => now } });
    try {
      const cookie = await signupAndLogin(app);
      assert.equal((await app.request('/dashboard', { cookie })).location, '/store/new');
      now += SEVEN_DAYS_MS;
      const expired = await app.request('/dashboard', { cookie });
      assert.equal(expired.status, 303);
      assert.equal(expired.location, '/login');
      assert.equal(app.sessionsRepo.rows.length, 0);
    } finally {
      await app.close();
    }
  });

  it('unknown, malformed and missing session cookies are logged out', async () => {
    const app = await startAuthApp();
    try {
      for (const cookie of [undefined, 'session=', `session=${'A'.repeat(43)}`, 'session=garbage', 'other=1']) {
        const res = await app.request('/dashboard', { cookie });
        assert.equal(res.location, '/login', String(cookie));
      }
    } finally {
      await app.close();
    }
  });

  it('re-renders the signup form with labelled, associated errors and never echoes the password', async () => {
    const app = await startAuthApp();
    try {
      const res = await app.request('/signup', { method: 'POST', form: { ...SIGNUP, email: 'bad<>', password: 'short' } });
      assert.equal(res.status, 400);
      assert.match(res.text, /id="email-error"/);
      assert.match(res.text, /aria-describedby="email-error"/);
      assert.match(res.text, /id="password-error"/);
      assert.match(res.text, /aria-invalid="true"/);
      assert.match(res.text, /value="bad&lt;&gt;"/);
      assert.doesNotMatch(res.text, /short/);
      assert.equal(app.ownersRepo.rows.length, 0);
    } finally {
      await app.close();
    }
  });

  it('shows slug and validation errors on the store form and keeps typed values escaped', async () => {
    const app = await startAuthApp();
    try {
      const cookie = await signupAndLogin(app);
      const reserved = await app.request('/store/new', { method: 'POST', cookie, form: { ...STORE_FORM, slug: 'admin', name: '"><x>' } });
      assert.equal(reserved.status, 400);
      assert.match(reserved.text, /id="slug-error"/);
      assert.match(reserved.text, /value="&#34;&gt;&lt;x&gt;"/);
      await app.request('/store/new', { method: 'POST', cookie, form: STORE_FORM });
      const second = await signupAndLogin(app, 'second@example.com');
      const taken = await app.request('/store/new', { method: 'POST', cookie: second, form: STORE_FORM });
      assert.equal(taken.status, 409);
      assert.match(taken.text, /already taken/);
    } finally {
      await app.close();
    }
  });

  it('a second store for the same owner is rejected, and the form redirects to the dashboard', async () => {
    const app = await startAuthApp();
    try {
      const cookie = await signupAndLogin(app);
      await app.request('/store/new', { method: 'POST', cookie, form: STORE_FORM });
      assert.equal((await app.request('/store/new', { cookie })).location, '/dashboard');
      const duplicate = await app.request('/store/new', { method: 'POST', cookie, form: { ...STORE_FORM, slug: 'second-shop' } });
      assert.equal(duplicate.status, 409);
      assert.match(duplicate.text, /already have a store/);
      assert.equal(app.storesRepo.rows.length, 1);
    } finally {
      await app.close();
    }
  });

  it('no-store is sent on authenticated pages and every authentication response', async () => {
    const app = await startAuthApp();
    try {
      const cookie = await signupAndLogin(app);
      const responses = [
        await app.request('/login'),
        await app.request('/signup'),
        await app.request('/login', { method: 'POST', form: { email: 'x@example.com', password: 'nope' } }),
        await app.request('/dashboard', { cookie }),
        await app.request('/store/new', { cookie }),
        await app.request('/dashboard'),
        await app.request('/logout', { method: 'POST', cookie }),
      ];
      for (const res of responses) assert.equal(res.headers.get('cache-control'), 'no-store', res.location ?? String(res.status));
    } finally {
      await app.close();
    }
  });

  it('a logged-in owner visiting login or signup is redirected, and the login page never shows signup when disabled', async () => {
    const app = await startAuthApp();
    try {
      const cookie = await signupAndLogin(app);
      assert.equal((await app.request('/login', { cookie })).location, '/store/new');
      assert.equal((await app.request('/signup', { cookie })).location, '/store/new');
    } finally {
      await app.close();
    }
    const disabled = await startAuthApp({ inviteCode: null });
    try {
      assert.doesNotMatch((await disabled.request('/login')).text, /Sign up/);
    } finally {
      await disabled.close();
    }
  });

  it('cookie flags follow BASE_URL: https gives __Host-session with Secure; http gives plain session', async () => {
    const https = await startAuthApp({
      config: { baseUrl: 'https://example.test', allowedOrigins: ['https://example.test'], cookie: { name: '__Host-session', secure: true } },
    });
    try {
      await https.request('/signup', { method: 'POST', form: SIGNUP });
      const login = await https.request('/login', { method: 'POST', form: { email: SIGNUP.email, password: PASSWORD } });
      const parts = login.setCookie[0].split('; ');
      assert.match(parts[0], /^__Host-session=[A-Za-z0-9_-]{43}$/);
      for (const part of ['Max-Age=604800', 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Secure']) assert.ok(parts.includes(part), part);
      assert.ok(!parts.some((part) => /^Domain/i.test(part)));
      const logout = await https.request('/logout', { method: 'POST', cookie: cookieFrom(login) });
      assert.match(logout.setCookie[0], /^__Host-session=; Max-Age=0; Path=\/; HttpOnly; SameSite=Lax; Secure$/);
    } finally {
      await https.close();
    }
    const http = await startAuthApp();
    try {
      await http.request('/signup', { method: 'POST', form: SIGNUP });
      const login = await http.request('/login', { method: 'POST', form: { email: SIGNUP.email, password: PASSWORD } });
      assert.match(login.setCookie[0], /^session=[A-Za-z0-9_-]{43}; Max-Age=604800; Path=\/; HttpOnly; SameSite=Lax$/);
    } finally {
      await http.close();
    }
  });
});
