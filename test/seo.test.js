'use strict';
// Search tags: the title, description and address each page gets, the business details for Google, robots.txt and
// the sitemap. Made-up shop details, no database.
const S = require('../seo');
let passed = 0, failed = 0;
const eq = (n, a, b) => {
  if (JSON.stringify(a) === JSON.stringify(b)) { passed++; console.log(`  ✅ ${n}`); }
  else { failed++; console.log(`  ❌ ${n} — got ${JSON.stringify(a)}, wanted ${JSON.stringify(b)}`); }
};
const ok = (n, v) => eq(n, !!v, true);

const cfg = { siteUrl: 'https://example.test', city: 'Hopkins', region: 'MN' };
const settings = {
  business_name: 'Solids-Supply', business_phone: '(763) 319-6384', business_email: 'hi@example.test',
  business_address: '1415 Fifth St S, Suite C Hopkins, MN  55343 United States', business_hours: 'Mon–Fri 8am–6pm, Sat 9am–4pm',
  hero_tagline: 'Quality flooring, vanities & tools.',
};
const cats = ['Flooring', 'Vanity', 'Appliances'];
const meta = (page, extra = {}) => S.pageMeta(page, { settings, cfg, categories: cats, ...extra });

console.log('\n── Page titles ──');
eq('home title', meta('home').title, 'Flooring, Vanities & Building Materials in Hopkins, MN | Solids-Supply');
eq('home address is the root', meta('home').path, '/');
ok('flooring title names the product and the town', /^Luxury Vinyl Plank Flooring in Hopkins, MN/.test(meta('flooring').title));
ok('flooring description mentions Duraplex', /Duraplex/.test(meta('flooring').description));
eq('flooring address', meta('flooring').path, '/flooring.html');
eq('materials address', meta('materials').path, '/materials.html');
eq('shop name falls back when none is saved', S.pageMeta('home', { settings: {}, cfg }).title.endsWith('| Solids Supply'), true);
['home', 'flooring', 'materials'].forEach(p => ok(`${p} description fits a search result`, meta(p).description.length <= 175));

console.log('\n── Category pages ──');
eq('Vanity becomes Bathroom Vanities', meta('category', { category: 'Vanity' }).title, 'Bathroom Vanities in Hopkins, MN | Solids-Supply');
eq('category is matched in any case', meta('category', { category: 'appliances' }).path, '/category.html?cat=Appliances');
eq('category description names the town', /in stock in Hopkins, MN/.test(meta('category', { category: 'Appliances' }).description), true);
eq('a real category can be found by search engines', meta('category', { category: 'Vanity' }).robots, undefined);
eq('Flooring goes to its own page', meta('category', { category: 'flooring' }).redirect, '/flooring.html');
eq('Flooring with a search stays on the category page', meta('category', { category: 'flooring', query: 'oak' }).redirect, undefined);
eq('an unknown category is kept out of results', meta('category', { category: 'zzz' }).robots, 'noindex, follow');
eq('an unknown category uses the plain address', meta('category', { category: 'zzz' }).path, '/category.html');
eq('a search is kept out of results', meta('category', { category: 'Vanity', query: 'white' }).robots, 'noindex, follow');
eq('a search title does not repeat what was typed', meta('category', { query: '<script>' }).title, 'Search results | Solids-Supply');
eq('no category at all', meta('category').title, 'All Building Materials in Hopkins, MN | Solids-Supply');

