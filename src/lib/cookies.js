const SESSION_COOKIE_NAME = 'session';
const SECURE_COOKIE_PREFIX = '__Host-';

/**
 * Derives cookie settings from BASE_URL (never from NODE_ENV): https gets Secure and the `__Host-` name.
 * @param {string} baseUrl
 * @returns {{ name: string, secure: boolean }}
 */
export function deriveCookieConfig(baseUrl) {
  const secure = new URL(baseUrl).protocol === 'https:';
  return { name: secure ? `${SECURE_COOKIE_PREFIX}${SESSION_COOKIE_NAME}` : SESSION_COOKIE_NAME, secure };
}

/**
 * Parses a Cookie request header into a plain object. Malformed pairs are skipped.
 * @param {string | undefined} header
 * @returns {Record<string, string>}
 */
export function parseCookies(header) {
  const cookies = Object.create(null);
  if (typeof header !== 'string') return cookies;
  for (const pair of header.split(';')) {
    const index = pair.indexOf('=');
    if (index <= 0) continue;
    const name = pair.slice(0, index).trim();
    if (name && !(name in cookies)) cookies[name] = pair.slice(index + 1).trim();
  }
  return cookies;
}

function attributes(maxAgeSeconds, secure) {
  const parts = [`Max-Age=${maxAgeSeconds}`, 'Path=/', 'HttpOnly', 'SameSite=Lax'];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

/**
 * Builds a Set-Cookie value. Never sets a Domain attribute.
 * @param {{ name: string, secure: boolean }} cookie
 * @param {string} value Must be cookie-safe (base64url).
 * @param {number} maxAgeSeconds
 * @returns {string}
 */
export function serializeCookie(cookie, value, maxAgeSeconds) {
  return `${cookie.name}=${value}; ${attributes(maxAgeSeconds, cookie.secure)}`;
}

/**
 * Builds a Set-Cookie value that removes the cookie, using the same name, Path, Secure and SameSite as when set.
 * @param {{ name: string, secure: boolean }} cookie
 * @returns {string}
 */
export function clearCookie(cookie) {
  return `${cookie.name}=; ${attributes(0, cookie.secure)}`;
}
