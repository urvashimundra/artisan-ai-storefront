/**
 * Builds the health handler. Makes no external calls.
 * @param {{ version: string }} deps
 * @returns {import('express').RequestHandler}
 */
export function healthController({ version }) {
  return (_req, res) => {
    res.json({ status: 'ok', uptime: process.uptime(), version });
  };
}
