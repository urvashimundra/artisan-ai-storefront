import { createHash, timingSafeEqual } from 'node:crypto';
import { emailSchema, loginSchema, newPasswordSchema, signupSchema } from '../domain/credentialRules.js';
import { OWNERS_EMAIL_LOWER_KEY } from '../domain/dbConstraints.js';
import { AppError } from '../lib/errors.js';
import { UniqueViolation } from '../repositories/pgErrors.js';

const HTTP_UNAUTHORIZED = 401;
const HTTP_FORBIDDEN = 403;
const HTTP_CONFLICT = 409;

export const INVALID_CREDENTIALS = 'INVALID_CREDENTIALS';
export const INVALID_INVITE = 'INVALID_INVITE';
export const EMAIL_ALREADY_REGISTERED = 'EMAIL_ALREADY_REGISTERED';

const invalidCredentials = () => new AppError(INVALID_CREDENTIALS, HTTP_UNAUTHORIZED, 'Incorrect email or password');
const invalidInvite = () => new AppError(INVALID_INVITE, HTTP_FORBIDDEN, 'The invite code is not valid');
const emailTaken = () => new AppError(EMAIL_ALREADY_REGISTERED, HTTP_CONFLICT, 'Email already registered');

const sha256 = (value) => createHash('sha256').update(value).digest();

/**
 * Constant-time invite code check: compares SHA-256 digests. With no configured code nothing is valid.
 * @param {string | undefined} configured
 * @returns {(supplied: unknown) => boolean}
 */
export function createInviteVerifier(configured) {
  const expected = configured ? sha256(configured) : null;
  return (supplied) => {
    if (!expected || typeof supplied !== 'string') return false;
    const actual = sha256(supplied);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  };
}

/**
 * Owner signup and login.
 * @param {{ owners: ReturnType<import('../repositories/ownerRepository.js').createOwnerRepository>,
 *   passwords: Awaited<ReturnType<import('../lib/password.js').createPasswordService>>,
 *   sessions: ReturnType<import('./sessionService.js').createSessionService>,
 *   inviteCode: string | undefined }} deps
 */
export function createAuthService({ owners, passwords, sessions, inviteCode }) {
  const isValidInvite = createInviteVerifier(inviteCode);

  /**
   * Creates an owner with the normal hashing path. Applies the same email and password policy as signup.
   * `isDemo` is accepted ONLY here; signup hard-codes false and no HTTP route exposes this function.
   * @param {{ email: string, password: string, isDemo: boolean }} input
   * @returns {Promise<{ id: string }>}
   */
  async function createOwnerRecord({ email, password, isDemo }) {
    const normalizedEmail = emailSchema.parse(email);
    const passwordHash = await passwords.hash(newPasswordSchema.parse(password));
    try {
      return await owners.insert({ email: normalizedEmail, passwordHash, isDemo });
    } catch (error) {
      if (error instanceof UniqueViolation && error.constraint === OWNERS_EMAIL_LOWER_KEY) throw emailTaken();
      throw error;
    }
  }

  /**
   * The invite code is verified first. A wrong code returns the same 403 whether or not the email exists and
   * never touches the owners table. The duplicate-email disclosure is reachable only after a valid code.
   * @param {unknown} rawBody Parsed form body.
   * @returns {Promise<void>}
   */
  async function signup(rawBody) {
    if (!isValidInvite(rawBody?.inviteCode)) throw invalidInvite();
    const input = signupSchema.parse(rawBody);
    if (await owners.findByEmail(input.email)) throw emailTaken();
    await createOwnerRecord({ email: input.email, password: input.password, isDemo: false });
  }

  /**
   * Every failure (bad input, unknown email, wrong password) is the same INVALID_CREDENTIALS error. An unknown
   * email still verifies against the startup dummy hash so the work done resembles a wrong-password login.
   * After the credentials verify, the session row for the request's existing cookie token (if any) is deleted before
   * the new session is issued, so a re-login revokes the old token. A failed login leaves it untouched.
   * @param {unknown} rawBody
   * @param {string | undefined} [previousToken] The raw session cookie token of the request, if any.
   * @returns {Promise<{ ownerId: string, token: string }>}
   */
  async function login(rawBody, previousToken) {
    const parsed = loginSchema.safeParse(rawBody ?? {});
    if (!parsed.success) throw invalidCredentials();
    const { email, password } = parsed.data;
    const owner = await owners.findByEmail(email);
    const verified = owner ? await passwords.verify(password, owner.passwordHash) : await passwords.verifyDummy(password);
    if (!verified) throw invalidCredentials();
    await sessions.destroy(previousToken);
    const { token } = await sessions.create(owner.id);
    return { ownerId: owner.id, token };
  }

  return { signup, login, createOwnerRecord };
}
