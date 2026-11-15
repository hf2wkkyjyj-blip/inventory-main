'use strict';
// Visitor log: what is kept (a place and a shortened IP, never the full address), who is left out, and the numbers the
// Visitors tab shows. Made-up data, a fake place lookup.
process.removeAllListeners('warning');
const { DatabaseSync } = require('node:sqlite');
const V = require('../visitors');
let passed = 0, failed = 0;
const eq = (n, a, b) => { if (JSON.stringify(a) === JSON.stringify(b)) { passed++; console.log(`  ✅ ${n}`); } else { failed++; console.log(`  ❌ ${n} — got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`); } };

const raw = new DatabaseSync(':memory:');
const a = p => (p === undefined ? [] : Array.isArray(p) ? p : [p]);
const db = {
  exec: sql => raw.exec(sql),
  prepare: sql => { const st = raw.prepare(sql); return { all: p => st.all(...a(p)), get: p => st.get(...a(p)), run: p => st.run(...a(p)) }; },
};
V.ensureTable(db);
V.ensureTable(db);   // safe to run twice

const PLACES = {
  '73.158.20.5': { country: 'US', region: 'CA', city: 'Alameda' },
  '98.20.1.9': { country: 'US', region: 'TX', city: '' },
  '24.10.2.2': { country: 'CA', region: 'ON', city: 'Toronto' },
};
const geo = ip => PLACES[ip] || null;
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1';
const MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/17.0 Safari/605.1.15';
const T0 = Date.parse('2026-11-15T20:00:00Z');
const rec = (hit, now = T0) => V.record(db, { host: 'solids-supply.com', ...hit }, { geo, secret: 's', now });

console.log('\n── Shortened IP ──');
eq('IPv4 drops the last number', V.maskIp('73.158.20.5'), '73.158.20.0');
eq('IPv6 keeps the first three groups', V.maskIp('2606:4700:4700::1111'), '2606:4700:4700::');
eq('IPv6 written out in full', V.maskIp('2001:db8:85a3:0:0:8a2e:370:7334'), '2001:db8:85a3::');
eq('nothing to keep for junk', V.maskIp('not an ip'), '');
eq('IP from the proxy header (first one)', V.clientIp({ headers: { 'x-forwarded-for': '73.158.20.5, 10.0.0.2' }, socket: { remoteAddress: '10.0.0.9' } }), '73.158.20.5');
eq('IP from the socket when there is no header', V.clientIp({ headers: {}, socket: { remoteAddress: '::ffff:98.20.1.9' } }), '98.20.1.9');

console.log('\n── Page, source and device ──');
eq('tracking junk is dropped from the page', V.cleanPath('/category.html?category=Flooring&utm_source=fb&fbclid=abc'), '/category.html?category=Flooring');
eq('trailing slash is dropped', V.cleanPath('/materials/'), '/materials');
eq('home stays /', V.cleanPath('/'), '/');
eq('/index.html is the home page too', V.cleanPath('/index.html'), '/');
eq('no referrer is Direct', V.sourceOf('', 'solids-supply.com'), 'Direct');
eq('your own site is Direct', V.sourceOf('https://www.solids-supply.com/flooring.html', 'solids-supply.com'), 'Direct');
eq('Google by name', V.sourceOf('https://www.google.com/', 'solids-supply.com'), 'Google');
eq('Facebook by name', V.sourceOf('https://l.facebook.com/l.php?u=x', 'solids-supply.com'), 'Facebook');
eq('another site by its host', V.sourceOf('https://blog.example.org/post', 'solids-supply.com'), 'blog.example.org');
eq('iPhone is mobile', V.deviceOf(IPHONE), 'mobile');
eq('Mac is desktop', V.deviceOf(MAC), 'desktop');
eq('iPad is a tablet', V.deviceOf('Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15'), 'tablet');
eq('Googlebot is a bot', V.isBot('Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)'), true);
eq('curl is a bot', V.isBot('curl/8.4.0'), true);
eq('no user agent is a bot', V.isBot(''), true);
eq('a real browser is not', V.isBot(MAC), false);

