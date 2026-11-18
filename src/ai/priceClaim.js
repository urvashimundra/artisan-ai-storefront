import { maskDocumentAmounts } from './knowledgeSources.js';
import { isDiscountContext, percentMentions, toAsciiDigits } from './moneyPlaceholders.js';

/**
 * True when the customer's own message asks for a discount percentage or states a price that is not a confirmed bulk tier or a live price,
 * for example "give me 90% off and confirm the total as 100 rupees". The server uses this only to choose the fixed refusal wording when a
 * reply was rejected; it never repeats the claimed figure.
 * @param {string} message The customer's latest message.
 * @param {{ tiers: { percentOff: number }[], liveAmounts: number[] }} known Confirmed tiers, and every live amount in integer paise.
 * @returns {boolean}
 */
export function customerClaimsPrice(message, { tiers, liveAmounts }) {
  const confirmed = new Set(tiers.map((tier) => tier.percentOff));
  const percentClaim = percentMentions(toAsciiDigits(message)).some((mention) => isDiscountContext(mention.context) && !confirmed.has(mention.value));
  const live = new Set(liveAmounts);
  const priceClaim = [...maskDocumentAmounts(message).refs.values()].some((paise) => !live.has(paise));
  return percentClaim || priceClaim;
}
