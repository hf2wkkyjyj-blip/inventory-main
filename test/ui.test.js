'use strict';
// ─── BROWSER-LEVEL TEST OF THE PRODUCT EDITOR ────────────────────────────────
//
// Runs the REAL public/admin.html in jsdom (a real DOM + CSS engine), wired to
// the REAL route handlers from server.js, on a REAL SQLite database. It clicks
// the actual buttons and checks what appears on screen.
//
// Why this exists: the edit dialog was shown with style.display='flex', but
// every .overlay on the page is hidden with opacity:0 / pointer-events:none and
// only revealed by the `open` class. Static checks all passed — the handler
// existed, the ids existed, the script parsed — yet the dialog was invisible and
// unclickable. Only rendering the page catches that.
//
// Requires jsdom:  npm i -D jsdom   (skipped with a notice if not installed)

process.removeAllListeners('warning');
const fs     = require('fs');
const path   = require('path');
const Module = require('module');

let JSDOM;
for (const p of ['jsdom', '/tmp/uitest/node_modules/jsdom']) {
  try { ({ JSDOM } = require(p)); break; } catch (_) {}
}
if (!JSDOM) { console.log('\n  ⏭️  jsdom not installed — UI test skipped (npm i -D jsdom)'); process.exit(0); }

const { DatabaseSync } = require('node:sqlite');

// ── Real SQLite behind node-sqlite3-wasm's API ──────────────────────────────
let DB = null;
class RealDatabase {
  constructor() {
    this.raw = new DatabaseSync(':memory:');
    DB = this;
  }
  exec(sql) { this.raw.exec(sql); }
  prepare(sql) {
    const st = this.raw.prepare(sql);
    const norm = p => (p === undefined ? [] : Array.isArray(p) ? p : [p]);
    return {
      all: p => st.all(...norm(p)),
      get: p => st.get(...norm(p)),
      run: p => st.run(...norm(p)),
    };
  }
  close() {}
}

// ── Capture server.js routes ────────────────────────────────────────────────
const routes = [];
function fakeExpress() {
  const app = {};
  for (const verb of ['get', 'post', 'put', 'patch', 'delete', 'options', 'head', 'all']) {
    app[verb] = (p, ...handlers) => {
      if (typeof p === 'string') routes.push({ verb: verb.toUpperCase(), path: p, handlers });
      return app;
    };
  }
  app.use = () => app; app.set = () => app;
  app.listen = (_p, cb) => { if (typeof cb === 'function') cb(); return { close() {} }; };
  return app;
}
fakeExpress.json = fakeExpress.urlencoded = fakeExpress.static = () => (q, s, n) => n && n();
fakeExpress.Router = fakeExpress;

const STUBS = {
  'express':           fakeExpress,
  'node-sqlite3-wasm': { Database: RealDatabase },
  'bcryptjs':          { hashSync: () => 'x', compareSync: () => true },
  'jsonwebtoken':      { sign: () => 't', verify: () => ({ admin: true, role: 'admin' }) },
  'multer':            Object.assign(() => ({ single: () => (q, s, n) => n(), array: () => (q, s, n) => n() }), { memoryStorage: () => ({}), diskStorage: () => ({}) }),
  'puppeteer-core':    { launch: async () => ({}) },
  'node-imap':         function Imap() {},
  'mailparser':        { simpleParser: async () => ({}) },
  'dotenv':            { config: () => ({}) },
};
const origLoad = Module._load;
Module._load = function (req, ...rest) {
  return Object.prototype.hasOwnProperty.call(STUBS, req) ? STUBS[req] : origLoad.apply(this, [req, ...rest]);
};
const realSetInterval = global.setInterval, realSetTimeout = global.setTimeout;
global.setInterval = () => 0; global.setTimeout = () => 0;   // no background jobs
const quiet = console.log; console.log = () => {};
require(path.join(__dirname, '..', 'server.js'));
console.log = quiet;
global.setInterval = realSetInterval; global.setTimeout = realSetTimeout;

// ── Seed orders (real titles from the user's data) ──────────────────────────
const TECH_TARGET = 'Pokémon Trading Card Game: 30th Celebration Tech Sticker Collection (Lucario or Alolan Exeggutor)- Styles May Vary';
const TECH_PKC    = 'Pokemon TCG: 30th Celebration Tech Sticker Collection (Lucario)';
const seed = [
  ['901', 'Target',         JSON.stringify(['2x Pokémon 30th Anniversary EX Box 1 @ $29.99']), 65.09],
  ['902', 'Target',         JSON.stringify(['2x Pokemon 30th Anniversary EX Box 1 ($29.99/ea)']), 65.09],
  ['903', 'Target',         JSON.stringify([`2x ${TECH_TARGET} @ $19.99`]), 43.39],
  ['P04', 'Pokemon Center', JSON.stringify([`1x ${TECH_PKC} (SKU 10-10449-122) @ $19.99`]), 21.70],
];
// Shipped orders with tracking, for the expand-to-see-tracking feature.
const EMBOAR = 'Pokemon Trading Card Game: Mega Evolution—Ascended Heroes Tin- Mega Emboar ex';
const SHIPPED = [
  ['S01', 'Target',         '1ZAA11110000000001', 'OFD',  '2026-09-25', 'Sam Carter', '4200 Example Blvd, Springfield, MN'],
  ['S02', 'Target',         '1ZAA11110000000002', null,   '2026-09-27', 'Acme Market',  '1000 Test ave n, Springfield, MN'],
  ['S03', 'Pokemon Center', '876543210987',       null,   '2026-09-26', 'Dana Lee',   '5000 E Sample Park Rd'],
  ['S04', 'Target',         null,                 null,   null,         'Kim Park', '1300 12th ave n'],
];
// server.js really boots, so it really imports bot_orders_import.json. Clear it
// so assertions below depend only on the orders seeded here.
DB.prepare('DELETE FROM bot_orders').run();
for (const [num, retailer, items, total] of seed) {
  DB.prepare(`INSERT INTO bot_orders (category, retailer, order_number, status, items, order_total)
              VALUES ('Pokemon', ?, ?, 'Delivered', ?, ?)`).run([retailer, num, items, total]);
}
const BOX_ITEMS = JSON.stringify([
  '2x Pokemon TCG: 30th Celebration Pokemon Center Elite Trainer Box (SKU 10-10447-111)',
  '1x Pokemon TCG: 30th Celebration Knock Out Collection (SKU 10-10667-101)',
  '1x Pokemon TCG: Mega Evolution-Pitch Black Booster Bundle (6 Packs) (SKU 10-10422-109)',
]);
const PKC_SHIPPED = [
  // one box, three products
  ['P0099000001', '870000000301', 'Chris Moss',  '1000 Test Ave North Fl 6, Springfield, MN 55001'],
  // same tracking on two orders to two buildings — seen in the real data
  ['P0099000002', '870000000302', 'Alex Rivera', '1000 Test Ave N Apt 3f, Springfield, MN 55001'],
  ['P0099000003', '870000000302', 'Bea Tran',    '05000 E Sample Park Dr Rm 5, Springfield, MN 55002'],
];
for (const [num, trk, name, addr] of PKC_SHIPPED) {
  DB.prepare(`INSERT INTO bot_orders (category, retailer, order_number, status, tracking, expected_date,
              shipping_name, shipping_address, items, order_total)
              VALUES ('Pokemon','Pokemon Center',?,'Shipped',?,'2026-09-29',?,?,?,165.21)`)
    .run([num, trk, name, addr, BOX_ITEMS]);
}
for (const [num, retailer, trk, tstat, exp, name, addr] of SHIPPED) {
  DB.prepare(`INSERT INTO bot_orders (category, retailer, order_number, status, tracking, tracking_status,
              expected_date, shipping_name, shipping_address, items, order_total)
              VALUES ('Pokemon', ?, ?, 'Shipped', ?, ?, ?, ?, ?, ?, 54.24)`)
    .run([retailer, num, trk, tstat, exp, name, addr, JSON.stringify([`2x ${EMBOAR} @ $24.99`])]);
}

// Non-Pokemon orders: selling must work for every order, not just Pokemon.
DB.prepare(`INSERT INTO bot_orders (category, retailer, order_number, status, items, order_total)
            VALUES ('Mattel','Mattel','M01','Delivered',?,32.50)`)
  .run([JSON.stringify(['1x Hot Wheels Test Car Set @ $30.00'])]);
DB.prepare(`INSERT INTO bot_orders (category, retailer, order_number, status, items, order_total)
            VALUES (NULL,'Bear Walker','B01','Delivered',?,20.00)`)
  .run([JSON.stringify(['2x Sample Card Sleeves @ $10.00'])]);

