/** Storefront colour tokens. The same hex values are written in public/css/public.css (a test compares them). */
export const ACCENT_KEYS = Object.freeze(['terracotta', 'indigo', 'forest', 'plum', 'teal', 'saffron']);
export const DEFAULT_ACCENT_KEY = 'terracotta';

/** Colours shared by every theme. */
export const PAGE_COLORS = Object.freeze({
  background: '#FFFAF5',
  surface: '#FFFFFF',
  text: '#231F1C',
  muted: '#5C534D',
});

/** Text colour on an accent-coloured button. */
export const ON_ACCENT = '#FFFFFF';

/** Accent used as a button background and as link/heading text on the page background. */
export const ACCENTS = Object.freeze({
  terracotta: '#A8431F',
  indigo: '#3F44A6',
  forest: '#2D6A3E',
  plum: '#8A2D6B',
  teal: '#0E6B70',
  saffron: '#9A5300',
});

/**
 * Validates an accent key, falling back to the default for anything unknown.
 * @param {unknown} key
 * @returns {string}
 */
export function safeAccentKey(key) {
  return ACCENT_KEYS.includes(key) ? key : DEFAULT_ACCENT_KEY;
}

/**
 * CSS class name for a theme.
 * @param {unknown} key
 * @returns {string} e.g. `theme-teal`.
 */
export function themeClass(key) {
  return `theme-${safeAccentKey(key)}`;
}
