/** Failure of a connectivity probe. Carries a safe code only, never provider messages. */
export class ProbeError extends Error {
  /** @param {string} code Safe, stable identifier such as SUPABASE_STORAGE_ERROR. */
  constructor(code) {
    super(code);
    this.name = 'ProbeError';
    this.code = code;
  }
}