// A box with two orders on one tracking number, item prices known (made up).
DB.prepare(`INSERT INTO bot_orders (category, retailer, order_number, status, tracking, shipping_name, shipping_address, items, order_total)
            VALUES ('One Piece','Test Store','F01','Delivered','870000000401','Test Buyer','1 Test St, Springfield',?,140)`)
  .run([JSON.stringify(['2x Test Deck Box @ $60.00', '1x Test Collector Tin @ $20.00'])]);
DB.prepare(`INSERT INTO bot_orders (category, retailer, order_number, status, tracking, shipping_name, shipping_address, items, order_total)
            VALUES ('One Piece','Test Store','F02','Delivered','870000000401','Test Buyer','1 Test St, Springfield',?,120)`)
  .run([JSON.stringify(['3x Test Card Bundle @ $40.00'])]);

// A "drop": the same order placed many times (made up). Plus near-misses.
for (const [num, retailer, items, status, fee] of [
  ['D01', 'Test Drop Store', ['2x Test Drop Car @ $32.50'], 'Confirmed', 0],
  ['D02', 'Test Drop Store', ['2x Test Drop Car @ $32.50'], 'Confirmed', 0],
  ['D03', 'Test Drop Store', ['2x Test Drop Car @ $32.50'], 'Shipped',   0],
  ['D04', 'Test Drop Store', ['2x Test Drop Car @ $32.50'], 'Confirmed', 20],    // has its own fee
  ['D05', 'Test Drop Store', ['1x Test Drop Car @ $32.50'], 'Confirmed', 0],     // different qty
  ['D06', 'Other Test Shop', ['2x Test Drop Car @ $32.50'], 'Confirmed', 0],     // different store
  ['D07', 'Test Drop Store', ['2x Test Drop Car @ $32.50'], 'Cancelled', 0],     // cancelled
]) {
  DB.prepare(`INSERT INTO bot_orders (category, retailer, order_number, status, items, order_total, finder_fee, shipping_name)
              VALUES ('Mattel',?,?,?,?,65,?,'Test Buyer')`).run([retailer, num, status, JSON.stringify(items), fee]);
}

// ── Route dispatch for the page's fetch() ───────────────────────────────────
const calls = [];
function matchRoute(verb, pathname) {
  for (const r of routes) {
    if (r.verb !== verb) continue;
    const keys = [];
    const re = new RegExp('^' + r.path.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
    const m = pathname.match(re);
    if (m) return { route: r, params: Object.fromEntries(keys.map((k, i) => [k, decodeURIComponent(m[i + 1])])) };
  }
  return null;
}
async function fakeFetch(url, opts = {}) {
  const u = new URL(url, 'http://localhost');
  const verb = (opts.method || 'GET').toUpperCase();
  const body = opts.body ? JSON.parse(opts.body) : {};
  calls.push({ verb, path: u.pathname, body });
  const hit = matchRoute(verb, u.pathname);
  if (!hit) return { status: 200, ok: true, json: async () => (verb === 'GET' ? [] : {}) };

  const req = { method: verb, query: Object.fromEntries(u.searchParams), params: hit.params, body,
                headers: { authorization: 'Bearer t' } };
  let status = 200, payload = null;
  const res = {
    status(c) { status = c; return res; }, json(d) { payload = d; return res; },
    send(d) { payload = d; return res; }, header() { return res; }, set() { return res; }, end() { return res; },
  };
  for (const h of hit.route.handlers) {
    let advanced = false;
    await h(req, res, () => { advanced = true; });
    if (!advanced) break;
  }
  return { status, ok: status < 400, json: async () => payload };
}

// ── Load the real page ──────────────────────────────────────────────────────
const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'admin.html'), 'utf8');
const dom = new JSDOM(html, {
  url: 'http://localhost/admin.html',
  runScripts: 'dangerously',
  pretendToBeVisual: true,
  beforeParse(w) {
    w.localStorage.setItem('inv_admin_token', 't');
    w.localStorage.setItem('inv_admin_role', 'admin');
    w.fetch   = fakeFetch;
    w.confirm = m => { confirms.push(String(m)); return confirmAnswer; };
    Object.defineProperty(w.navigator, 'clipboard', { value: { writeText: async t => { copied.push(t); } }, configurable: true });
    w.alert   = m => { alerts.push(String(m)); };
  },
});
const alerts = [];
const confirms = [];
let confirmAnswer = true;
const copied = [];
const w = dom.window, d = w.document;
const tick = (n = 25) => new Promise(r => realSetTimeout(r, n));

let passed = 0, failed = 0;
const check = (n, c, detail) => {
  if (c) { passed++; console.log(`  ✅ ${n}`); }
  else   { failed++; console.log(`  ❌ ${n}${detail !== undefined ? ` — ${detail}` : ''}`); }
};

// Direct children only — expanded products contain a nested table of orders,
// and '#bot-item-tbody tr' would count those inner rows as products.
const rows     = () => [...d.querySelectorAll('#bot-item-tbody > tr:not(.bot-subrow)')];
const subrows  = () => [...d.querySelectorAll('#bot-item-tbody > tr.bot-subrow')];
const rowNamed = re => rows().find(tr => re.test(tr.textContent));
const overlay  = () => d.getElementById('bot-item-edit-overlay');
const isVisible = el => {
  const cs = w.getComputedStyle(el);
  return el.classList.contains('open') && cs.opacity === '1' && cs.pointerEvents !== 'none' && cs.display !== 'none';
};
const editBtn  = tr => tr.querySelector('button[title="Edit item"]');
// Dollar figure on a stat card, e.g. "+$1,234.50" → 1234.5
const cardMoney = id => { const t = d.getElementById(id).textContent.replace(/[,$+\s]/g, '').replace('−', '-'); return parseFloat(t) || 0; };
// All tab → "Order list" switch, by real clicks (All shows products by default).
async function openOrderList() {
  if (!d.querySelector('.btab')) { await w.loadBotOrders(); await tick(40); }   // tabs are built by the page's own load
  [...d.querySelectorAll('.btab')].find(b => /^All/.test(b.textContent.trim())).click(); await tick(80);
  const btn = [...d.querySelectorAll('#bot-view-switch button')].find(b => /Order list/.test(b.textContent));
  if (btn) { btn.click(); await tick(60); }
  return !!btn && d.getElementById('bot-orders-wrap').style.display === 'block';
}
const saveBtn  = () => [...overlay().querySelectorAll('button')].find(b => /Save/.test(b.textContent));