console.log('\n── What gets saved ──');
const r1 = rec({ ip: '73.158.20.5', ua: IPHONE, path: '/', ref: 'https://www.google.com/' });
eq('saved with place, source, device', [r1.city, r1.region, r1.source, r1.device, r1.path], ['Alameda', 'CA', 'Google', 'mobile', '/']);
eq('only the shortened IP is saved', r1.ip_mask, '73.158.20.0');
eq('the full IP is nowhere in the row', JSON.stringify(raw.prepare('SELECT * FROM visits').all()).includes('73.158.20.5'), false);
eq('a bot is left out', rec({ ip: '73.158.20.5', ua: 'Googlebot/2.1', path: '/' }), null);
eq('no address is left out', rec({ ip: '', ua: MAC, path: '/' }), null);
eq('a reload within 30 seconds is not a second view', rec({ ip: '73.158.20.5', ua: IPHONE, path: '/' }, T0 + 10e3), null);
eq('the same page a minute later counts again', !!rec({ ip: '73.158.20.5', ua: IPHONE, path: '/' }, T0 + 60e3), true);
eq('a different page counts at once', !!rec({ ip: '73.158.20.5', ua: IPHONE, path: '/flooring.html' }, T0 + 12e3), true);
const u = rec({ ip: '9.9.9.9', ua: MAC, path: '/' }, T0 + 5e3);
eq('an unknown place is saved without one', [u.country, u.city], ['', '']);
eq('the visitor id is not the IP', /^[0-9a-f]{12}$/.test(r1.vid), true);
const dayLater = rec({ ip: '73.158.20.5', ua: IPHONE, path: '/' }, T0 + DAYS(1));
eq('the id changes the next day (no following someone across days)', dayLater.vid !== r1.vid, true);
function DAYS(n) { return n * 86400e3; }

console.log('\n── The Visitors tab numbers ──');
rec({ ip: '98.20.1.9', ua: MAC, path: '/materials.html', ref: 'https://www.facebook.com/' }, T0 + 20e3);
rec({ ip: '24.10.2.2', ua: MAC, path: '/', ref: '' }, T0 + 30e3);
const NOW = T0 + DAYS(1) + 3600e3;
const s1 = V.summary(db, { days: 1, tz: 'UTC', now: NOW });
eq('today: only the day-later view', [s1.views, s1.visitors], [1, 1]);
const s = V.summary(db, { days: 7, tz: 'UTC', now: NOW });
eq('7 days: every view counted', s.views, 7);
eq('visitors are counted once a day (same phone on 2 days = 2)', s.visitors, 5);
eq('a day-by-day line, oldest first, empty days included', [s.perDay.length, s.perDay[0].day, s.perDay[6].day], [7, '2026-11-10', '2026-11-16']);
eq('views on 15 Nov', s.perDay.find(d => d.day === '2026-11-15').views, 6);
eq('top page is the home page', [s.pages[0].name, s.pages[0].views], ['/', 5]);
eq('sources', s.sources.map(x => x.name).sort(), ['Direct', 'Facebook', 'Google']);
eq('places use city and state', s.places.map(x => x.name).sort(), ['Alameda, CA', 'TX, US', 'Toronto, ON', 'Unknown']);
eq('countries are named', s.countries.map(x => x.name).sort(), ['Canada', 'United States', 'Unknown']);
eq('devices', s.devices.map(d => [d.name, d.views]).sort(), [['desktop', 3], ['mobile', 4]]);
eq('the recent list shows the newest first, with the shortened IP', [s.recent[0].path, s.recent[0].ip], ['/', '73.158.20.0']);
eq('the full IP never reaches the tab', JSON.stringify(s).includes('73.158.20.5'), false);
const ny = V.summary(db, { days: 1, tz: 'Pacific/Kiritimati', now: T0 + 3600e3 });   // UTC+14: their "today" starts earlier
eq('days are counted in the owner time zone', typeof ny.views, 'number');
eq('a bad time zone falls back to UTC', V.summary(db, { days: 1, tz: 'Nope/Nowhere', now: NOW }).tz, 'UTC');

