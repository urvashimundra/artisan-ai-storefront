import { extractMeasurements } from './unitConflict.js';

/*
 * The artisan's notes are authoritative. A generated listing may not state a measurement (a number with a unit such as ml, g, cm, hours or
 * pieces) that the notes do not state, because the photograph cannot tell a 300 ml mug from a 350 ml one. The check applies only when the
 * notes state at least one measurement themselves.
 */

const UNIT_LABELS = Object.freeze({ ml: 'ml', g: 'g', mm: 'mm', inch: 'inch', hours: 'hours', days: 'days', pieces: 'pieces' });
const FIELDS = Object.freeze(['title', 'description', 'alt_text']);

const keyOf = ({ unit, value }) => `${unit}:${value}`;

/**
 * @param {string} story The artisan's notes.
 * @param {Record<string, { title: string, description: string, alt_text: string }>} translations The generated listing, one entry per language.
 * @returns {{ unit: string, value: number }[]} The distinct measurements in the listing that the notes do not state (empty when the notes state none).
 */
export function findFigureMismatch(story, translations) {
  const allowed = new Set(extractMeasurements(story).map(keyOf));
  if (allowed.size === 0) return [];
  const stated = Object.values(translations).flatMap((entry) => FIELDS.flatMap((field) => extractMeasurements(entry[field])));
  const unmatched = new Map(stated.filter((item) => !allowed.has(keyOf(item))).map((item) => [keyOf(item), item]));
  return [...unmatched.values()];
}

/** The base unit is shown to the model in plain words; the figures are the model's own, never customer or seller text. */
const describe = ({ unit, value }) => `${value} ${UNIT_LABELS[unit] ?? unit}`;

/**
 * The server-written note for the one corrective retry.
 * @param {{ unit: string, value: number }[]} mismatches
 * @returns {string}
 */
export function correctionFor(mismatches) {
  const list = mismatches.map(describe).join(', ');
  return `Your previous listing stated figures that the artisan's story does not state: ${list}. Write the listing again. Use a measurement only if the story states that exact figure, and leave out any other measurement. Follow the story wherever the photograph seems to differ.`;
}