(async () => {
  await tick(60);
  d.getElementById('bot-cat-tabs').dataset.active = 'Pokemon';
  await w.loadBotItemView('Pokemon');
  await tick();

  console.log('\n── Item view renders ──');
  check('rows rendered',                  rows().length >= 3, rows().length);
  const ex = rowNamed(/EX Box 1/);
  check('EX Box grouped into one row',    rows().filter(tr => /EX Box 1/.test(tr.textContent)).length === 1);
  check('marked SUGGESTED',               ex && /SUGGESTED/.test(ex.textContent));
  check('dialog hidden before clicking',  !isVisible(overlay()));

  console.log('\n── Clicking ✎ opens a VISIBLE dialog (the reported bug) ──');
  editBtn(ex).click();
  await tick();
  const cs = w.getComputedStyle(overlay());
  check('dialog has the open class',      overlay().classList.contains('open'));
  check('dialog is opaque',               cs.opacity === '1', `opacity=${cs.opacity}`);
  check('dialog accepts clicks',          cs.pointerEvents !== 'none', `pointer-events=${cs.pointerEvents}`);
  check('name prefilled with suggestion', d.getElementById('bie-name').value === '30th Anniversary EX Box 1', d.getElementById('bie-name').value);
  check('store titles listed',            d.getElementById('bie-titles').textContent.includes('EX Box 1'));

  console.log('\n── Fix the name and Save ──');
  d.getElementById('bie-name').value = 'Sylveon ex Box';
  saveBtn().click();
  await tick(60);
  const save = calls.filter(c => c.path === '/api/admin/sku-products/save').pop();
  check('save request sent',              !!save);
  check('sent the new name',              save && save.body.name === 'Sylveon ex Box');
  // "Pokémon …" and "Pokemon …" are one store title once accents are normalised.
  check('sent the EX Box store title',    save && save.body.rawNames.length === 1 && /EX Box 1/.test(save.body.rawNames[0]), save && JSON.stringify(save.body.rawNames));
  check('dialog closed',                  !isVisible(overlay()));
  check('no error alert',                 alerts.length === 0, alerts.join(' | '));

  console.log('\n── List regrouped on screen ──');
  const sy = rowNamed(/Sylveon ex Box/);
  check('row shows new name',             !!sy);
  check('no longer SUGGESTED',            sy && !/SUGGESTED/.test(sy.textContent));
  check('still 4 units',                  sy && sy.querySelectorAll('td')[1].textContent.trim() === '4', sy && sy.querySelectorAll('td')[1].textContent);
  check('old long name gone',             !rowNamed(/30th Anniversary EX Box 1/));
  check('product stored in database',     DB.prepare("SELECT name FROM sku_products WHERE name='Sylveon ex Box'").get() !== undefined);
  check('orders NOT rewritten',           /EX Box 1/.test(DB.prepare("SELECT items FROM bot_orders WHERE order_number='901'").get().items));

  console.log('\n── Merge two rows into one SKU ──');
  const techRows = rows().filter(tr => /Tech Sticker/.test(tr.textContent));
  check('two Tech Sticker rows before',   techRows.length === 2, techRows.length);
  // Confirm the first as a product, then merge the second into it.
  editBtn(techRows[0]).click(); await tick();
  d.getElementById('bie-name').value = '30th Tech Sticker Collection';
  saveBtn().click(); await tick(60);
  const second = rows().find(tr => /Tech Sticker/.test(tr.textContent) && /SUGGESTED/.test(tr.textContent));
  editBtn(second).click(); await tick(60);
  const sel = d.getElementById('bie-merge');
  const opt = [...sel.options].find(o => /30th Tech Sticker Collection/.test(o.textContent));
  check('merge target offered',           !!opt, [...sel.options].map(o => o.textContent).join(' / '));
  sel.value = opt.value; sel.dispatchEvent(new w.Event('change'));
  check('name box locks to target',       d.getElementById('bie-name').disabled && d.getElementById('bie-name').value === '30th Tech Sticker Collection');
  saveBtn().click(); await tick(60);
  const merged = rows().filter(tr => /Tech Sticker/.test(tr.textContent));
  check('one Tech Sticker row after',     merged.length === 1, merged.length);
  check('units combined (2+1)',           merged[0] && merged[0].querySelectorAll('td')[1].textContent.trim() === '3');
  check('both stores shown',              merged[0] && /Target/.test(merged[0].textContent) && /Pokemon Center/.test(merged[0].textContent));

  console.log('\n── Orders-table ✎ (bot-edit-overlay) opens visibly too ──');
  {
    const ov = d.getElementById('bot-edit-overlay');
    check('Order list switch opens the order table', await openOrderList());
    const pencil = d.querySelector('#bot-orders-body button[onclick^="botEditRow("]');
    check('order row has an edit button', !!pencil);
    check('order dialog hidden before click', !isVisible(ov));
    if (pencil) {
      pencil.click(); await tick();
      const ocs = w.getComputedStyle(ov);
      check('order dialog is opaque',     ocs.opacity === '1', `opacity=${ocs.opacity}`);
      check('order dialog accepts clicks', ocs.pointerEvents !== 'none', `pointer-events=${ocs.pointerEvents}`);
      check('order total prefilled',      d.getElementById('bot-edit-total').value !== '', d.getElementById('bot-edit-total').value);
      w.closeBotEdit(); await tick();
      check('order dialog closes',        !isVisible(ov));
    }
  }

  console.log('\n── No dialog uses the invisible style.display pattern ──');
  {
    const offenders = [...html.matchAll(/getElementById\('([\w-]*overlay)'\)\.style\.display\s*=/g)].map(m => m[1]);
    check('every .overlay opens via the open class', offenders.length === 0, [...new Set(offenders)].join(', '));
  }

  console.log('\n── Cancel closes without saving ──');
  d.getElementById('bot-cat-tabs').dataset.active = 'Pokemon';
  await w.loadBotItemView('Pokemon'); await tick();
  const before = calls.length;
  editBtn(rowNamed(/Sylveon/)).click(); await tick();
  [...overlay().querySelectorAll('button')].find(b => b.textContent.trim() === 'Cancel').click(); await tick();
  check('dialog closed',                  !isVisible(overlay()));
  check('nothing saved',                  !calls.slice(before).some(c => c.path.endsWith('/save')));

  console.log('\n── Shipped: every order + tracking under each product ──');
  {
    const statusSel = d.getElementById('bot-filter-status');
    statusSel.value = 'Shipped';
    d.getElementById('bot-cat-tabs').dataset.active = 'Pokemon';
    await w.loadBotItemView('Pokemon'); await tick();
    // Shipped now opens By package; this section covers the product view.
    [...d.querySelectorAll('#bot-view-switch button')].find(b => /By product/.test(b.textContent)).click();
    await tick(60);

    const prod = rowNamed(/Mega Emboar ex/);
    check('Emboar product row present',          !!prod);
    const sub = prod && prod.nextElementSibling;
    check('auto-expanded on Shipped',             !!sub && sub.classList.contains('bot-subrow'));
    // tBodies[0].rows = only this inner table's body rows. (A descendant selector
    // like 'tbody tr' also matches the header, because the PAGE's outer <tbody>
    // counts as an ancestor even though it sits outside `sub`.)
    const inner     = sub && sub.querySelector('table');
    const orderRows = inner ? [...inner.tBodies[0].rows] : [];
    check('header lives in <thead>, not the body', inner && inner.tHead && inner.tHead.rows.length === 1);
    check('one line per order (4)',               orderRows.length === 4, orderRows.length);

    const links = sub ? [...sub.querySelectorAll('a[href]')].map(a => a.getAttribute('href')) : [];
    check('UPS number links to UPS, not Google',  links.some(h => h === 'https://www.ups.com/track?tracknum=1ZAA11110000000001'), links.join(' | '));
    check('no Google fallback for UPS numbers',   !links.some(h => /google\.com/.test(h) && /1Z/.test(h)));
    check('carrier label shown',                  sub && /UPS/.test(sub.textContent));
    check('missing tracking called out',          sub && /1 without tracking yet/.test(sub.textContent));
    check('OFD status shown',                     sub && /OFD/.test(sub.textContent));
    check('expected date shown',                  sub && /Exp Sep 2[5-7]/.test(sub.textContent));
    check('ship-to shown',                        sub && /Acme Market/.test(sub.textContent));
    check('soonest arrival listed first',         orderRows[0] && /S01/.test(orderRows[0].textContent), orderRows[0] && orderRows[0].textContent.trim().slice(0, 40));
    check('tracking count in product line',       /3 tracking/.test(prod.textContent));

    // Copy all tracking numbers
    [...sub.querySelectorAll('button')].find(b => /Copy all tracking/.test(b.textContent)).click();
    await tick();
    const got = (copied.pop() || '').split('\n');
    check('copy all: 3 numbers, one per line',    got.length === 3 && got.includes('1ZAA11110000000001') && got.includes('876543210987'), JSON.stringify(got));

    // Collapse / expand controls
    const bannerBtn = re => [...d.querySelectorAll('#bot-unlinked-banner button')].find(b => re.test(b.textContent));
    bannerBtn(/Collapse all/).click(); await tick();
    check('collapse all hides order lists',       subrows().length === 0);
    rowNamed(/Mega Emboar ex/).querySelector('button.bot-exp').click(); await tick();
    check('chevron opens a single product',       subrows().length === 1);
    await w.loadBotItemView('Pokemon'); await tick();
    check('manual collapse survives a reload',    subrows().length === 1);
    bannerBtn(/Collapse all/).click(); await tick();
    bannerBtn(/Show all orders/).click(); await tick();
    check('show all orders expands every row',    subrows().length === rows().length);

    statusSel.value = '';
  }

  // ── REAL user paths only from here: click cards, fire change events, press
  //    buttons. An earlier version of this test set the dropdown value and then
  //    called loadBotItemView() itself — skipping the very handler that was
  //    broken, so a user-visible bug passed.
  console.log('\n── Status cards drive the product view (real clicks) ──');
  {
    const statusSel = d.getElementById('bot-filter-status');
    statusSel.value = ''; statusSel.dispatchEvent(new w.Event('change'));
    await tick(60);
    const pokeTab = [...d.querySelectorAll('.btab')].find(b => /^Pokemon/.test(b.textContent.trim()));
    check('Pokemon tab button exists', !!pokeTab);
    pokeTab.click(); await tick(80);

    // Shipped opens the package view, Delivered the product view — read the one on screen.
    const pkgOn  = () => d.getElementById('bot-pkg-wrap').style.display !== 'none';
    const names  = () => pkgOn()
      ? [...d.querySelectorAll('#bot-pkg-tbody > tr')].map(r => r.textContent)
      : rows().map(r => r.textContent);
    const has    = re => names().some(t => re.test(t));
    const card   = st => d.getElementById('bsc-' + st);

    check('no filter: shipped AND delivered products listed', has(/Mega Emboar/) && has(/Sylveon ex Box/));

    card('Shipped').click(); await tick(80);
    check('SHIPPED card: shipped product shown',       has(/Mega Emboar/));
    check('SHIPPED card: delivered products hidden',   !has(/Sylveon ex Box/) && !has(/Tech Sticker/), names().map(t => t.trim().slice(0, 30)).join(' | '));
    check('SHIPPED card highlighted',                  card('Shipped').classList.contains('active-filter'));

    card('Delivered').click(); await tick(80);
    check('DELIVERED card: list actually changed',     has(/Sylveon ex Box/) && !has(/Mega Emboar/), names().map(t => t.trim().slice(0, 30)).join(' | '));
    check('DELIVERED highlighted, SHIPPED not',        card('Delivered').classList.contains('active-filter') && !card('Shipped').classList.contains('active-filter'));

    card('Delivered').click(); await tick(80);
    check('clicking again clears the filter',          has(/Mega Emboar/) && has(/Sylveon ex Box/));
    check('no card highlighted after clearing',        !d.querySelector('.bot-stat.active-filter'));

    console.log('\n── Status dropdown (real change event) ──');
    statusSel.value = 'Shipped'; statusSel.dispatchEvent(new w.Event('change')); await tick(80);
    check('dropdown Shipped filters the list',         has(/Mega Emboar/) && !has(/Sylveon ex Box/));
    check('dropdown keeps the card highlight in sync', card('Shipped').classList.contains('active-filter'));
    statusSel.value = ''; statusSel.dispatchEvent(new w.Event('change')); await tick(80);

    console.log('\n── Refresh-style reload updates the product view ──');
    DB.prepare(`INSERT INTO bot_orders (category, retailer, order_number, status, items, order_total)
                VALUES ('Pokemon','Target','NEW1','Delivered',?,21.70)`)
      .run([JSON.stringify(['1x Pokémon Surging Sparks Booster Bundle @ $19.99'])]);
    check('new product not shown before reload',       !has(/Surging Sparks/));
    d.getElementById('bot-reparse-btn').click();       // ends in loadBotOrders(), like Refresh/Scan/Repair
    await tick(200);
    check('appears after Reparse, without switching tabs', has(/Surging Sparks/));
  }

  console.log('\n── Shipped opens the package view (real click) ──');
  {
    const statusSel = d.getElementById('bot-filter-status');
    statusSel.value = ''; statusSel.dispatchEvent(new w.Event('change')); await tick(60);
    [...d.querySelectorAll('.btab')].find(b => /^Pokemon/.test(b.textContent.trim())).click(); await tick(80);
    d.getElementById('bsc-Shipped').click(); await tick(80);

    const pkgRows = () => [...d.querySelectorAll('#bot-pkg-tbody > tr')];
    const pkgRow  = re => pkgRows().find(r => re.test(r.textContent));
    const dbRow   = num => DB.prepare('SELECT status, tracking_status, delivered_date, expected_date FROM bot_orders WHERE order_number=?').get([num]);
    const bar     = () => d.getElementById('bot-pkg-actionbar');
    const undoBar = () => d.getElementById('bot-undo-bar');
    const checkbox = tr => tr.querySelector('input[type=checkbox]');

    check('package view shown on Shipped',          d.getElementById('bot-pkg-wrap').style.display !== 'none');
    check('product table hidden',                   d.getElementById('bot-product-table-wrap').style.display === 'none');
    check('"By package" is the active switch',      /By package/.test(d.querySelector('#bot-view-switch .active').textContent));

    // 4 Emboar orders (3 tracked + 1 not) + 1 multi-item box + 1 shared-tracking pair = 6 packages
    check('6 packages (not one row per product)',   pkgRows().length === 6, pkgRows().length);
    const boxRow = pkgRow(/870000000301/);
    check('multi-item box is ONE row',              pkgRows().filter(r => /870000000301/.test(r.textContent)).length === 1);
    check('box lists all 3 products as tags',       boxRow && boxRow.querySelectorAll('.bot-pkg-tag').length === 3);
    check('ETB ×2 shown',                           boxRow && /PC ETB ×2/.test(boxRow.textContent), boxRow && boxRow.textContent.replace(/\s+/g, ' ').slice(0, 160));

    const flagRow = pkgRow(/870000000302/);
    check('shared tracking = one flagged row',      flagRow && /same tracking, 2 addresses/.test(flagRow.textContent));
    check('both destinations listed',               flagRow && /Alex Rivera/.test(flagRow.textContent) && /Bea Tran/.test(flagRow.textContent));
    check('banner warns about it',                  /1 package need/.test(d.getElementById('bot-unlinked-banner').textContent));
    check('no-tracking order has its own row',      !!pkgRow(/no tracking yet/));

    console.log('\n── Select all skips the flagged package ──');
    const all = d.getElementById('bot-pkg-all');
    all.click(); await tick();
    check('select all → 5 selected',               /5 packages selected/.test(bar().textContent), bar().textContent.replace(/\s+/g, ' ').trim().slice(0, 80));
    check('flagged package NOT selected',           !checkbox(pkgRow(/870000000302/)).checked);
    check('action bar visible',                     bar().style.display === 'flex');
    check('date defaults to today',                 d.getElementById('bot-pkg-date').value === w.botLocalToday());
    all.click(); await tick();
    check('unselect all → bar hidden',              bar().style.display === 'none');

    console.log('\n── Flagged package can still be picked deliberately ──');
    checkbox(pkgRow(/870000000302/)).click(); await tick();
    check('bar warns it includes a flagged one',    /includes 1 flagged/.test(bar().textContent));
    check('counts both orders in that box',         /\(2 orders\)/.test(bar().textContent));
    [...bar().querySelectorAll('button')].find(b => /Clear/.test(b.textContent)).click(); await tick();

    console.log('\n── Mark 2 packages delivered on a chosen date ──');
    checkbox(pkgRow(/1ZAA11110000000002/)).click(); await tick();   // S02
    checkbox(pkgRow(/870000000301/)).click(); await tick();          // the box
    check('2 selected',                             /2 packages selected/.test(bar().textContent));
    d.getElementById('bot-pkg-date').value = '2026-09-20';
    const shippedBefore = Number(d.getElementById('bs-shipped').textContent);
    d.getElementById('bot-pkg-mark').click(); await tick(150);

    const s2 = dbRow('S02'), bx = dbRow('P0099000001');
    check('S02 now Delivered',                      s2.status === 'Delivered' && s2.tracking_status === 'Delivered');
    check('box order now Delivered',                bx.status === 'Delivered');
    check('recorded as set by hand (survives Repair)', DB.prepare("SELECT status_source FROM bot_orders WHERE order_number='S02'").get().status_source === 'manual');
    check('uses the chosen date, not today',        s2.delivered_date === '2026-09-20' && bx.delivered_date === '2026-09-20', `${s2.delivered_date} / ${bx.delivered_date}`);
    check('other packages untouched',               dbRow('S01').status === 'Shipped' && dbRow('P0099000002').status === 'Shipped');
    check('they left the Shipped list',             pkgRows().length === 4 && !pkgRow(/870000000301/), pkgRows().length);
    const shippedAfter = Number(d.getElementById('bs-shipped').textContent);
    check('SHIPPED card dropped by 2 orders',       shippedBefore - shippedAfter === 2, `${shippedBefore} → ${shippedAfter}`);
    check('undo bar shown',                         undoBar().style.display === 'flex' && /2 packages marked delivered on Sep 20/.test(undoBar().textContent), undoBar().textContent.trim());

    console.log('\n── Undo restores everything exactly ──');
    d.getElementById('bot-undo-btn').click(); await tick(150);
    const s2b = dbRow('S02'), bxb = dbRow('P0099000001');
    check('S02 back to Shipped',                    s2b.status === 'Shipped');
    check('tracking_status restored',               s2b.tracking_status === null);
    check('status source restored too',             DB.prepare("SELECT status_source FROM bot_orders WHERE order_number='S02'").get().status_source === null);
    check('delivered_date cleared again',           s2b.delivered_date === null && bxb.delivered_date === null);
    check('expected date restored',                 s2b.expected_date === '2026-09-27' && bxb.expected_date === '2026-09-29', `${s2b.expected_date} / ${bxb.expected_date}`);
    check('packages back in the list',              pkgRows().length === 6, pkgRows().length);
    check('undo bar gone',                          undoBar().style.display === 'none');

    console.log('\n── Fix a wrong tracking number from the package view ──');
    {
      const flagged = pkgRow(/870000000302/);
      const pen = [...flagged.querySelectorAll('button.bot-pkg-edit')]
        .find(b => /P0099000002/.test(b.closest('div').textContent));
      check('✎ shown next to each order in the box',   flagged.querySelectorAll('button.bot-pkg-edit').length === 2);
      check('flag says how to fix it',                  /fix with ✎/.test(flagged.textContent));
      pen.click(); await tick(40);
      const ov = d.getElementById('bot-edit-overlay');
      const ocs = w.getComputedStyle(ov);
      check('order editor opens visibly',              ov.classList.contains('open') && ocs.opacity === '1' && ocs.pointerEvents !== 'none');
      check('it is the right order',                   /P0099000002/.test(d.getElementById('bot-edit-ordnum').textContent));
      check('shows the wrong number',                  d.getElementById('bot-edit-tracking').value === '870000000302');
      d.getElementById('bot-edit-tracking').value = '870000000303';
      ov.querySelector('button[onclick="saveBotEdit()"]').click(); await tick(150);

      check('saved to the database',                   dbRow('P0099000002') && DB.prepare("SELECT tracking FROM bot_orders WHERE order_number='P0099000002'").get().tracking === '870000000303');
      check('other order untouched',                   DB.prepare("SELECT tracking FROM bot_orders WHERE order_number='P0099000003'").get().tracking === '870000000302');
      check('dialog closed',                           !ov.classList.contains('open'));
      check('flagged row gone — now 2 separate boxes', !pkgRows().some(r => /same tracking/.test(r.textContent)) && !!pkgRow(/870000000303/) && !!pkgRow(/870000000302/));
      check('7 packages now',                          pkgRows().length === 7, pkgRows().length);
      check('warning banner cleared',                  !/need checking/.test(d.getElementById('bot-unlinked-banner').textContent));
    }

    console.log('\n── View switch ──');
    d.getElementById('bsc-Delivered').click(); await tick(80);
    check('Delivered defaults to By product',       d.getElementById('bot-pkg-wrap').style.display === 'none');
    [...d.querySelectorAll('#bot-view-switch button')].find(b => /By package/.test(b.textContent)).click(); await tick(80);
    check('can switch Delivered to By package',     d.getElementById('bot-pkg-wrap').style.display !== 'none');
    check('delivered packages not selectable',      [...d.querySelectorAll('#bot-pkg-tbody input[type=checkbox]')].every(c => c.disabled));
    d.getElementById('bsc-Delivered').click(); await tick(80);   // clear filter
  }

  console.log('\n── Finder fee raises landed cost (real typing) ──');
  {
    const statusSel = d.getElementById('bot-filter-status');
    statusSel.value = ''; statusSel.dispatchEvent(new w.Event('change')); await tick(60);
    [...d.querySelectorAll('.btab')].find(b => /^Pokemon/.test(b.textContent.trim())).click(); await tick(80);
    const sy   = () => rowNamed(/Sylveon ex Box/);
    const cell = i => sy().querySelectorAll(':scope > td')[i];
    check('product view shown', !!sy());
    check('landed before fee is $32.55', /\$32\.55/.test(cell(2).textContent), cell(2).textContent.trim());

    const fee = cell(3).querySelector('input');
    const feesBefore = cardMoney('bs-fees');
    fee.value = '8'; fee.dispatchEvent(new w.Event('change')); await tick(100);
    check('FINDER FEES card +$32 (4 units × $8)', Math.round((cardMoney('bs-fees') - feesBefore) * 100) / 100 === 32, `${feesBefore} → ${cardMoney('bs-fees')}`);
    check('landed now $40.55 (+$8)',     /\$40\.55/.test(cell(2).textContent), cell(2).textContent.trim());
    const saved = DB.prepare("SELECT buyer_fee FROM bot_sku_prices WHERE sku LIKE '#p%' AND buyer_fee>0").get();
    check('fee saved',                   saved && saved.buyer_fee === 8);
    cell(2).querySelector('span').click(); await tick();
    const pop = d.getElementById('landed-popover');
    check('breakdown shows Finder fee $8.00', pop && /Finder fee\s*\$8\.00/.test(pop.textContent.replace(/\s+/g, ' ')), pop && pop.textContent.replace(/\s+/g, ' ').trim());
    pop && pop.remove();

    const ask = cell(4).querySelector('input');
    ask.value = '50'; ask.dispatchEvent(new w.Event('change')); await tick(60);
    check('profit/unit = asking − landed (fee not taken twice)', /\+\$9\.45/.test(cell(6).textContent), cell(6).textContent.trim());
    // Reload from the server: same numbers, not just the optimistic update.
    await w.loadBotItemView('Pokemon'); await tick();
    check('after reload: landed still $40.55', /\$40\.55/.test(cell(2).textContent));

    console.log('\n── Record sales in parts (real clicks) ──');
    const ov   = d.getElementById('bot-sale-overlay');
    check('sale dialog hidden before click', !isVisible(ov));
    check('SOLD starts at 0/4',              cell(5).textContent.trim() === '0/4', cell(5).textContent.trim());
    sy().querySelector('button[title="Record a sale"]').click(); await tick();
    check('$ opens a VISIBLE dialog',         isVisible(ov));
    check('qty defaults to 1',                d.getElementById('bs-qty').value === '1');
    check('price defaults to asking',         d.getElementById('bs-price').value === '50');
    check('date defaults to today',           d.getElementById('bs-date').value === w.botLocalToday());
    check('history empty',                    /None yet/.test(d.getElementById('bs-history').textContent));

    const bsSave = d.getElementById('bs-save');
    const set = (id, v) => { const el = d.getElementById(id); el.value = v; el.dispatchEvent(new w.Event('input')); };

    // Guard: 0 is rejected client-side, nothing sent.
    const nBefore = calls.filter(c => c.path === '/api/admin/bot-sales').length;
    set('bs-qty', '0'); bsSave.click(); await tick(40);
    check('qty 0 → error, nothing saved',     d.getElementById('bs-error').style.display !== 'none' && calls.filter(c => c.path === '/api/admin/bot-sales').length === nBefore);

    set('bs-qty', '2');
    check('preview shows the profit',         /\+\$18\.90/.test(d.getElementById('bs-preview').textContent), d.getElementById('bs-preview').textContent.replace(/\s+/g, ' ').trim());
    bsSave.click(); await tick(120);
    check('sale 1 stored',                    DB.prepare('SELECT COUNT(*) n FROM bot_sales').get().n === 1);
    check('SOLD 2/4 on the row',              cell(5).textContent.trim() === '2/4', cell(5).textContent.trim());
    await tick(80);
    check('SALES PROFIT card +$18.90',        cardMoney('bs-profit') === 18.9, d.getElementById('bs-profit').textContent);

    // WHEN filter: sold today counts under Today; move the sale to an old date → gone.
    const rangeBtn = t => [...d.querySelectorAll('.drange')].find(b => b.textContent.trim() === t);
    rangeBtn('Today').click(); await tick(60);
    check('Today: sale counted',              cardMoney('bs-profit') === 18.9, d.getElementById('bs-profit').textContent);
    DB.prepare("UPDATE bot_sales SET sold_at='2025-01-01'").run();
    await w.botLoadMoney(); await tick(40);
    check('Today: old sale not counted',      cardMoney('bs-profit') === 0 && /no sales yet/.test(d.getElementById('bs-profit-sub').textContent), d.getElementById('bs-profit').textContent);
    rangeBtn('All time').click(); await tick(60);
    check('All time: counted again',          cardMoney('bs-profit') === 18.9);
    DB.prepare('UPDATE bot_sales SET sold_at=?').run([w.botLocalToday()]);
    await w.botLoadMoney(); await tick(40);
    check('dialog stays open for the next',   isVisible(ov));
    check('history lists it',                 d.querySelectorAll('#bs-history .bs-sale').length === 1);

    set('bs-qty', '1'); set('bs-price', '55'); set('bs-fees', '4');
    d.getElementById('bs-channel').value = 'eBay';
    bsSave.click(); await tick(120);
    const r2 = DB.prepare('SELECT * FROM bot_sales ORDER BY id DESC').get();
    check('sale 2 stored as typed',           r2.qty === 1 && r2.unit_price === 55 && r2.fees === 4 && r2.channel === 'eBay');
    check('SOLD 3/4',                         cell(5).textContent.trim() === '3/4', cell(5).textContent.trim());
    // 2×50 + 55 − 4 − 3 × 40.55
    check('realized profit +$29.35 shown',    /\+\$29\.35 made/.test(cell(6).textContent), cell(6).textContent.replace(/\s+/g, ' ').trim());
    check('ROI next to it: 24%',              /29\.35 made · 24% ROI/.test(cell(6).textContent.replace(/\s+/g, ' ')), cell(6).textContent.replace(/\s+/g, ' ').trim());
    check('ROI at asking price: 23%',         /\+\$9\.45\/u\s*23%/.test(cell(6).textContent.replace(/\s+/g, ' ')), cell(6).textContent.replace(/\s+/g, ' ').trim());
    await tick(80);
    check('card: +$29.35 profit',             cardMoney('bs-profit') === 29.35, d.getElementById('bs-profit').textContent);
    check('card: 3 sold · $155.00 in · ROI 24%', /3 sold · \$155\.00 in · ROI 24%/.test(d.getElementById('bs-profit-sub').textContent), d.getElementById('bs-profit-sub').textContent);
    check('history lists both',               d.querySelectorAll('#bs-history .bs-sale').length === 2);

    set('bs-qty', '5');
    check('overselling warns (1 left)',       /Only 1 left/.test(d.getElementById('bs-preview').textContent));

    // Delete the newest (qty 1) from history.
    d.querySelector('#bs-history .bs-sale .bs-del').click(); await tick(120);
    check('deleted from the database',        DB.prepare('SELECT COUNT(*) n FROM bot_sales').get().n === 1);
    check('SOLD back to 2/4',                 cell(5).textContent.trim() === '2/4', cell(5).textContent.trim());
    await tick(80);
    check('card back to +$18.90 after delete', cardMoney('bs-profit') === 18.9, d.getElementById('bs-profit').textContent);

    w.closeBotSale(); await tick();
    check('dialog closes',                    !isVisible(ov));
    cell(5).querySelector('button').click(); await tick();
    check('clicking SOLD opens it too',       isVisible(ov));
    w.closeBotSale(); await tick();

    // Server-side validation, straight at the real handler.
    const bad = await fakeFetch('/api/admin/bot-sales', { method: 'POST', body: JSON.stringify({ sku_key: 'x', qty: 1.5, unit_price: 10 }) });
    check('server rejects fractional qty',    bad.status === 400);
    const bad2 = await fakeFetch('/api/admin/bot-sales', { method: 'POST', body: JSON.stringify({ qty: 1, unit_price: 10 }) });
    check('server rejects missing product',   bad2.status === 400);
  }

  console.log('\n── All tab: products from every category, sellable ──');
  {
    const statusSel = d.getElementById('bot-filter-status');
    statusSel.value = ''; statusSel.dispatchEvent(new w.Event('change')); await tick(60);
    await openOrderList();   // the earlier sections left All on the order list — that choice sticks
    [...d.querySelectorAll('#bot-orders-back button')].find(b => /By product/.test(b.textContent)).click(); await tick(80);
    check('All shows the product table',      d.getElementById('bot-item-view').style.display === 'block' && d.getElementById('bot-orders-wrap').style.display === 'none');
    check('Pokemon product listed',           !!rowNamed(/Sylveon ex Box/));
    check('Mattel product listed',            !!rowNamed(/Hot Wheels Test Car Set/));
    check('uncategorised order listed',       !!rowNamed(/Sample Card Sleeves/));

    const hw = () => rowNamed(/Hot Wheels Test Car Set/);
    hw().querySelector('button[title="Record a sale"]').click(); await tick();
    const ov = d.getElementById('bot-sale-overlay');
    check('Record sale opens for a Mattel item', isVisible(ov));
    d.getElementById('bs-qty').value = '1'; d.getElementById('bs-price').value = '45';
    d.getElementById('bs-save').click(); await tick(120);
    check('Mattel sale saved',                DB.prepare("SELECT COUNT(*) n FROM bot_sales WHERE product_name LIKE '%Hot Wheels%'").get().n === 1);
    check('SOLD 1/1 on the All tab',          hw().querySelectorAll(':scope > td')[5].textContent.trim() === '1/1');
    w.closeBotSale(); await tick();

    // Same sale shows on the Mattel tab — one set of sales, whichever tab.
    [...d.querySelectorAll('.btab')].find(b => /^Mattel/.test(b.textContent.trim())).click(); await tick(80);
    check('Mattel tab shows the same sale',   hw() && hw().querySelectorAll(':scope > td')[5].textContent.trim() === '1/1');
    check('Mattel tab has no Pokemon rows',   !rowNamed(/Sylveon ex Box/));
    const otherTab = [...d.querySelectorAll('.btab')].find(b => /^Other/.test(b.textContent.trim()));
    check('Other tab exists for the uncategorised order', !!otherTab);
    if (otherTab) { otherTab.click(); await tick(80); }
    check('Other tab lists the no-category order', !!rowNamed(/Sample Card Sleeves/));

    console.log('\n── Order list and back ──');
    check('switch to Order list',             await openOrderList());
    check('back bar shown on order list',     d.getElementById('bot-orders-back').style.display === 'flex');
    [...d.querySelectorAll('#bot-orders-back button')].find(b => /By product/.test(b.textContent)).click(); await tick(80);
    check('By product returns to products',   d.getElementById('bot-item-view').style.display === 'block' && !!rowNamed(/Hot Wheels/));
    check('back bar hidden again',            d.getElementById('bot-orders-back').style.display === 'none');
    [...d.querySelectorAll('.btab')].find(b => /^Pokemon/.test(b.textContent.trim())).click(); await tick(80);
    check('no Order list switch on category tabs', ![...d.querySelectorAll('#bot-view-switch button')].some(b => /Order list/.test(b.textContent)));
  }

  console.log('\n── Box fee: one fee for the whole box, split by retail (real clicks) ──');
  {
    const statusSel = d.getElementById('bot-filter-status');
    statusSel.value = ''; statusSel.dispatchEvent(new w.Event('change')); await tick(60);
    [...d.querySelectorAll('.btab')].find(b => /^One Piece/.test(b.textContent.trim())).click(); await tick(80);
    [...d.querySelectorAll('#bot-view-switch button')].find(b => /By package/.test(b.textContent)).click(); await tick(80);
    const box = () => [...d.querySelectorAll('#bot-pkg-tbody > tr')].find(r => /870000000401/.test(r.textContent));
    check('two orders = one box row',          !!box() && /F01/.test(box().textContent) && /F02/.test(box().textContent));
    const feeBtn = () => box().querySelector('button.bot-pkg-fee');
    check('box shows "+ Fee" before any fee',  feeBtn() && /\+ Fee/.test(feeBtn().textContent));

    feeBtn().click(); await tick();
    const ov = d.getElementById('bot-fee-overlay');
    check('Fee opens a VISIBLE dialog',        isVisible(ov));
    const feeIn = d.getElementById('bf-fee');
    feeIn.value = '100'; feeIn.dispatchEvent(new w.Event('input')); await tick(350);
    const rate = d.getElementById('bf-rate').textContent;
    check('shows box retail and rate',         /\$260\.00/.test(rate) && /38\.5%/.test(rate), rate.trim());
    const line = re => [...d.querySelectorAll('#bf-items tr.bf-item')].find(tr => re.test(tr.textContent));
    check('Deck Box: $46.16, $23.08/unit',     line(/Deck Box/) && /\$46\.16/.test(line(/Deck Box/).textContent) && /\$23\.08/.test(line(/Deck Box/).textContent), line(/Deck Box/) && line(/Deck Box/).textContent.replace(/\s+/g, ' '));
    check('Bundle: $15.38/unit',               line(/Bundle/) && /\$15\.38/.test(line(/Bundle/).textContent));
    check('per-order split listed',            /F01 \$53\.85/.test(d.getElementById('bf-items').textContent) && /F02 \$46\.15/.test(d.getElementById('bf-items').textContent));
    const ff = n => DB.prepare('SELECT finder_fee FROM bot_orders WHERE order_number=?').get([n]).finder_fee;
    check('preview saved nothing',             !ff('F01') && !ff('F02'));

    const feesBefore = cardMoney('bs-fees');
    d.getElementById('bf-save').click(); await tick(150);
    check('FINDER FEES card +$100',            Math.round((cardMoney('bs-fees') - feesBefore) * 100) / 100 === 100, `${feesBefore} → ${cardMoney('bs-fees')}`);
    check('saved per order',                   ff('F01') === 53.85 && ff('F02') === 46.15, `${ff('F01')} / ${ff('F02')}`);
    check('dialog closed',                     !isVisible(ov));
    check('box now shows $100.00',             /\$100\.00/.test(feeBtn().textContent), feeBtn().textContent.trim());

    [...d.querySelectorAll('#bot-view-switch button')].find(b => /By product/.test(b.textContent)).click(); await tick(80);
    const deck = rowNamed(/Test Deck Box/);
    check('Deck Box landed = $60 + $23.08',    deck && /\$83\.08/.test(deck.querySelectorAll(':scope > td')[2].textContent), deck && deck.querySelectorAll(':scope > td')[2].textContent.trim());
    const feeCell = deck && deck.querySelectorAll(':scope > td')[3];
    check('FEE / UNIT shows the box share $23.08', feeCell && /\$23\.08/.test(feeCell.querySelector('.fee-total').textContent) && /box \$23\.08/.test(feeCell.textContent), feeCell && feeCell.textContent.replace(/\s+/g, ' ').trim());
    check('input left for an extra fee',       feeCell && feeCell.querySelector('input').value === '' && feeCell.querySelector('input').placeholder === '+ extra');

    // Change it back to nothing.
    [...d.querySelectorAll('#bot-view-switch button')].find(b => /By package/.test(b.textContent)).click(); await tick(80);
    feeBtn().click(); await tick();
    check('dialog prefilled with $100',        d.getElementById('bf-fee').value === '100');
    d.getElementById('bf-fee').value = ''; d.getElementById('bf-save').click(); await tick(150);
    check('clearing sets both orders to 0',    ff('F01') === 0 && ff('F02') === 0);
    await tick(60);
    check('FINDER FEES card back down',        Math.round((cardMoney('bs-fees') - feesBefore) * 100) / 100 === 0, `${feesBefore} → ${cardMoney('bs-fees')}`);
    check('box back to "+ Fee"',               /\+ Fee/.test(feeBtn().textContent));

    // A filter can hide part of a box; the fee must still cover the whole box.
    const f01 = DB.prepare("SELECT id FROM bot_orders WHERE order_number='F01'").get().id;
    const part = await (await fakeFetch('/api/admin/bot-packages/fee', { method: 'POST', body: JSON.stringify({ orderIds: [f01], fee: 100, dryRun: true }) })).json();
    check('one order sent → whole box split',  part && part.orders.length === 2 && part.retail === 260, part && JSON.stringify(part.orders));

    const bad = await fakeFetch('/api/admin/bot-packages/fee', { method: 'POST', body: JSON.stringify({ orderIds: [], fee: 5 }) });
    check('server rejects empty box',          bad.status === 400);
    const neg = await fakeFetch('/api/admin/bot-packages/fee', { method: 'POST', body: JSON.stringify({ orderIds: [1], fee: -5 }) });
    check('server rejects a negative fee',     neg.status === 400);
  }

  console.log('\n── Fee on one order → offered to the same orders (real clicks) ──');
  {
    const ffee = n => DB.prepare('SELECT finder_fee FROM bot_orders WHERE order_number=?').get([n]).finder_fee;
    [...d.querySelectorAll('.btab')].find(b => /^Mattel/.test(b.textContent.trim())).click(); await tick(80);
    [...d.querySelectorAll('#bot-view-switch button')].find(b => /By package/.test(b.textContent)).click(); await tick(80);
    const pkg = num => [...d.querySelectorAll('#bot-pkg-tbody > tr')].find(r => new RegExp(num).test(r.textContent));
    pkg('D01').querySelector('button.bot-pkg-fee').click(); await tick();
    const fee = d.getElementById('bf-fee');
    fee.value = '35'; fee.dispatchEvent(new w.Event('input'));
    d.getElementById('bf-save').click(); await tick(200);

    const ov = d.getElementById('bot-fee-overlay');
    check('D01 saved at $35',                    ffee('D01') === 35);
    check('dialog stays open with matches',      isVisible(ov) && d.getElementById('bf-similar').style.display === 'block');
    const listed = [...d.querySelectorAll('#bf-sim-list .bf-sim')].map(l => l.textContent.replace(/\s+/g, ' ').trim());
    check('lists D02, D03, D04 only',            listed.length === 3 && ['D02', 'D03', 'D04'].every(n => listed.some(t => t.includes(n))), JSON.stringify(listed));
    check('not: other qty / store / cancelled',  !listed.some(t => /D05|D06|D07/.test(t)));
    const box = n => [...d.querySelectorAll('#bf-sim-list .bf-sim')].find(l => l.textContent.includes(n)).querySelector('input');
    check('same orders pre-checked',             box('D02').checked && box('D03').checked);
    check('order with its own fee NOT checked',  !box('D04').checked && /has \$20\.00/.test(listed.find(t => t.includes('D04'))));
    const apply = d.getElementById('bf-sim-apply');
    check('button says "Apply $35.00 to 2 orders"', /Apply \$35\.00 to 2 orders/.test(apply.textContent), apply.textContent);

    box('D03').click(); await tick();
    check('unchecking updates the count',        /to 1 order$/.test(apply.textContent.trim()), apply.textContent);
    box('D03').click(); await tick();
    apply.click(); await tick(200);
    check('applied to D02 and D03',              ffee('D02') === 35 && ffee('D03') === 35);
    check('D04 kept its own $20',                ffee('D04') === 20);
    check('near-misses untouched',               ffee('D05') === 0 && ffee('D06') === 0 && ffee('D07') === 0);
    check('dialog closed',                       !isVisible(ov));
    check('rows now show $35.00',                ['D01', 'D02', 'D03'].every(n => /\$35\.00/.test(pkg(n).querySelector('button.bot-pkg-fee').textContent)));

    // Next time, the ones already at $35 aren't offered again; only D04 is left.
    pkg('D02').querySelector('button.bot-pkg-fee').click(); await tick();
    d.getElementById('bf-save').click(); await tick(200);
    const again = [...d.querySelectorAll('#bf-sim-list .bf-sim')].map(l => l.textContent);
    check('already-$35 orders not offered again', again.length === 1 && /D04/.test(again[0]), JSON.stringify(again));
    [...ov.querySelectorAll('button')].find(b => b.textContent.trim() === 'Skip').click(); await tick(100);
    check('Skip closes without changing D04',    !isVisible(ov) && ffee('D04') === 20);
  }

  console.log('\n── Delivered-but-listed-as-Shipped gets fixed (real clicks) ──');
  {
    // The reported state: status Shipped, tracking says Delivered, with a date.
    DB.prepare(`INSERT INTO bot_orders (category, retailer, order_number, status, tracking, tracking_status, delivered_date, items, order_total)
                VALUES ('Pokemon','Pokemon Center','X01','Shipped','870000000601','Delivered','2026-09-27',?,20)`)
      .run([JSON.stringify(['1x Test Stuck Pack @ $20.00'])]);
    const statusSel = d.getElementById('bot-filter-status');
    [...d.querySelectorAll('.btab')].find(b => /^Pokemon/.test(b.textContent.trim())).click(); await tick(80);
    statusSel.value = 'Shipped'; statusSel.dispatchEvent(new w.Event('change')); await tick(80);
    const inShipped = () => [...d.querySelectorAll('#bot-pkg-tbody > tr')].some(r => /870000000601/.test(r.textContent));
    check('stuck order shows in Shipped (the bug)', inShipped());
    d.getElementById('bot-reparse-btn').click(); await tick(250);
    check('after Reparse: gone from Shipped',     !inShipped());
    check('status now Delivered',                 DB.prepare("SELECT status FROM bot_orders WHERE order_number='X01'").get().status === 'Delivered');
    statusSel.value = 'Delivered'; statusSel.dispatchEvent(new w.Event('change')); await tick(80);
    check('listed under Delivered',               !!rowNamed(/Test Stuck Pack/));
    statusSel.value = ''; statusSel.dispatchEvent(new w.Event('change')); await tick(60);
  }

  console.log('\n── Backup → data check round trip ──');
  {
    const r = await fakeFetch('/api/admin/backup', { method: 'GET' });
    const buf = await r.json();                       // fake res captures what res.send() got
    check('backup returns a file',             r.status === 200 && Buffer.isBuffer(buf) && buf.length > 1000, r.status);
    check('it is an SQLite database',          Buffer.isBuffer(buf) && buf.slice(0, 15).toString() === 'SQLite format 3');
    const f = path.join(require('os').tmpdir(), `ui-backup-${process.pid}.db`);
    fs.writeFileSync(f, buf);
    const { checkData, openDb } = require(path.join(__dirname, '..', 'tools', 'check-data.js'));
    const res = checkData(openDb(f));
    check('check reads every order',           res.summary.orders === DB.prepare('SELECT COUNT(*) n FROM bot_orders').get().n, res.summary.orders);
    check('check counts every sale',           res.summary.sales === DB.prepare('SELECT COUNT(*) n FROM bot_sales').get().n);
    const money = await (await fakeFetch('/api/admin/bot-money', { method: 'GET' })).json();
    const cardFees = Math.round(money.orderFees.reduce((a, x) => a + x.fee, 0) * 100) / 100;
    check('fee total = FINDER FEES card (all time)', res.summary.finderFees === cardFees, `${res.summary.finderFees} vs ${cardFees}`);
    const cardProfit = Math.round(money.sales.reduce((a, x) => a + x.profit, 0) * 100) / 100;
    check('profit = SALES PROFIT card (all time)',   res.summary.salesProfit === cardProfit, `${res.summary.salesProfit} vs ${cardProfit}`);
    check('Backup button on the page',         !!d.getElementById('bot-backup-btn'));
    fs.rmSync(f, { force: true });
  }

  console.log('\n── Guard: the same fee can\'t silently be entered twice ──');
  {
    const statusSel = d.getElementById('bot-filter-status');
    statusSel.value = ''; statusSel.dispatchEvent(new w.Event('change')); await tick(60);
    [...d.querySelectorAll('.btab')].find(b => /^Mattel/.test(b.textContent.trim())).click(); await tick(80);
    [...d.querySelectorAll('#bot-view-switch button')].find(b => /By product/.test(b.textContent)).click(); await tick(80);
    const drop = () => rowNamed(/Test Drop Car/);
    const feeIn = () => drop().querySelectorAll(':scope > td')[3].querySelector('input');
    const typed = () => { const r = DB.prepare("SELECT buyer_fee FROM bot_sku_prices WHERE sku IN (SELECT '#p'||product_id FROM sku_aliases WHERE raw_name LIKE '%Test Drop Car%') OR sku LIKE '%Test Drop Car%'").all(); return r.reduce((a, x) => a + (x.buyer_fee || 0), 0); };
    const boxShare = (drop().querySelectorAll(':scope > td')[3].textContent.match(/box \$([\d.]+)/) || [])[1];
    check('drop product shows its order-fee share', !!boxShare && +boxShare > 0, drop().querySelectorAll(':scope > td')[3].textContent.replace(/\s+/g, ' ').trim());
    const landedBefore = drop().querySelectorAll(':scope > td')[2].textContent.trim();

    // Typing the same fee again → asked; Cancel → nothing saved.
    let n = confirms.length; confirmAnswer = false;
    feeIn().value = boxShare; feeIn().dispatchEvent(new w.Event('change')); await tick(100);
    check('asked before adding on top',        confirms.length === n + 1 && confirms[n].includes(`already has a fee from its orders: $${boxShare} per unit`), confirms[n]);
    check('says what the total would be',      (confirms[n] || '').includes(`Total would be $${(2 * boxShare).toFixed(2)} per unit`), confirms[n]);
    check('Cancel → not saved',                typed() === 0, typed());
    check('Cancel → input cleared again',      feeIn().value === '');
    check('landed unchanged',                  drop().querySelectorAll(':scope > td')[2].textContent.trim() === landedBefore, drop().querySelectorAll(':scope > td')[2].textContent.trim());

    // A genuinely separate fee → OK → saved.
    n = confirms.length; confirmAnswer = true;
    feeIn().value = '3'; feeIn().dispatchEvent(new w.Event('change')); await tick(100);
    check('OK → saved as extra',               typed() === 3 && confirms.length === n + 1, typed());

    // Product with no order fee: no question asked.
    const hw = rowNamed(/Hot Wheels Test Car Set/);
    n = confirms.length;
    const hwIn = hw.querySelectorAll(':scope > td')[3].querySelector('input');
    hwIn.value = '1'; hwIn.dispatchEvent(new w.Event('change')); await tick(100);
    check('no order fee → no question',        confirms.length === n);
    hwIn.value = ''; hwIn.dispatchEvent(new w.Event('change')); await tick(100);

    // Product editor dialog has the same guard.
    editBtn(drop()).click(); await tick(60);
    d.getElementById('bie-buyer-fee').value = '9';
    n = confirms.length; confirmAnswer = false;
    [...overlay().querySelectorAll('button')].find(b => /Save/.test(b.textContent)).click(); await tick(100);
    check('editor asks too; Cancel keeps $3',  confirms.length === n + 1 && typed() === 3 && isVisible(overlay()), typed());
    w.closeBotItemEdit(); await tick();
    confirmAnswer = true;

    // Other direction: box fee on an order whose product has a typed per-unit fee.
    [...d.querySelectorAll('#bot-view-switch button')].find(b => /By package/.test(b.textContent)).click(); await tick(80);
    const pkg = num => [...d.querySelectorAll('#bot-pkg-tbody > tr')].find(r => new RegExp(num).test(r.textContent));
    pkg('D05').querySelector('button.bot-pkg-fee').click(); await tick();
    const bf = d.getElementById('bf-fee');
    bf.value = '20'; bf.dispatchEvent(new w.Event('input')); await tick(350);
    const warn = d.getElementById('bf-double');
    check('box dialog warns about the typed fee', warn.style.display !== 'none' && /Test Drop Car/.test(warn.textContent) && /\$3\.00\/unit/.test(warn.textContent), warn.textContent.trim());
    const ffee = num => DB.prepare('SELECT finder_fee FROM bot_orders WHERE order_number=?').get([num]).finder_fee;
    n = confirms.length; confirmAnswer = false;
    d.getElementById('bf-save').click(); await tick(150);
    check('Cancel → box fee not saved',        confirms.length === n + 1 && ffee('D05') === 0, ffee('D05'));
    confirmAnswer = true;
    d.getElementById('bf-save').click(); await tick(200);
    check('OK → box fee saved',                ffee('D05') === 20, ffee('D05'));
    if (isVisible(d.getElementById('bot-fee-overlay'))) { w.closeBoxFee(); await tick(); }

    // D06 is another store but the SAME product (same typed fee) → warned too.
    pkg('D06').querySelector('button.bot-pkg-fee').click(); await tick();
    bf.value = '5'; bf.dispatchEvent(new w.Event('input')); await tick(350);
    check('same product in another store: warned', d.getElementById('bf-double').style.display !== 'none');
    w.closeBoxFee(); await tick();
    // A box whose products have no typed fee: no warning.
    pkg('M01').querySelector('button.bot-pkg-fee').click(); await tick();
    bf.value = '5'; bf.dispatchEvent(new w.Event('input')); await tick(350);
    check('no typed fee in the box → no warning', d.getElementById('bf-double').style.display === 'none');
    w.closeBoxFee(); await tick();
  }

  console.log('\n── Orders table tracking links use the right carrier too ──');
  {
    await openOrderList();
    const a = [...d.querySelectorAll('#bot-orders-body a[href]')].find(x => /1ZAA11110000000001/.test(x.textContent));
    check('orders table: UPS link goes to UPS', a && a.getAttribute('href').startsWith('https://www.ups.com/track'), a && a.getAttribute('href'));
  }

  console.log('\n── Page and carriers.js agree on every carrier ──');
  {
    const C = require(path.join(__dirname, '..', 'carriers.js'));
    const samples = ['1ZAA11110000000001', '1zaa11110000000006', '876543210987', '9400111899223856925683',
                     '9261290100130623456789', 'EA123456789US', '123456789012', '961234567890123456789012',
                     'TBA123456789012', 'C12345678901234', 'garbage', ''];
    const mismatch = samples.filter(t =>
      (w.botCarrierOf(t) || null) !== (C.carrierOf(t) || null) ||
      (t && w.botTrackingUrl('Target', t) !== C.trackingUrl(t)));
    check(`${samples.length} sample numbers agree`, mismatch.length === 0, mismatch.join(', '));
  }

  console.log(`\n${'─'.repeat(60)}`);
  console.log(`${passed} passed, ${failed} failed`);
  dom.window.close();
  process.exit(failed ? 1 : 0);
})().catch(e => { console.log('  ❌ test crashed —', e.stack); process.exit(1); });
