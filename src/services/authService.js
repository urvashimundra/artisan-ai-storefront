import { emailSchema, loginSchema, newPasswordSchema, signupSchema } from '../domain/credentialRules.js';
import { OWNERS_EMAIL_LOWER_KEY } from '../domain/dbConstraints.js';
import { AppError } from '../lib/errors.js';
import { UniqueViolation } from '../repositories/pgErrors.js';

const HTTP_UNAUTHORIZED = 401;
const HTTP_CONFLICT = 409;

export const INVALID_CREDENTIALS = 'INVALID_CREDENTIALS';
export const EMAIL_ALREADY_REGISTERED = 'EMAIL_ALREADY_REGISTERED';

const invalidCredentials = () => new AppError(INVALID_CREDENTIALS, HTTP_UNAUTHORIZED, 'Incorrect email or password');
const emailTaken = () => new AppError(EMAIL_ALREADY_REGISTERED, HTTP_CONFLICT, 'Email already registered');

/**
 * Owner signup and login.
 * @param {{ owners: ReturnType<import('../repositories/ownerRepository.js').createOwnerRepository>,
 *   passwords: Awaited<ReturnType<import('../lib/password.js').createPasswordService>>,
 *   sessions: ReturnType<import('./sessionService.js').createSessionService> }} deps
 */
export function createAuthService({ owners, passwords, sessions }) {
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
   * Open signup: validates the body strictly, rejects a duplicate email and creates a non-demo owner.
   * @param {unknown} rawBody Parsed form body.
   * @returns {Promise<void>}
   */
  async function signup(rawBody) {
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