console.log('\n── Opening hours ──');
const h = S.parseHours('Mon–Fri 8am–6pm, Sat 9am–4pm');
eq('two entries', h.length, 2);
eq('weekdays', h[0].dayOfWeek, ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday']);
eq('weekday times', [h[0].opens, h[0].closes], ['08:00', '18:00']);
eq('Saturday', h[1].dayOfWeek, ['Saturday']);
eq('Saturday times', [h[1].opens, h[1].closes], ['09:00', '16:00']);
eq('noon and midnight', [S.parseHours('Mon 12pm-12am')[0].opens, S.parseHours('Mon 12pm-12am')[0].closes], ['12:00', '00:00']);
eq('minutes', S.parseHours('Mon-Fri 8:30am - 5:15pm')[0].closes, '17:15');
eq('a closed day is skipped, the rest is kept', S.parseHours('Mon–Fri 8am–6pm, Sun closed').length, 1);
eq('a range that wraps the week', S.parseHours('Fri–Mon 9am–5pm')[0].dayOfWeek, ['Friday', 'Saturday', 'Sunday', 'Monday']);
eq('text it cannot read gives nothing', S.parseHours('by appointment'), []);
eq('empty', S.parseHours(''), []);

console.log('\n── Business details for Google ──');
const lb = S.localBusiness(settings, cfg);
eq('type', lb['@type'], 'HomeGoodsStore');
eq('name', lb.name, 'Solids-Supply');
eq('phone is written with the country code', lb.telephone, '+1-763-319-6384');
eq('street stops before the city', lb.address.streetAddress, '1415 Fifth St S, Suite C');
eq('town', [lb.address.addressLocality, lb.address.addressRegion], ['Hopkins', 'MN']);
eq('zip', lb.address.postalCode, '55343');
eq('website', lb.url, 'https://example.test/');
eq('hours are included', lb.openingHoursSpecification.length, 2);
const bare = S.localBusiness({}, cfg);
eq('nothing saved: just the name and website', Object.keys(bare).sort(), ['@context', '@type', 'image', 'name', 'url']);
eq('a phone that is not ten digits is left alone', S.phoneOf('763-319'), '763-319');
eq('street when the town is not in the address', S.streetOf('12 Main St', 'Hopkins'), '12 Main St');
eq('a setting cannot close the script tag', S.jsonForScript({ a: '</script><b>' }).includes('</script>'), false);

console.log('\n── Adding the tags to a page ──');
const page = '<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Old</title><meta name="description" content="old text"></head><body>x</body></html>';
const out = S.inject(page, { ...meta('home'), jsonld: lb }, cfg, 'Solids-Supply');
eq('title replaced', /<title>Flooring, Vanities &amp; Building Materials in Hopkins, MN \| Solids-Supply<\/title>/.test(out), true);
eq('only one title', (out.match(/<title>/g) || []).length, 1);
eq('only one description', (out.match(/name="description"/g) || []).length, 1);
ok('description replaced', out.includes('in stock in Hopkins, MN. Request a quote'));
ok('canonical link', out.includes('<link rel="canonical" href="https://example.test/">'));
ok('share preview address', out.includes('<meta property="og:url" content="https://example.test/">'));
ok('share preview image', out.includes('content="https://example.test/icon-512.png"'));
ok('icons added', out.includes('rel="icon"') && out.includes('rel="apple-touch-icon"'));
ok('business markup added', out.includes('<script type="application/ld+json">') && out.includes('"@type":"HomeGoodsStore"'));
eq('no robots tag on a normal page', out.includes('name="robots"'), false);
ok('body untouched', out.includes('<body>x</body>'));
const kept = S.inject('<html><head><link rel="icon" href="/a.png"><link rel="apple-touch-icon" href="/b.png"></head></html>', meta('home'), cfg);
eq('own icons are not doubled', (kept.match(/rel="icon"/g) || []).length + (kept.match(/rel="apple-touch-icon"/g) || []).length, 2);
const bare2 = S.inject('<html><head></head><body></body></html>', meta('home'), cfg);
ok('a page with no title or description gets both', bare2.includes('<title>') && bare2.includes('name="description"'));
const hidden = S.inject(page, meta('category', { category: 'zzz' }), cfg);
ok('a hidden page says so', hidden.includes('<meta name="robots" content="noindex, follow">'));
const evil = S.inject(page, { title: 'A "quote" & <b>', description: 'x', path: '/' }, cfg);
ok('title text is escaped', evil.includes('A &quot;quote&quot; &amp; &lt;b&gt;') && !evil.includes('<b>'));
ok('a $ in a title is not treated as a pattern', S.inject(page, { title: 'Save $& more', description: 'd', path: '/' }, cfg).includes('<title>Save $&amp; more</title>'));

console.log('\n── robots.txt and sitemap ──');
eq('robots.txt', S.robotsTxt(cfg), 'User-agent: *\nAllow: /\n\nSitemap: https://example.test/sitemap.xml\n');
eq('sitemap pages', S.sitemapPaths(cats), ['/', '/flooring.html', '/materials.html', '/category.html?cat=Vanity', '/category.html?cat=Appliances']);
eq('sitemap skips blanks', S.sitemapPaths(['', null, 'Tools & More']), ['/', '/flooring.html', '/materials.html', '/category.html?cat=Tools%20%26%20More']);
const xml = S.sitemapXml(['/', '/category.html?cat=A&B'], cfg);
ok('sitemap is XML', xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>'));
ok('sitemap addresses are full', xml.includes('<loc>https://example.test/</loc>'));
ok('an ampersand is escaped', xml.includes('cat=A&amp;B'));

console.log('\n' + '─'.repeat(60));
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
