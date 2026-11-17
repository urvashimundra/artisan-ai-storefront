import { codePointLength } from '../domain/productRules.js';
import { toPaise } from '../lib/money.js';
import { isDiscountContext, percentMentions, plainNumbers, toAsciiDigits } from './moneyPlaceholders.js';

/** The written sources an answer may cite. `live_catalog` is the database (prices, stock, discounts), not a document. */
export const SOURCE_LABELS = Object.freeze(['seller_notes', 'product_description', 'shop_profile', 'live_catalog']);
/** The shortest excerpt that counts as a quote (a one-word "excerpt" proves nothing). */
export const MIN_EXCERPT_LENGTH = 4;
export const MAX_EXCERPT_LENGTH = 300;

const AMOUNT_NUMBER = '(\\d{1,3}(?:,\\d{2,3})*(?:\\.\\d{1,2})?|\\d+(?:\\.\\d{1,2})?)';
const AMOUNT_PATTERN = new RegExp(
  `(?:(?:₹|\\bRs\\.?|\\bINR)\\s*${AMOUNT_NUMBER}(?:\\s*/-)?)|(?:${AMOUNT_NUMBER}\\s*(?:/-|\\brupees?\\b|\\brs\\b\\.?|\\binr\\b))`,
  'giu',
);
const BRACES = /\{\{|\}\}/g;
const ZERO_WIDTH = /[​-‍﻿]/g;
const WHITESPACE = /\s+/g;
const PLACEHOLDER = /\{\{\s*([a-z]\d+\.[a-z_]+)\s*\}\}/g;

/**
 * Replaces every currency amount in the seller's own document with a server placeholder ({{d1.amount}}). The model sees the placeholder,
 * never the digits, so it cannot restate or alter a price; the server substitutes the ORIGINAL amount (integer paise, parsed here by
 * decimal-string code) into the final text. Braces already in the document are neutralised so the seller cannot forge a placeholder.
 * An amount that cannot be parsed exactly is left as text (the answer check then refuses a model that repeats it).
 * @param {string} content The document, unchanged and complete.
 * @returns {{ text: string, refs: Map<string, number> }}
 */
export function maskDocumentAmounts(content) {
  const refs = new Map();
  const safe = content.replace(BRACES, (brace) => (brace === '{{' ? '{ {' : '} }'));
  const text = safe.replace(AMOUNT_PATTERN, (whole, symbolForm, wordForm) => {
    const digits = toAsciiDigits(symbolForm ?? wordForm ?? '').replaceAll(',', '');
    try {
      const key = `d${refs.size + 1}.amount`;
      refs.set(key, toPaise(digits));
      return `{{${key}}}`;
    } catch {
      return whole;
    }
  });
  return { text, refs };
}

/** @param {string} text @returns {string} Comparable form: NFC, no zero-width characters, single spaces, lower case. */
export function normalizeForMatch(text) {
  return text.normalize('NFC').replace(ZERO_WIDTH, '').replace(WHITESPACE, ' ').trim().toLowerCase();
}

/**
 * True only when the excerpt is a verbatim (whitespace- and case-insensitive) part of one of the source texts. This is how the backend
 * checks that a quoted source really says what the model claims.
 * @param {string} excerpt @param {string[]} sourceTexts @returns {boolean}
 */
export function verifyExcerpt(excerpt, sourceTexts) {
  const needle = normalizeForMatch(excerpt);
  if (codePointLength(needle) < MIN_EXCERPT_LENGTH) return false;
  return sourceTexts.some((source) => normalizeForMatch(source).includes(needle));
}

/**
 * The texts the backend can check quotes against, by label: the document (as the model saw it, and as written), the shop profile, and the
 * product descriptions the tools returned during this run.
 * @param {{ maskedDocument: string, document: string, profileTexts: string[], descriptions: string[] }} parts
 * @returns {Record<string, string[]>}
 */
export function buildSourceBook({ maskedDocument, document, profileTexts, descriptions }) {
  return { seller_notes: [maskedDocument, document], shop_profile: profileTexts, product_description: descriptions, live_catalog: [] };
}

/**
 * Keeps only the claims whose excerpt really appears in the source they name. `live_catalog` needs no excerpt: it is accepted only when a
 * live-data tool really ran this turn.
 * @param {{ label: string, excerpt?: string }[]} claims
 * @param {Record<string, string[]>} book
 * @param {{ usedLiveData: boolean }} facts
 * @returns {{ label: string, excerpt?: string }[]}
 */
export function verifiedClaims(claims, book, { usedLiveData }) {
  return claims.filter((claim) => {
    if (claim.label === 'live_catalog') return usedLiveData;
    return claim.excerpt !== undefined && verifyExcerpt(claim.excerpt, book[claim.label] ?? []);
  });
}

/**
 * A conflict is real only when at least two DIFFERENT quotes are each verified against the source they name. Returns the claims with their
 * placeholders replaced by the original amounts (for the seller), or null when the conflict cannot be verified.
 * @param {{ topic: string, claims: { label: string, excerpt: string }[] }} conflict
 * @param {Record<string, string[]>} book
 * @param {(text: string) => string} substitute Turns placeholders into the original amounts.
 * @returns {{ topic: string, claims: { label: string, excerpt: string }[] } | null}
 */
export function verifiedConflict(conflict, book, substitute) {
  const kept = verifiedClaims(conflict.claims, book, { usedLiveData: false }).filter((claim) => claim.label !== 'live_catalog');
  const distinct = new Set(kept.map((claim) => normalizeForMatch(claim.excerpt)));
  if (kept.length < 2 || distinct.size < 2) return null;
  return { topic: conflict.topic, claims: kept.map((claim) => ({ label: claim.label, excerpt: substitute(claim.excerpt) })) };
}

/** @param {string} text @param {Map<string, number>} refs @returns {string} The text with every known document placeholder replaced by its original amount. */
export function substituteDocumentAmounts(text, refs, format) {
  return text.replace(PLACEHOLDER, (whole, key) => (refs.has(key) ? format(refs.get(key)) : whole));
}

const ANY_PLACEHOLDER = /\{\{[^}]*\}\}/g;

/**
 * The plain figures the shop's own texts state, for the answer check: "200 g", "45 hours", "100% soy wax". Currency amounts are removed first
 * (they are masked or come from tools), and a percentage that sits beside a discount word in the source ("save 20%") is NOT listed, so a
 * seller's written offer can never be repeated as if it were a confirmed one. These figures never count as a price or a discount.
 * @param {string[]} texts Product titles and descriptions the run read, the seller notes and the shop profile.
 * @returns {{ numbers: number[], percents: number[] }}
 */
export function descriptiveFigures(texts) {
  const numbers = new Set();
  const percents = new Set();
  for (const text of texts) {
    const ascii = toAsciiDigits(text.replace(ANY_PLACEHOLDER, ' ')).replace(AMOUNT_PATTERN, ' ');
    plainNumbers(ascii).forEach((value) => numbers.add(value));
    percentMentions(ascii).filter(({ context }) => !isDiscountContext(context)).forEach(({ value }) => percents.add(value));
  }
  return { numbers: [...numbers], percents: [...percents] };
}
