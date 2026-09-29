'use strict';
// tools/check-data.js finds each kind of problem, and stays quiet on clean data.
// Real SQLite file; all data made up.

process.removeAllListeners('warning');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { checkData, report, openDb } = require('../tools/check-data');

let passed = 0, failed = 0;
const check = (n, c, detail) => {
  if (c) { passed++; console.log(`  ✅ ${n}`); }
  else   { failed++; console.log(`  ❌ ${n}${detail !== undefined ? ` — ${detail}` : ''}`); }
};

function build(file, seed) {
  fs.rmSync(file, { force: true });
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE bot_orders (id INTEGER PRIMARY KEY, order_number TEXT, retailer TEXT, category TEXT, status TEXT,
    tracking TEXT, tracking_status TEXT, delivered_date TEXT, expected_date TEXT, items TEXT, order_total REAL DEFAULT 0,
    tax_amount REAL DEFAULT 0, ship_cost REAL DEFAULT 0, finder_fee REAL DEFAULT 0, refunded_amount REAL DEFAULT 0,
    shipping_name TEXT, shipping_address TEXT, order_date TEXT);
    CREATE TABLE bot_sku_prices (sku TEXT PRIMARY KEY, buyer_fee REAL DEFAULT 0, sale_price REAL DEFAULT 0);
    CREATE TABLE bot_sales (id INTEGER PRIMARY KEY, sku_key TEXT, product_name TEXT, qty INTEGER, unit_price REAL, fees REAL DEFAULT 0, channel TEXT, sold_at TEXT);
    CREATE TABLE sku_products (id INTEGER PRIMARY KEY, name TEXT UNIQUE);
    CREATE TABLE sku_aliases (alias_key TEXT PRIMARY KEY, raw_name TEXT, product_id INTEGER);`);
  seed(db);
  db.close();
}
const O = (db, o) => db.prepare(`INSERT INTO bot_orders (id, order_number, retailer, status, tracking, tracking_status,
  delivered_date, expected_date, items, order_total, finder_fee, shipping_address) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
  .run(o.id, o.num, o.store || 'Test Store', o.status || 'Delivered', o.trk || null, o.ts || null, o.dd || null,
       o.exp || null, o.items === undefined ? JSON.stringify(['2x Test Car @ $30.00']) : o.items, o.total ?? 65, o.fee || 0, o.addr || '1 Test St');

const tmp = path.join(os.tmpdir(), `checkdata-${process.pid}`);
fs.mkdirSync(tmp, { recursive: true });

console.log('\n── Clean data: nothing flagged ──');
{
  const f = path.join(tmp, 'clean.db');
  build(f, db => {
    for (let i = 1; i <= 3; i++) O(db, { id: i, num: `C0${i}`, fee: 35 });
    db.prepare("INSERT INTO bot_sales VALUES (1,'Test Car','Test Car',2,50,0,'eBay','2026-09-20')").run();
  });
  const r = checkData(openDb(f));
  check('no findings',            r.findings.length === 0, JSON.stringify(r.findings.map(x => x.title)));
  check('fees total $105',        r.summary.finderFees === 105, r.summary.finderFees);
  check('sales profit = 2×50 − 2×(32.50+35/2)', r.summary.salesProfit === 0, r.summary.salesProfit);
  check('report says nothing off', /Nothing looks off/.test(report(r)));
}

console.log('\n── Every kind of problem is caught ──');
{
  const f = path.join(tmp, 'messy.db');
  build(f, db => {
    // Drop of 4 look-alike orders: 2 at $35, 1 missed, 1 typo $53
    O(db, { id: 1, num: 'D01', fee: 35 }); O(db, { id: 2, num: 'D02', fee: 35 });
    O(db, { id: 3, num: 'D03', fee: 0 });  O(db, { id: 4, num: 'D04', fee: 53 });
    // Box fee on a product AND an extra per-unit fee typed for it
    O(db, { id: 5, num: 'B01', items: JSON.stringify(['1x Test Tin @ $20.00']), total: 20, fee: 5 });
    db.prepare("INSERT INTO bot_sku_prices VALUES ('Test Tin', 5, 0)").run();
    // Fee on a cancelled order; absurd fee
    O(db, { id: 6, num: 'X01', status: 'Cancelled', fee: 20 });
    O(db, { id: 7, num: 'H01', items: JSON.stringify(['1x Test Pack @ $10.00']), total: 10, fee: 9 });
    // Multi-order box, fee on one order only
    O(db, { id: 8, num: 'M01', trk: '870000000901', items: JSON.stringify(['1x Test Deck @ $40.00']), total: 40, fee: 10 });
    O(db, { id: 9, num: 'M02', trk: '870000000901', items: JSON.stringify(['1x Test Deck @ $40.00']), total: 40 });
    // Stuck status; one tracking to two addresses; duplicate order number
    O(db, { id: 10, num: 'S01', status: 'Shipped', ts: 'Delivered', dd: '2026-09-27', items: JSON.stringify(['1x Test Sleeve @ $5.00']), total: 5 });
    O(db, { id: 11, num: 'T01', status: 'Shipped', trk: '870000000902', addr: '1 Test St', items: JSON.stringify(['1x Test Mat @ $5.00']), total: 5 });
    O(db, { id: 12, num: 'T02', status: 'Shipped', trk: '870000000902', addr: '99 Other Rd', items: JSON.stringify(['1x Test Mat @ $5.00']), total: 5 });
    O(db, { id: 13, num: 'S01', status: 'Confirmed', items: JSON.stringify(['1x Test Sleeve @ $5.00']), total: 5 });
    // No items; late shipment
    O(db, { id: 14, num: 'N01', items: '[]', total: 30, fee: 4 });
    O(db, { id: 15, num: 'L01', status: 'Shipped', exp: '2026-01-02', items: JSON.stringify(['1x Test Late @ $5.00']), total: 5 });
    // Sales: orphan, oversold, $0
    db.prepare("INSERT INTO bot_sales VALUES (1,'Gone Product','Gone Product',1,40,0,'eBay','2026-09-20')").run();
    db.prepare("INSERT INTO bot_sales VALUES (2,'Test Pack','Test Pack',3,20,0,'eBay','2026-09-20')").run();
    db.prepare("INSERT INTO bot_sales VALUES (3,'Test Deck','Test Deck',1,0,0,'Local','2026-09-20')").run();
  });
  const r = checkData(openDb(f));
  const find = re => r.findings.find(x => re.test(x.title));
  const rows = re => (find(re) || { rows: [] }).rows.join(' | ');

  check('double fee on Test Tin',         /Test Tin: box \$5\.00\/unit \+ extra \$5\.00/.test(rows(/counted twice/)), rows(/counted twice/));
  check('look-alike orders, fees differ', /2× \$35\.00/.test(rows(/different fees/)) && /no fee \(#D03\)/.test(rows(/different fees/)) && /\$53\.00 \(#D04\)/.test(rows(/different fees/)), rows(/different fees/));
  check('fee on cancelled order',         /#X01/.test(rows(/cancelled\/refunded/)));
  check('fee out of proportion',          /#H01/.test(rows(/60%/)) && /#D04/.test(rows(/60%/)) && !/#D01|#D02/.test(rows(/60%/)), rows(/60%/));
  check('box fee on one order only',      /fee on #M01 only, not on #M02/.test(rows(/only some/)), rows(/only some/));
  check('shared-box orders not compared as look-alikes', !/Test Deck/.test(rows(/different fees/)));
  check('stuck delivered status',         /#S01/.test(rows(/Tracking says Delivered/)));
  check('tracking to two addresses',      /870000000902/.test(rows(/different addresses/)));
  check('duplicate order number',         /#S01 × 2/.test(rows(/duplicates/)));
  check('order with no items',            /#N01/.test(rows(/no items/)));
  check('late shipment',                  /#L01/.test(rows(/week after/)));
  check('orphan sale',                    /Gone Product/.test(rows(/matches no current product/)));
  check('oversold',                       /Test Pack: sold 3 of 1/.test(rows(/more than bought/)));
  check('$0 sale',                        /sale 3/.test(rows(/at \$0/)));
  check('no addresses printed',           !/1 Test St\b|99 Other Rd/.test(report(r)));
  // Straight at the SQLite handle, not the wrapper: the FILE must be read-only.
  check('file opened read-only',           (() => { try { openDb(f).raw.exec('DELETE FROM bot_orders'); return false; } catch (_) { return true; } })());
  check('file still has all its orders',   new DatabaseSync(f, { readOnly: true }).prepare('SELECT COUNT(*) n FROM bot_orders').get().n === 15);
}

if (!process.env.KEEP) fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${'─'.repeat(60)}`);
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