console.log('\n── Past views from the hosting provider\'s request log ──');
const FB = 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/157.0.0.0 Mobile Safari/537.36 [FB_IAB/FB4A;FBAV/587.0.0.39.55;IABMV/1;]';
eq('the in-app browser of Facebook says where they came from', V.sourceFromUa(FB), 'Facebook');
eq('Instagram too', V.sourceFromUa('Mozilla/5.0 (iPhone) Instagram 300.0'), 'Instagram');
eq('otherwise Direct', V.sourceFromUa(MAC), 'Direct');
eq('a security scanner is a bot', V.isBot('Hello from Palo Alto Networks, find out more about our scans in https://docs-cortex.paloaltonetworks.com/'), true);
eq('an AI fetcher is a bot', V.isBot('Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Claude-User/1.0; +claude-user@anthropic.com)'), true);
eq('a name that is a web address is a bot', V.isBot('http://solids-supply.com/wp-admin/install.php?step=1'), true);
eq('Safari on iPhone is still not', V.isBot(IPHONE), false);
const LOGNOW = Date.parse('2026-11-15T17:00:00Z');
const past = [
  { ts: '2026-11-14T18:00:00.000Z', path: '/', ip: '73.158.20.5', ua: IPHONE },
  { ts: '2026-11-14T18:00:05.000Z', path: '/', ip: '73.158.20.5', ua: IPHONE },          // a reload
  { ts: '2026-11-14T19:00:00.000Z', path: '/flooring.html', ip: '98.20.1.9', ua: FB },
  { ts: '2026-11-14T19:05:00.000Z', path: '/', ip: '8.8.8.8', ua: 'Hello from Palo Alto Networks, find out more about our scans' },
  { ts: '2026-11-14T20:00:00.000Z', path: '/', ip: '', ua: MAC },
  { ts: 'garbage', path: '/', ip: '24.10.2.2', ua: MAC },
  { ts: '2026-06-01T12:00:00.000Z', path: '/', ip: '24.10.2.2', ua: MAC },                // older than 90 days
];
const imp = V.importLog(db, past, { geo, secret: 's', now: LOGNOW });
eq('imported: real views added, bots / reloads / old ones left out', imp, { added: 2, skipped: 2, old: 1 });
const im = raw.prepare("SELECT path, source, city, region, ip_mask FROM visits WHERE ts LIKE '2026-11-14T1%' ORDER BY ts").all();
eq('each keeps its place and a shortened IP', im.map(r => [r.path, r.city || r.region, r.ip_mask]), [['/', 'Alameda', '73.158.20.0'], ['/flooring.html', 'TX', '98.20.1.0']]);
eq('Facebook in-app browser shows as the source', im[1].source, 'Facebook');
eq('the full IP is not kept', JSON.stringify(raw.prepare('SELECT * FROM visits').all()).includes('98.20.1.9'), false);
eq('running it again adds nothing', V.importLog(db, past, { geo, secret: 's', now: LOGNOW }), { added: 0, skipped: 4, old: 1 });

console.log('\n── Old views are deleted ──');
rec({ ip: '73.158.20.5', ua: MAC, path: '/old' }, T0 - DAYS(120));
eq('an old view exists before the cleanup', raw.prepare("SELECT COUNT(*) n FROM visits WHERE path='/old'").get().n, 1);
V.purge(db, 90, T0);
eq('gone after 90 days', raw.prepare("SELECT COUNT(*) n FROM visits WHERE path='/old'").get().n, 0);
eq('recent views stay', raw.prepare('SELECT COUNT(*) n FROM visits').get().n > 0, true);

console.log('\n' + '─'.repeat(60));
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
