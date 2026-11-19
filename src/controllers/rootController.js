export const SERVICE_NAME = 'The Artisan Story';

/**
 * Builds the public homepage handler. Makes no external calls.
 * @returns {import('express').RequestHandler}
 */
export function rootController() {
  return (_req, res) => {
    res.render('home', { title: null });
  };
}
