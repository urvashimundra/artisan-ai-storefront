const UNRECOGNIZED_KEYS = 'unrecognized_keys';

/**
 * Maps a ZodError to one message per field for re-rendering a form. Unknown keys (for example an extra
 * privileged field) are not a user mistake: the error is rethrown so the central handler answers 400.
 * @param {import('zod').ZodError} zodError
 * @param {Record<string, string>} messages Field name to user-facing message.
 * @returns {Record<string, string>}
 */
export function fieldErrors(zodError, messages) {
  if (zodError.issues.some((issue) => issue.code === UNRECOGNIZED_KEYS)) throw zodError;
  const errors = {};
  for (const issue of zodError.issues) {
    const field = String(issue.path[0]);
    errors[field] ??= messages[field] ?? 'This value is not valid.';
  }
  return errors;
}

/**
 * Picks string values for the named fields so a form can be re-displayed. Never pass password fields.
 * @param {unknown} body
 * @param {string[]} fields
 * @param {number} maxLength
 * @returns {Record<string, string>}
 */
export function echoValues(body, fields, maxLength) {
  const values = {};
  for (const field of fields) {
    if (typeof body?.[field] === 'string') values[field] = body[field].slice(0, maxLength);
  }
  return values;
}
