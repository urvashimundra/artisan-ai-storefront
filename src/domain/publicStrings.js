import { ORDER_STRINGS } from './orderStrings.js';

/*
 * Storefront interface strings in English, Gujarati and Hindi.
 * NOTE: the Gujarati and Hindi text was written by an AI assistant and has NOT been proofread by a native speaker.
 * It needs human review before real customers see it. Placeholders in {braces} must stay identical in every language.
 */
const BASE_STRINGS = Object.freeze({
  en: Object.freeze({
    skipToContent: 'Skip to content',
    products: 'Products',
    ourStory: 'Our story',
    price: 'Price',
    soldOut: 'Sold out',
    askOnWhatsApp: 'Ask on WhatsApp',
    aboutTheMaker: 'About the maker',
    visitShop: 'Visit the shop',
    backToShop: 'Back to all products',
    contactHeading: 'Contact the maker',
    instagram: 'Instagram',
    share: 'Share',
    linkCopied: 'Link copied',
    language: 'Language',
    showingFirstProducts: 'Showing the first 48 products',
    comingSoonTitle: 'Coming soon',
    comingSoonBody: 'This shop is getting ready. Please check back soon.',
    notFoundTitle: 'Page not found',
    notFoundBody: 'We could not find this page. The link may be wrong, or the item may no longer be available.',
    errorTitle: 'Something went wrong',
    errorBody: 'Please try again in a moment.',
    footer: 'Handmade with care. Shop page made with Artisan AI.',
    whatsappShopMessage: 'Hello {shop}, I found your shop and would like to know more. {url}',
    whatsappProductMessage: 'Hello {shop}, I am interested in {product}. {url}',
  }),
  gu: Object.freeze({
    skipToContent: 'મુખ્ય સામગ્રી પર જાઓ',
    products: 'ઉત્પાદનો',
    ourStory: 'અમારી વાર્તા',
    price: 'કિંમત',
    soldOut: 'વેચાઈ ગયું',
    askOnWhatsApp: 'વોટ્સએપ પર પૂછો',
    aboutTheMaker: 'કારીગર વિશે',
    visitShop: 'દુકાન જુઓ',
    backToShop: 'બધા ઉત્પાદનો પર પાછા જાઓ',
    contactHeading: 'કારીગરનો સંપર્ક કરો',
    instagram: 'Instagram',
    share: 'શેર કરો',
    linkCopied: 'લિંક કૉપિ થઈ',
    language: 'ભાષા',
    showingFirstProducts: 'પ્રથમ 48 ઉત્પાદનો બતાવવામાં આવ્યા છે',
    comingSoonTitle: 'ટૂંક સમયમાં આવી રહ્યું છે',
    comingSoonBody: 'આ દુકાન તૈયાર થઈ રહી છે. કૃપા કરીને થોડા સમય પછી ફરી જુઓ.',
    notFoundTitle: 'પેજ મળ્યું નથી',
    notFoundBody: 'આ પેજ મળ્યું નથી. લિંક ખોટી હોઈ શકે છે, અથવા વસ્તુ હવે ઉપલબ્ધ ન પણ હોય.',
    errorTitle: 'કંઈક ખોટું થયું',
    errorBody: 'કૃપા કરીને થોડી વાર પછી ફરી પ્રયાસ કરો.',
    footer: 'કાળજીથી હાથે બનાવેલું. આ દુકાન-પેજ આર્ટિસન AI વડે બનાવ્યું છે.',
    whatsappShopMessage: 'નમસ્તે {shop}, મને તમારી દુકાન મળી અને હું વધુ જાણવા માગું છું. {url}',
    whatsappProductMessage: 'નમસ્તે {shop}, મને {product} માં રસ છે. {url}',
  }),
  hi: Object.freeze({
    skipToContent: 'मुख्य सामग्री पर जाएँ',
    products: 'उत्पाद',
    ourStory: 'हमारी कहानी',
    price: 'कीमत',
    soldOut: 'बिक चुका',
    askOnWhatsApp: 'व्हाट्सऐप पर पूछें',
    aboutTheMaker: 'कारीगर के बारे में',
    visitShop: 'दुकान देखें',
    backToShop: 'सभी उत्पादों पर वापस जाएँ',
    contactHeading: 'कारीगर से संपर्क करें',
    instagram: 'Instagram',
    share: 'साझा करें',
    linkCopied: 'लिंक कॉपी हो गया',
    language: 'भाषा',
    showingFirstProducts: 'पहले 48 उत्पाद दिखाए जा रहे हैं',
    comingSoonTitle: 'जल्द ही आ रहा है',
    comingSoonBody: 'यह दुकान तैयार हो रही है। कृपया कुछ समय बाद फिर देखें।',
    notFoundTitle: 'पृष्ठ नहीं मिला',
    notFoundBody: 'यह पृष्ठ नहीं मिला। हो सकता है लिंक गलत हो, या वस्तु अब उपलब्ध न हो।',
    errorTitle: 'कुछ गलत हो गया',
    errorBody: 'कृपया थोड़ी देर बाद फिर कोशिश करें।',
    footer: 'प्यार से हाथ से बना। यह दुकान-पृष्ठ आर्टिसन AI से बनाया गया है।',
    whatsappShopMessage: 'नमस्ते {shop}, मुझे आपकी दुकान मिली और मैं और जानना चाहता/चाहती हूँ। {url}',
    whatsappProductMessage: 'नमस्ते {shop}, मुझे {product} में रुचि है। {url}',
  }),
});

/** Storefront strings plus the ordering strings (orderStrings.js), per language. */
export const PUBLIC_STRINGS = Object.freeze(
  Object.fromEntries(Object.keys(BASE_STRINGS).map((language) => [language, Object.freeze({ ...BASE_STRINGS[language], ...ORDER_STRINGS[language] })])),
);

export const STRING_KEYS = Object.freeze(Object.keys(PUBLIC_STRINGS.en));

/**
 * Strings for a language; unknown languages get English.
 * @param {string} language
 * @returns {Readonly<Record<string, string>>}
 */
export function stringsFor(language) {
  return PUBLIC_STRINGS[language] ?? PUBLIC_STRINGS.en;
}

/**
 * Replaces {name} placeholders. Values are inserted literally (no re-expansion, no escaping: the caller encodes).
 * @param {string} template
 * @param {Record<string, string>} values
 * @returns {string}
 */
export function fillTemplate(template, values) {
  return template.replace(/\{(\w+)\}/g, (whole, name) => (Object.hasOwn(values, name) ? values[name] : whole));
}
