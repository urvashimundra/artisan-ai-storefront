import { calculateQuote } from '../../domain/knowledgeRules.js';
import { LANGUAGE_NAMES_ENGLISH, pickField } from '../../domain/language.js';
import { MAX_TRACE_ITEM_LENGTH } from '../../domain/enquiryRules.js';
import { calculateQuoteSchema, checkProductSchema, searchProductsSchema } from '../schemas/enquiryAnswer.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PRODUCT_REF = /^p(\d+)$/;
const MAX_SEARCH_RESULTS = 20;
const MAX_TRACE_TITLE_LENGTH = 40;
const NO_INPUT_TOOLS = new Set(['get_shop_info', 'read_knowledge']);

const clip = (text, max) => (Array.from(text).length > max ? `${Array.from(text).slice(0, max).join('')}...` : text);
const stockLabel = (stock) => (stock === null ? 'available' : stock === 0 ? 'sold out' : `${stock} in stock`);
const tierView = (tier) => ({ min_quantity: tier.minQty, percent_off: tier.percentOff });

/**
 * The assistant's read-only tools for ONE enquiry. The store is closed over here: no tool takes a store id, and a product id supplied
 * by the model is only ever looked up inside that store (published products only). Tool results never contain an amount: prices,
 * subtotals, discounts and totals are placeholders such as {{p1.price}} or {{q1.total}} whose real values stay in `refs` (integer paise,
 * written by this code from the database), and the server substitutes them into the final text. `trace` is built from what the tools
 * actually did, never from anything the model says.
 * @param {{ storeId: string, shop: { name: string, tagline: string, story: string, defaultLanguage: string }, language: string,
 *   shops: { listPublished: Function, findPublished: Function }, knowledge: { get: Function } }} deps
 */
export function createEnquiryTools({ storeId, shop, language, shops, knowledge }) {
  const refs = new Map();
  const trace = [];
  const productNumbers = new Map();
  let quoteCount = 0;
  let knowledgeRow;

  const loadKnowledge = async () => {
    knowledgeRow ??= (await knowledge.get(storeId)) ?? { content: '', bulkRules: [] };
    return knowledgeRow;
  };
  const titleOf = (product) => pickField(product.translations, 'title', language, shop.defaultLanguage)?.text ?? null;
  const descriptionOf = (product) => pickField(product.translations, 'description', language, shop.defaultLanguage)?.text ?? '';

  function productRef(product) {
    if (!productNumbers.has(product.id)) productNumbers.set(product.id, productNumbers.size + 1);
    const ref = `p${productNumbers.get(product.id)}`;
    if (product.pricePaise !== null) refs.set(`${ref}.price`, product.pricePaise);
    return ref;
  }

  function resolveProductId(raw) {
    const numbered = PRODUCT_REF.exec(raw);
    if (numbered) return [...productNumbers].find(([, number]) => number === Number(numbered[1]))?.[0] ?? null;
    return UUID.test(raw) ? raw : null;
  }

  async function findProduct(raw) {
    const id = resolveProductId(raw);
    return id ? shops.findPublished(storeId, id) : null;
  }

  const productView = (product, ref, title) => ({
    ref, product_id: product.id, title, stock: stockLabel(product.stock), ...(product.pricePaise === null ? {} : { price: `{{${ref}.price}}` }),
  });

  const handlers = {
    async get_shop_info() {
      trace.push('Read the shop details');
      const languages = Object.values(LANGUAGE_NAMES_ENGLISH);
      return { name: shop.name, tagline: shop.tagline, story: shop.story, languages };
    },

    async read_knowledge() {
      const row = await loadKnowledge();
      trace.push(row.content.trim() === '' ? "Read the seller's notes (none written yet)" : "Read the seller's notes");
      return { document: row.content, confirmed_bulk_tiers: row.bulkRules.map(tierView) };
    },

    async search_products(input) {
      const { query } = searchProductsSchema.parse(input);
      const needle = query?.trim().toLowerCase() ?? '';
      const found = (await shops.listPublished(storeId))
        .map((product) => ({ product, title: titleOf(product) }))
        .filter(({ title }) => title !== null && title.toLowerCase().includes(needle))
        .slice(0, MAX_SEARCH_RESULTS);
      trace.push(`Searched the products (${found.length} found)`);
      return { products: found.map(({ product, title }) => productView(product, productRef(product), title)) };
    },

    async check_product(input) {
      const { productId } = checkProductSchema.parse(input);
      const product = await findProduct(productId);
      const title = product ? titleOf(product) : null;
      if (!product || title === null) return { error: 'This product is not available in this shop.' };
      trace.push(`Checked product: ${clip(title, MAX_TRACE_TITLE_LENGTH)}`);
      return { ...productView(product, productRef(product), title), description: descriptionOf(product) };
    },

    async calculate_quote(input) {
      const { productId, quantity } = calculateQuoteSchema.parse(input);
      const product = await findProduct(productId);
      const title = product ? titleOf(product) : null;
      if (!product || title === null || product.pricePaise === null) return { error: 'This product is not available in this shop.' };
      const { bulkRules } = await loadKnowledge();
      const quote = calculateQuote({ unitPricePaise: product.pricePaise, quantity, tiers: bulkRules, stock: product.stock });
      quoteCount += 1;
      const ref = `q${quoteCount}`;
      for (const [field, paise] of Object.entries({ unit_price: quote.unitPricePaise, subtotal: quote.subtotalPaise, discount: quote.discountPaise, total: quote.totalPaise })) {
        refs.set(`${ref}.${field}`, paise);
      }
      const bulk = quote.discountPercent > 0 ? `, ${quote.discountPercent}% bulk discount` : '';
      trace.push(`Calculated a quote: ${quantity} x ${clip(title, MAX_TRACE_TITLE_LENGTH)}${bulk}`);
      return {
        ref, product_id: product.id, title, quantity, unit_price: `{{${ref}.unit_price}}`, subtotal: `{{${ref}.subtotal}}`,
        discount_percent: quote.discountPercent, discount: `{{${ref}.discount}}`, total: `{{${ref}.total}}`, stock_covers_quantity: quote.stockCovers,
        next_bulk_tier: quote.nextTier ? tierView(quote.nextTier) : null,
      };
    },
  };

  return {
    refs,
    trace,

    /** @returns {Promise<number[]>} The percentages of the CONFIRMED tiers: the only percentages an answer may state. */
    async confirmedPercents() {
      return (await loadKnowledge()).bulkRules.map((tier) => tier.percentOff);
    },

    /**
     * Runs one tool call. Never throws for a bad call: the model gets an error result it can react to. Only the five listed tools exist.
     * @param {string} name @param {unknown} input
     * @returns {Promise<{ content: object, isError: boolean }>}
     */
    async run(name, input) {
      if (!Object.hasOwn(handlers, name)) {
        trace.push('Ignored a request for an unknown tool');
        return { content: { error: 'Unknown tool.' }, isError: true };
      }
      try {
        const content = await handlers[name](NO_INPUT_TOOLS.has(name) ? {} : input ?? {});
        return { content, isError: 'error' in content };
      } catch (error) {
        if (error?.name !== 'ZodError' && !(error instanceof RangeError)) throw error;
        trace.push(clip(`Tried ${name} with unusable input`, MAX_TRACE_ITEM_LENGTH));
        return { content: { error: 'Invalid input for this tool.' }, isError: true };
      }
    },
  };
}
