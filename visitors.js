'use strict';
// ─── WHO VISITS THE PUBLIC SITE ──────────────────────────────────────────────
//
// Every page view on the public pages (home, flooring, materials, categories) is saved as one row in
// `visits`: when, which page, where they came from, phone or desktop, and an approximate place.
//
// Privacy: the full IP address is used only for the moment of the lookup. What is saved is the place
// (country / state / city, from an offline lookup, nothing is sent to anyone), a SHORTENED IP
// (last number dropped, 73.158.20.0) and a one-way "visitor id" that changes every day, so the same
// person can be counted once a day but cannot be followed from day to day.
// Rows older than RETAIN_DAYS are deleted. Search-engine bots, your own visits and visitors who send
// "Do Not Track" are left out.

const crypto = require('crypto');
const net = require('net');

const RETAIN_DAYS = 90;
const DAY = 86400e3;

let _geo;
/** Approximate place for an IP: { country, region, city } — or null when unknown. Works offline. */
function geoLookup(ip) {
  try {
    if (_geo === undefined) { try { _geo = require('geoip-lite'); } catch (_) { _geo = null; } }
    const g = _geo && _geo.lookup(ip);
    return g ? { country: g.country || '', region: g.region || '', city: g.city || '' } : null;
  } catch (_) { return null; }
}

