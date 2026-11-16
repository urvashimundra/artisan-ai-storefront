/** WCAG 2.x minimums: normal text, and non-text UI such as focus outlines. */
export const MIN_TEXT_CONTRAST = 4.5;
export const MIN_UI_CONTRAST = 3;

const HEX_COLOR = /^#([0-9a-f]{6})$/i;
const RADIX_HEX = 16;
const BYTE_MAX = 255;
const BYTE_MASK = 0xff;
const GREEN_SHIFT = 8;
const RED_SHIFT = 16;
const LINEAR_THRESHOLD = 0.04045;
const LINEAR_DIVISOR = 12.92;
const GAMMA_OFFSET = 0.055;
const GAMMA_SCALE = 1.055;
const GAMMA_EXPONENT = 2.4;
const RED_WEIGHT = 0.2126;
const GREEN_WEIGHT = 0.7152;
const BLUE_WEIGHT = 0.0722;
const FLARE = 0.05;

function linearChannel(byte) {
  const value = byte / BYTE_MAX;
  return value <= LINEAR_THRESHOLD ? value / LINEAR_DIVISOR : ((value + GAMMA_OFFSET) / GAMMA_SCALE) ** GAMMA_EXPONENT;
}

/**
 * WCAG relative luminance of a #rrggbb colour.
 * @param {string} hex
 * @returns {number} 0 (black) to 1 (white).
 * @throws {TypeError} when the colour is not #rrggbb.
 */
export function relativeLuminance(hex) {
  const match = HEX_COLOR.exec(hex);
  if (!match) throw new TypeError(`Expected #rrggbb colour, got ${String(hex)}`);
  const value = Number.parseInt(match[1], RADIX_HEX);
  const red = linearChannel((value >> RED_SHIFT) & BYTE_MASK);
  const green = linearChannel((value >> GREEN_SHIFT) & BYTE_MASK);
  const blue = linearChannel(value & BYTE_MASK);
  return RED_WEIGHT * red + GREEN_WEIGHT * green + BLUE_WEIGHT * blue;
}

/**
 * WCAG contrast ratio between two #rrggbb colours, in either order.
 * @param {string} first
 * @param {string} second
 * @returns {number} 1 to 21.
 */
export function contrastRatio(first, second) {
  const [lighter, darker] = [relativeLuminance(first), relativeLuminance(second)].sort((a, b) => b - a);
  return (lighter + FLARE) / (darker + FLARE);
}
