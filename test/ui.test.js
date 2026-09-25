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
// server.js really boots, so it really imports bot_orders_import.json. Clear it
// so assertions below depend only on the orders seeded here.
DB.prepare('DELETE FROM bot_orders').run();
for (const [num, retailer, items, total] of seed) {
  DB.prepare(`INSERT INTO bot_orders (category, retailer, order_number, status, items, order_total)
              VALUES ('Pokemon', ?, ?, 'Delivered', ?, ?)`).run([retailer, num, items, total]);
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
    w.confirm = () => true;
    w.alert   = m => { alerts.push(String(m)); };
  },
});
const alerts = [];
const w = dom.window, d = w.document;
const tick = (n = 25) => new Promise(r => realSetTimeout(r, n));

let passed = 0, failed = 0;
const check = (n, c, detail) => {
  if (c) { passed++; console.log(`  ✅ ${n}`); }
  else   { failed++; console.log(`  ❌ ${n}${detail !== undefined ? ` — ${detail}` : ''}`); }
};

const rows     = () => [...d.querySelectorAll('#bot-item-tbody tr')];
const rowNamed = re => rows().find(tr => re.test(tr.textContent));
const overlay  = () => d.getElementById('bot-item-edit-overlay');
const isVisible = el => {
  const cs = w.getComputedStyle(el);
  return el.classList.contains('open') && cs.opacity === '1' && cs.pointerEvents !== 'none' && cs.display !== 'none';
};
const editBtn  = tr => tr.querySelector('button[title="Edit item"]');
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
    d.getElementById('bot-cat-tabs').dataset.active = 'All';
    w.botSetCat('All');
    await w.loadBotOrders();
    await tick(40);
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

  console.log(`\n${'─'.repeat(60)}`);
  console.log(`${passed} passed, ${failed} failed`);
  dom.window.close();
  process.exit(failed ? 1 : 0);
})().catch(e => { console.log('  ❌ test crashed —', e.stack); process.exit(1); });
