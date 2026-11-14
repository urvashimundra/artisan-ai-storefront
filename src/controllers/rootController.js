export const SERVICE_NAME = 'The Artisan Story';

/**
 * Builds the root handler used by platform health probes. Makes no external calls.
 * @returns {import('express').RequestHandler}
 */
export function rootController() {
  return (_req, res) => {
    res.json({ name: SERVICE_NAME, status: 'ok' });
  };
}