function ensureTable(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS visits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT NOT NULL,
    path TEXT, source TEXT, device TEXT,
    country TEXT, region TEXT, city TEXT,
    ip_mask TEXT, vid TEXT
  )`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_visits_ts ON visits(ts)');
}

/** The visitor's IP from the proxy headers (Railway puts the real one in X-Forwarded-For), else the socket. */
function clientIp(req) {
  const h = req.headers || {};
  const raw = String(h['x-real-ip'] || h['x-forwarded-for'] || (req.socket && req.socket.remoteAddress) || '').split(',')[0].trim();
  return raw.replace(/^::ffff:/i, '');
}

/** 73.158.20.5 -> 73.158.20.0   ·   2606:4700:4700::1111 -> 2606:4700:4700:: */
function maskIp(ip) {
  ip = String(ip || '').trim();
  if (net.isIPv4(ip)) return ip.split('.').slice(0, 3).join('.') + '.0';
  if (net.isIPv6(ip)) {
    const [head, tail] = ip.split('::');
    const h = head ? head.split(':') : [];
    const t = tail === undefined ? [] : (tail ? tail.split(':') : []);
    const groups = tail === undefined ? h : [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t];
    return groups.slice(0, 3).join(':') + '::';
  }
  return '';
}

const BOT = /bot|crawl|spider|slurp|headless|lighthouse|pingdom|uptime|monitor|facebookexternalhit|preview|fetch|curl|wget|python|axios|go-http|java\/|okhttp|scrapy|httpclient|libwww|phantom|selenium|puppeteer|playwright/i;
const isBot = ua => !ua || BOT.test(String(ua));

function deviceOf(ua) {
  ua = String(ua || '');
  if (/iPad|Tablet|Kindle|Silk/i.test(ua) || (/Android/i.test(ua) && !/Mobile/i.test(ua))) return 'tablet';
  if (/Mobi|iPhone|iPod|Android|Windows Phone/i.test(ua)) return 'mobile';
  return 'desktop';
}

const SOURCES = [
  [/(^|\.)google\./, 'Google'], [/(^|\.)bing\.com$/, 'Bing'], [/(^|\.)yahoo\./, 'Yahoo'], [/duckduckgo\./, 'DuckDuckGo'],
  [/(^|\.)(facebook\.com|fb\.com|fb\.me)$/, 'Facebook'], [/(^|\.)instagram\.com$/, 'Instagram'],
  [/(^|\.)pinterest\./, 'Pinterest'], [/(^|\.)(youtube\.com|youtu\.be)$/, 'YouTube'], [/(^|\.)reddit\.com$/, 'Reddit'],
  [/(^|\.)nextdoor\.com$/, 'Nextdoor'], [/(^|\.)tiktok\.com$/, 'TikTok'], [/(^|\.)(twitter\.com|x\.com|t\.co)$/, 'X / Twitter'],
  [/(^|\.)craigslist\.org$/, 'Craigslist'],
];
/** Where they came from: "Direct", a well-known site by name, or the other site's host. Your own site counts as Direct. */
function sourceOf(ref, ownHost) {
  let h = '';
  try { h = new URL(String(ref || '')).hostname.toLowerCase().replace(/^www\./, ''); } catch (_) { return 'Direct'; }
  if (!h) return 'Direct';
  const own = String(ownHost || '').toLowerCase().replace(/:\d+$/, '').replace(/^www\./, '');
  if (own && h === own) return 'Direct';
  const hit = SOURCES.find(([re]) => re.test(h));
  return hit ? hit[1] : h;
}

const TRACKING_PARAM = /^(utm_|fbclid|gclid|msclkid|igshid|mc_|_ga|ref$)/i;
/** The page, without tracking junk: /category.html?category=Flooring */
function cleanPath(p) {
  try {
    const u = new URL(String(p || '/'), 'http://x');
    for (const k of [...u.searchParams.keys()]) if (TRACKING_PARAM.test(k)) u.searchParams.delete(k);
    const pathname = u.pathname === '/index.html' ? '/' : (u.pathname || '/');
    let out = pathname + (u.searchParams.toString() ? '?' + u.searchParams.toString() : '');
    if (out.length > 1 && out.endsWith('/')) out = out.slice(0, -1);
    return out.slice(0, 160);
  } catch (_) { return '/'; }
}

function visitorId(secret, ip, ua, now) {
  const day = new Date(now).toISOString().slice(0, 10);
  return crypto.createHash('sha256').update([secret || '', day, ip, ua].join('|')).digest('hex').slice(0, 12);
}

/**
 * Save one page view. Returns the saved row, or null when it was left out (bot, no address, or the
 * same visitor reloading the same page within 30 seconds).
 */
function record(db, hit, { secret = '', geo = geoLookup, now = Date.now() } = {}) {
  const ua = String(hit.ua || '');
  const ip = String(hit.ip || '');
  if (isBot(ua) || !ip) return null;
  const vid = visitorId(secret, ip, ua, now);
  const path = cleanPath(hit.path);
  const since = new Date(now - 30e3).toISOString();
  if (db.prepare('SELECT 1 FROM visits WHERE vid=? AND path=? AND ts>? LIMIT 1').get([vid, path, since])) return null;
  const g = geo(ip) || {};
  const row = {
    ts: new Date(now).toISOString(), path, source: sourceOf(hit.ref, hit.host), device: deviceOf(ua),
    country: g.country || '', region: g.region || '', city: g.city || '', ip_mask: maskIp(ip), vid,
  };
  db.prepare('INSERT INTO visits (ts,path,source,device,country,region,city,ip_mask,vid) VALUES (?,?,?,?,?,?,?,?,?)')
    .run([row.ts, row.path, row.source, row.device, row.country, row.region, row.city, row.ip_mask, row.vid]);
  return row;
}

/** Delete views older than `days`. */
function purge(db, days = RETAIN_DAYS, now = Date.now()) {
  db.prepare('DELETE FROM visits WHERE ts<?').run([new Date(now - days * DAY).toISOString()]);
}

const validTz = tz => { try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return tz; } catch (_) { return 'UTC'; } };
const dayKeyIn = (tz, ms) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));

let _names;
const countryName = c => {
  try { _names = _names || new Intl.DisplayNames(['en'], { type: 'region' }); return _names.of(c) || c; } catch (_) { return c; }
};
/** "Alameda, CA" · "Texas, US" · "Canada" · "Unknown" */
function placeLabel(r) {
  if (r.city) return r.city + ', ' + (r.region || r.country);
  if (r.region) return r.region + ', ' + r.country;
  return r.country ? countryName(r.country) : 'Unknown';
}

const tally = (rows, keyOf) => {
  const m = new Map();
  for (const r of rows) {
    const k = keyOf(r);
    const e = m.get(k) || { name: k, views: 0, ids: new Set() };
    e.views++; e.ids.add(r.vid);
    m.set(k, e);
  }
  return [...m.values()].map(e => ({ name: e.name, views: e.views, visitors: e.ids.size }))
    .sort((a, b) => b.visitors - a.visitors || b.views - a.views || a.name.localeCompare(b.name));
};

/**
 * What the Visitors tab shows for the last `days` days (1 = today), days counted in the owner's time zone.
 * "Visitors" are counted once per day (the visitor id changes daily).
 */
function summary(db, { days = 30, tz = 'UTC', now = Date.now() } = {}) {
  tz = validTz(tz);
  days = Math.min(RETAIN_DAYS, Math.max(1, Math.round(Number(days)) || 30));
  const dayKeys = [];
  for (let i = days - 1; i >= 0; i--) dayKeys.push(dayKeyIn(tz, now - i * DAY));
  const first = dayKeys[0];
  const rows = db.prepare('SELECT * FROM visits WHERE ts>=? ORDER BY ts DESC LIMIT 200000')
    .all([new Date(now - (days + 1) * DAY).toISOString()])
    .filter(r => dayKeyIn(tz, Date.parse(r.ts)) >= first);

  const perDay = new Map(dayKeys.map(k => [k, { day: k, views: 0, ids: new Set() }]));
  for (const r of rows) { const d = perDay.get(dayKeyIn(tz, Date.parse(r.ts))); if (d) { d.views++; d.ids.add(r.vid); } }
  const ids = new Set(rows.map(r => r.vid));
  return {
    days, tz, retainDays: RETAIN_DAYS,
    views: rows.length,
    visitors: ids.size,
    perDay: [...perDay.values()].map(d => ({ day: d.day, views: d.views, visitors: d.ids.size })),
    pages: tally(rows, r => r.path).slice(0, 15),
    sources: tally(rows, r => r.source || 'Direct').slice(0, 12),
    places: tally(rows, placeLabel).slice(0, 20),
    countries: tally(rows, r => (r.country ? countryName(r.country) : 'Unknown')).slice(0, 10),
    devices: tally(rows, r => r.device || 'desktop'),
    recent: rows.slice(0, 40).map(r => ({ ts: r.ts, place: placeLabel(r), path: r.path, source: r.source, device: r.device, ip: r.ip_mask })),
  };
}

module.exports = { ensureTable, record, purge, summary, clientIp, maskIp, isBot, deviceOf, sourceOf, cleanPath, placeLabel, geoLookup, RETAIN_DAYS };
