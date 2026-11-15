'use strict';
// Search-engine helpers: a title and description for each public page, the canonical link and social-share tags,
// the business details Google reads for local results, robots.txt and sitemap.xml.
// Everything here is a plain function (no database, no Express) so it can be tested on its own;
// server.js passes in the settings and category names.

const DEFAULTS = {
  siteUrl: (process.env.SITE_URL || 'https://solids-supply.com').replace(/\/+$/, ''),
  city: process.env.SEO_CITY || 'Hopkins',
  region: process.env.SEO_REGION || 'MN',
};

const esc = s => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const placeOf = cfg => `${cfg.city}, ${cfg.region}`;
const brandOf = settings => String((settings && settings.business_name) || '').trim() || 'Solids Supply';
const isFlooring = c => /^flooring$/i.test(String(c || ''));

// "Vanity" is how the catalog files them; shoppers search for "bathroom vanities".
function categoryLabel(cat) {
  const c = String(cat || '').trim();
  if (/^vanit(y|ies)$/i.test(c)) return 'Bathroom Vanities';
  return c;
}

// Title, description and canonical address for one public page.
//   page: 'home' | 'flooring' | 'materials' | 'category'
//   opts: { settings, cfg, category (the name from the address, any case), categories (real names), query }
// Returns { title, description, path, robots?, redirect? }. robots is only set to keep a page out of search results.
function pageMeta(page, opts = {}) {
  const cfg = Object.assign({}, DEFAULTS, opts.cfg || {});
  const brand = brandOf(opts.settings), place = placeOf(cfg);
  if (page === 'home') {
    return {
      title: `Flooring, Vanities & Building Materials in ${place} | ${brand}`,
      description: `Luxury vinyl plank flooring, bathroom vanities and building materials in stock in ${place}. Request a quote or pick up the same day.`,
      path: '/',
    };
  }
  if (page === 'flooring') {
    return {
      title: `Luxury Vinyl Plank Flooring in ${place} | ${brand}`,
      description: `Waterproof luxury vinyl plank flooring in stock in ${place}, including our exclusive Duraplex line. Use the room calculator to see how many boxes you need.`,
      path: '/flooring.html',
    };
  }
  if (page === 'materials') {
    return {
      title: `Building Materials in ${place}: Flooring, Vanities & More | ${brand}`,
      description: `Browse building materials in ${place}: flooring, vanities, appliances and more. Live stock and pricing, same-day pickup on in-stock items.`,
      path: '/materials.html',
    };
  }
  // The shared category page. Only a category that really exists gets its own title and address; a search
  // or an unknown name is the generic page and stays out of search results.
  const query = String(opts.query || '').trim();
  const real = (opts.categories || []).find(c => String(c).toLowerCase() === String(opts.category || '').toLowerCase());
  if (real && isFlooring(real) && !query) {
    return { title: '', description: '', path: '/flooring.html', redirect: '/flooring.html' };
  }
  if (real && !query) {
    const label = categoryLabel(real);
    return {
      title: `${label} in ${place} | ${brand}`,
      description: `${label} in stock in ${place}. Live pricing and same-day pickup on in-stock items. Request a quote for your project.`,
      path: '/category.html?cat=' + encodeURIComponent(real),
    };
  }
  return {
    title: query ? `Search results | ${brand}` : `All Building Materials in ${place} | ${brand}`,
    description: `Everything on the shelf at ${brand} in ${place}. Live stock and pricing, same-day pickup on in-stock items.`,
    path: '/category.html',
    robots: 'noindex, follow',
  };
}

// ── Opening hours ────────────────────────────────────────────────────────────
const DAY_ABBR = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const pad = n => String(n).padStart(2, '0');
const clock = (h, m, ap) => `${pad((Number(h) % 12) + (/p/i.test(ap) ? 12 : 0))}:${pad(Number(m || 0))}`;
const HOURS_PART = /^\s*([A-Za-z]{3,9})\.?(?:\s*(?:[-–—]|to)\s*([A-Za-z]{3,9})\.?)?\s*:?\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)\s*(?:[-–—]|to)\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)\s*$/i;

// "Mon–Fri 8am–6pm, Sat 9am–4pm" → Google's opening-hours entries. Anything it cannot read (such as "Sun closed") is skipped.
function parseHours(text) {
  const out = [];
  String(text || '').split(/[,;\n]+/).forEach(part => {
    const m = HOURS_PART.exec(part);
    if (!m) return;
    const a = DAY_ABBR.indexOf(m[1].slice(0, 3).toLowerCase());
    const b = m[2] ? DAY_ABBR.indexOf(m[2].slice(0, 3).toLowerCase()) : a;
    if (a < 0 || b < 0) return;
    const days = [];
    for (let d = a, n = 0; n < 7; n++, d = (d + 1) % 7) { days.push(DAY_NAMES[d]); if (d === b) break; }
    out.push({ '@type': 'OpeningHoursSpecification', dayOfWeek: days, opens: clock(m[3], m[4], m[5]), closes: clock(m[6], m[7], m[8]) });
  });
  return out;
}

