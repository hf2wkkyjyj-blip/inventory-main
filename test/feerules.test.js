'use strict';
// One fee per order: per unit or whole order, the product-row shortcut, and the
// one-time fold of the old FEE / UNIT. Made-up data.
process.removeAllListeners('warning');
const { DatabaseSync } = require('node:sqlite');
const { feeFor, setUnitFee, foldUnitFees } = require('../feeRules');
let passed = 0, failed = 0;
const eq = (n, a, b) => { if (JSON.stringify(a) === JSON.stringify(b)) { passed++; console.log(`  ✅ ${n}`); } else { failed++; console.log(`  ❌ ${n} — got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`); } };

const raw = new DatabaseSync(':memory:');
const a = p => (p === undefined ? [] : Array.isArray(p) ? p : [p]);
const db = {
  exec: sql => raw.exec(sql),
  prepare: sql => { const st = raw.prepare(sql); return { all: p => st.all(...a(p)), get: p => st.get(...a(p)), run: p => st.run(...a(p)) }; },
};
raw.exec(`CREATE TABLE bot_orders (id INTEGER PRIMARY KEY, retailer TEXT, order_number TEXT, status TEXT, items TEXT, order_total REAL,
  tax_amount REAL, ship_cost REAL, finder_fee REAL, fee_source TEXT, fee_set_at TEXT, fee_mode TEXT, fee_unit REAL, order_date TEXT)`);
raw.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)');
raw.exec('CREATE TABLE bot_sku_prices (sku TEXT PRIMARY KEY, buyer_fee REAL DEFAULT 0, sale_price REAL DEFAULT 0)');
const cat = { products: new Map(), aliases: new Map() };
const ins = (id, items, o = {}) => raw.prepare(`INSERT INTO bot_orders (id, retailer, order_number, status, items, order_total, finder_fee, fee_source, fee_mode, fee_unit, order_date)
  VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(id, o.store || 'Test Mart', 'T' + id, o.status || 'Confirmed', JSON.stringify(items), 50, o.fee ?? 0, o.src ?? null, o.mode ?? null, o.unit ?? null, '2026-10-01');
const row = id => raw.prepare('SELECT finder_fee f, fee_source s, fee_mode m, fee_unit u FROM bot_orders WHERE id=?').get(id);
const order = id => raw.prepare('SELECT * FROM bot_orders WHERE id=?').get(id);

console.log('\n── Counted per unit or as a whole order ──');
ins(1, ['2x Test Box @ $25.00']);
eq('per unit: 2 units × $3 = $6',        feeFor(order(1), 'unit', 3, cat), { mode: 'unit', unit: 3, fee: 6, units: 2 });
eq('whole order: $6 stays $6',           feeFor(order(1), 'order', 6, cat), { mode: 'order', unit: null, fee: 6, units: 2 });
eq('bad or negative amount → $0',        [feeFor(order(1), 'unit', -4, cat).fee, feeFor(order(1), 'unit', 'x', cat).fee], [0, 0]);
ins(2, ['3x Test Box @ $25.00', '1x Other Thing @ $25.00']);
eq('units add up across lines',          feeFor(order(2), 'unit', 2, cat).fee, 8);

console.log('\n── A product row sets its orders ──');
raw.exec('DELETE FROM bot_orders');
ins(1, ['2x Test Box @ $25.00']);                                           // no fee
ins(2, ['3x Test Box @ $25.00'], { fee: 7, src: 'manual' });                // had $7 of its own
ins(3, ['1x Test Box @ $25.00', '1x Other Thing @ $25.00']);                // several products
ins(4, ['2x Test Box @ $25.00'], { fee: 12, src: 'manual', mode: 'order' }); // counted as a whole order
ins(5, ['2x Test Box @ $25.00'], { status: 'Cancelled' });
const ids = [1, 2, 3, 4, 5];
const dry = setUnitFee(db, cat, ids, 3, { dryRun: true });
eq('preview counts',                     dry, { orders: 4, set: 2, same: 0, changed: 1, skippedMixed: 1, skippedWhole: 1 });
eq('preview writes nothing',             [row(1).f, row(2).f], [0, 7]);
setUnitFee(db, cat, ids, 3);
eq('no-fee order: 2 × $3',               row(1), { f: 6, s: 'manual', m: 'unit', u: 3 });
eq('replaces a different fee: 3 × $3',   row(2), { f: 9, s: 'manual', m: 'unit', u: 3 });
eq('several products left alone',        row(3).f, 0);
eq('whole-order fee left alone',         row(4), { f: 12, s: 'manual', m: 'order', u: null });
eq('cancelled left alone',               row(5).f, 0);
eq('again → nothing to change',          setUnitFee(db, cat, ids, 3, { dryRun: true }).set, 0);
eq('new rate follows',                   (setUnitFee(db, cat, ids, 4), [row(1).f, row(2).f]), [8, 12]);

console.log('\n── Old FEE / UNIT folds into the orders once ──');
raw.exec('DELETE FROM bot_orders');
ins(1, ['2x Test Box @ $25.00']);                                           // no fee at all
ins(2, ['2x Test Box @ $25.00'], { fee: 4, src: 'manual' });                // your own $4
ins(3, ['2x Test Box @ $25.00'], { fee: 2, src: 'auto' });                  // an estimate
ins(4, ['2x Test Box @ $25.00'], { status: 'Cancelled' });
ins(5, ['2x Other Thing @ $25.00']);
raw.prepare("INSERT INTO bot_sku_prices (sku, buyer_fee) VALUES ('Test Box', 3)").run();
const r = foldUnitFees(db, cat);
eq('3 orders, $18 folded in',            [r.orders, r.added], [3, 18]);
eq('no fee → its per-unit fee',          row(1), { f: 6, s: 'manual', m: 'unit', u: 3 });
eq('own $4 + $6 = $10, mode kept',       row(2), { f: 10, s: 'manual', m: null, u: null });
eq('auto $2 + $6 = $8, now yours',       row(3), { f: 8, s: 'manual', m: 'unit', u: 4 });
eq('cancelled and other products',       [row(4).f, row(5).f], [0, 0]);
eq('old per-unit fee is zero now',       raw.prepare('SELECT buyer_fee b FROM bot_sku_prices').get().b, 0);
eq('original kept',                      raw.prepare("SELECT buyer_fee b FROM buyer_fee_legacy WHERE sku='Test Box'").get().b, 3);
eq('backup of the 3 orders',             raw.prepare('SELECT count(*) c FROM fee_fold_backup').get().c, 3);
eq('second run does nothing',            [foldUnitFees(db, cat).skipped, row(2).f], [true, 10]);
raw.exec("DELETE FROM settings"); raw.prepare("UPDATE bot_sku_prices SET buyer_fee=3").run();
eq('even if the flag is lost, no order is folded twice', [foldUnitFees(db, cat).orders, row(1).f, row(2).f, row(3).f], [0, 6, 10, 8]);

console.log(`\n${'─'.repeat(60)}`);
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
