/*
 * Local visual-inspection server (a developer tool, not a test). Boots the REAL app, views and CSS over in-memory fakes with sample data, so the
 * rendered pages can be opened in a browser or screenshotted at different widths. Nothing here touches Supabase, Claude or email.
 * Usage: node tests/helpers/previewServer.js [port]   (default 4100). Prints the URLs of the sample pages.
 * Narrow widths: /__frame?w=375&h=700&u=/s/clay-works wraps the page in an iframe of exactly that size (a headless browser window cannot go below about 500 px).
 * Product pictures are generated SVG swatches served from /preview-img (sample data only; the real shop serves signed storage URLs).
 */
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { answered, createFakeAgent } from './conversationFakes.js';
import { startChatApp } from './chatApp.js';
import { translation } from './publicFakes.js';

const PORT = Number(process.argv[2]) || 4100;
const PALETTES = [['#C96B3C', '#F2D3B3'], ['#3F44A6', '#D9DBF4'], ['#2D6A3E', '#D7ECDC'], ['#8A2D6B', '#F0D4E5'], ['#0E6B70', '#CFEAEC'], ['#9A5300', '#F4DFBF']];
const PRODUCTS = [
  ['Terracotta diya set', 'Six hand-thrown diyas, fired in a wood kiln. Each one is slightly different.', 45000],
  ['Blue pottery vase', 'A tall vase glazed in cobalt and white, painted by hand.', 129000],
  ['Block-printed cushion cover', 'Cotton cover printed with natural dyes, 40 by 40 cm.', 68000],
  ['Brass bell, small', 'Cast brass with a clear tone. Comes with a cotton cord.', 38000],
  ['Woven jute basket', 'A sturdy basket for storage, woven by a family of six artisans.', 92000],
  ['Clay water pot', 'A traditional matka that keeps water cool through the day.', 54000],
];

const swatch = (index) => {
  const [dark, light] = PALETTES[index % PALETTES.length];
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 600"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${light}"/><stop offset="1" stop-color="#FFFFFF"/></linearGradient></defs><rect width="600" height="600" fill="url(#g)"/><path d="M230 140h140l-14 40c60 40 90 110 70 190-12 50-60 90-126 90s-114-40-126-90c-20-80 10-150 70-190z" fill="${dark}"/></svg>`;
};

async function seed() {
  const agent = createFakeAgent({ fallback: answered('Yes, we ship across India. Delivery usually takes about five days.', { sources: [{ label: 'seller_notes' }] }) });
  const app = await startChatApp({ agent, shop: { name: 'Kutch Clay Works', tagline: 'Handmade pottery and textiles from Gujarat', story: 'We are a family of potters in Bhuj. Our workshop has made diyas, vases and water pots for three generations, using local clay and a wood-fired kiln.', instagramHandle: 'kutchclayworks', accentKey: 'terracotta' } });
  const ids = [app.product.id];
  PRODUCTS.slice(1).forEach(([title, description, price], index) => {
    const row = app.repo.addProduct(app.shop, { pricePaise: price, translations: { en: translation(title, description, `${title}, photographed on a plain background`) }, createdAt: `2026-11-1${index}T08:00:00.000Z` });
    ids.push(row.id);
  });
  app.product.pricePaise = PRODUCTS[0][2];
  app.product.translations = { en: translation(PRODUCTS[0][0], PRODUCTS[0][1], `${PRODUCTS[0][0]}, photographed on a plain background`) };
  app.images.createSignedUrl = async (_storeId, productId) => `/preview-img/${ids.indexOf(productId)}.svg`;
  const started = await app.start({ name: 'Asha Patel', phone: '98765 43210', message: 'Do you deliver to Pune, and how long does it take?' });
  const token = app.tokenOf(started);
  await app.send(token, 'Can I order 20 diyas for a wedding?');
  return { app, token, ids };
}

const { app, token, ids } = await seed();
const server = createServer(async (req, res) => {
  const frame = /^\/__frame\?w=(\d+)&h=(\d+)&u=(.+)$/.exec(req.url);
  if (frame) {
    res.writeHead(200, { 'content-type': 'text/html' });
    return res.end(`<body style="margin:0;background:#888"><iframe src="${encodeURI(decodeURIComponent(frame[3]))}" width="${frame[1]}" height="${frame[2]}" style="border:0;display:block;background:#fff"></iframe></body>`);
  }
  const image = /^\/preview-img\/(\d+)\.svg$/.exec(req.url);
  if (image) {
    res.writeHead(200, { 'content-type': 'image/svg+xml', 'cache-control': 'no-store' });
    return res.end(swatch(Number(image[1])));
  }
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const upstream = await fetch(`${app.url}${req.url}`, {
    method: req.method, headers: { ...req.headers, host: new URL(app.url).host, origin: 'http://localhost' }, body: chunks.length ? Buffer.concat(chunks) : undefined, redirect: 'manual',
  });
  const headers = Object.fromEntries(upstream.headers);
  delete headers['content-encoding'];
  delete headers['content-length'];
  headers['set-cookie'] = upstream.headers.getSetCookie();
  if (headers['content-security-policy']) headers['content-security-policy'] = headers['content-security-policy'].replace(';upgrade-insecure-requests', '');
  res.writeHead(upstream.status, headers);
  return res.end(Buffer.from(await upstream.arrayBuffer()));
});
server.listen(PORT, () => {
  const base = `http://localhost:${PORT}`;
  process.stdout.write(`shop:     ${base}/s/clay-works\nproduct:  ${base}/s/clay-works/p/${ids[0]}\nstart:    ${base}/s/clay-works/chat\nchat:     ${base}/s/clay-works/c/${token}\n`);
  process.stdout.write(`(session ids: ${randomUUID().slice(0, 4)})\n`);
});