// The street part of "1415 Fifth St S, Suite C Hopkins, MN  55343 United States" (everything before the city name).
function streetOf(address, city) {
  const a = String(address || '').replace(/\s+/g, ' ').trim();
  const i = city ? a.toLowerCase().indexOf(String(city).toLowerCase()) : -1;
  return (i > 0 ? a.slice(0, i) : a).replace(/[,\s]+$/, '');
}

// "(763) 319-6384" → "+1-763-319-6384" when it is a ten-digit US number; otherwise left as typed.
function phoneOf(raw) {
  const d = String(raw || '').replace(/\D/g, '');
  return d.length === 10 ? `+1-${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}` : String(raw || '').trim();
}

// What Google reads to show the shop in local results: name, address, phone, hours.
function localBusiness(settings, cfgIn) {
  const s = settings || {}, cfg = Object.assign({}, DEFAULTS, cfgIn || {});
  const o = { '@context': 'https://schema.org', '@type': 'HomeGoodsStore', name: brandOf(s), url: cfg.siteUrl + '/', image: cfg.siteUrl + '/icon-512.png' };
  if (s.hero_tagline) o.description = String(s.hero_tagline);
  if (s.business_phone) o.telephone = phoneOf(s.business_phone);
  if (s.business_email) o.email = String(s.business_email);
  if (s.business_address) {
    const zip = (String(s.business_address).match(/\b\d{5}(?:-\d{4})?\b/g) || []).pop();
    o.address = { '@type': 'PostalAddress', streetAddress: streetOf(s.business_address, cfg.city), addressLocality: cfg.city, addressRegion: cfg.region, addressCountry: 'US' };
    if (zip) o.address.postalCode = zip;
  }
  const hours = parseHours(s.business_hours);
  if (hours.length) o.openingHoursSpecification = hours;
  return o;
}

// JSON placed inside a <script>: "<" is written as < so nothing in a setting can close the tag early.
const jsonForScript = o => JSON.stringify(o).replace(/</g, '\\u003c');

// Add the title, description, canonical link, share-preview tags, icons and (optionally) business markup to a page.
//   meta: { title, description, path, robots?, jsonld? }
function inject(html, meta, cfgIn, brand) {
  const cfg = Object.assign({}, DEFAULTS, cfgIn || {});
  const url = cfg.siteUrl + meta.path;
  let out = String(html);
  const title = `<title>${esc(meta.title)}</title>`;
  out = /<title>[\s\S]*?<\/title>/i.test(out) ? out.replace(/<title>[\s\S]*?<\/title>/i, () => title) : out.replace(/<\/head>/i, () => title + '\n</head>');
  const desc = `<meta name="description" content="${esc(meta.description)}">`;
  out = /<meta\s+name="description"[^>]*>/i.test(out) ? out.replace(/<meta\s+name="description"[^>]*>/i, () => desc) : out.replace(/<\/head>/i, () => desc + '\n</head>');
  const tags = [`<link rel="canonical" href="${esc(url)}">`];
  if (meta.robots) tags.push(`<meta name="robots" content="${esc(meta.robots)}">`);
  tags.push(
    `<meta property="og:type" content="website">`,
    `<meta property="og:site_name" content="${esc(brand || 'Solids Supply')}">`,
    `<meta property="og:title" content="${esc(meta.title)}">`,
    `<meta property="og:description" content="${esc(meta.description)}">`,
    `<meta property="og:url" content="${esc(url)}">`,
    `<meta property="og:image" content="${esc(cfg.siteUrl + '/icon-512.png')}">`,
    `<meta name="twitter:card" content="summary">`);
  if (!/rel="icon"/i.test(out)) tags.push('<link rel="icon" type="image/png" sizes="192x192" href="/icon-192.png">');
  if (!/rel="apple-touch-icon"/i.test(out)) tags.push('<link rel="apple-touch-icon" href="/apple-touch-icon.png">');
  if (meta.jsonld) tags.push(`<script type="application/ld+json">${jsonForScript(meta.jsonld)}</script>`);
  return out.replace(/<\/head>/i, () => tags.join('\n') + '\n</head>');
}

const robotsTxt = cfgIn => {
  const cfg = Object.assign({}, DEFAULTS, cfgIn || {});
  return `User-agent: *\nAllow: /\n\nSitemap: ${cfg.siteUrl}/sitemap.xml\n`;
};

// Every public page worth listing: the three fixed pages plus one per category (Flooring has its own page).
function sitemapPaths(categories) {
  const paths = ['/', '/flooring.html', '/materials.html'];
  (categories || []).filter(c => c && !isFlooring(c)).forEach(c => paths.push('/category.html?cat=' + encodeURIComponent(c)));
  return paths;
}
const sitemapXml = (paths, cfgIn) => {
  const cfg = Object.assign({}, DEFAULTS, cfgIn || {});
  return '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
    paths.map(p => `  <url><loc>${esc(cfg.siteUrl + p)}</loc></url>`).join('\n') + '\n</urlset>\n';
};

module.exports = { DEFAULTS, esc, brandOf, categoryLabel, pageMeta, parseHours, streetOf, phoneOf, localBusiness, jsonForScript, inject, robotsTxt, sitemapPaths, sitemapXml };
