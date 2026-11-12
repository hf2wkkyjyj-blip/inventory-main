'use strict';
// One fee per order: per unit or whole order, the product-row shortcut, and the
// one-time fold of the old FEE / UNIT. Made-up data.
process.removeAllListeners('warning');
const { DatabaseSync } = require('node:sqlite');
const { feeFor, saveFee, setUnitFee, foldUnitFees } = require('../feeRules');
const { orderLineCosts } = require('../itemView');
let passed = 0, failed = 0;
const eq = (n, a, b) => { if (JSON.stringify(a) === JSON.stringify(b)) { passed++; console.log(`  ✅ ${n}`); } else { failed++; console.log(`  ❌ ${n} — got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`); } };

const raw = new DatabaseSync(':memory:');
const a = p => (p === undefined ? [] : Array.isArray(p) ? p : [p]);
const db = {
  exec: sql => raw.exec(sql),
  prepare: sql => { const st = raw.prepare(sql); return { all: p => st.all(...a(p)), get: p => st.get(...a(p)), run: p => st.run(...a(p)) }; },
};
raw.exec(`CREATE TABLE bot_orders (id INTEGER PRIMARY KEY, retailer TEXT, order_number TEXT, status TEXT, items TEXT, order_total REAL,
  tax_amount REAL, ship_cost REAL, finder_fee REAL, fee_source TEXT, fee_set_at TEXT, fee_mode TEXT, fee_unit REAL, fee_lines TEXT, order_date TEXT)`);
raw.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)');
raw.exec('CREATE TABLE bot_sku_prices (sku TEXT PRIMARY KEY, buyer_fee REAL DEFAULT 0, sale_price REAL DEFAULT 0)');
const cat = { products: new Map(), aliases: new Map() };
const ins = (id, items, o = {}) => raw.prepare(`INSERT INTO bot_orders (id, retailer, order_number, status, items, order_total, finder_fee, fee_source, fee_mode, fee_unit, order_date)
  VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(id, o.store || 'Test Mart', 'T' + id, o.status || 'Confirmed', JSON.stringify(items), 50, o.fee ?? 0, o.src ?? null, o.mode ?? null, o.unit ?? null, '2026-10-01');
const row = id => raw.prepare('SELECT finder_fee f, fee_source s, fee_mode m, fee_unit u FROM bot_orders WHERE id=?').get(id);
const order = id => raw.prepare('SELECT * FROM bot_orders WHERE id=?').get(id);
const lines = id => raw.prepare('SELECT fee_lines l FROM bot_orders WHERE id=?').get(id).l;

console.log('\n── Counted per unit or as a whole order ──');
ins(1, ['2x Test Box @ $25.00']);
eq('per unit: 2 units × $3 = $6',        feeFor(order(1), 'unit', 3, cat), { mode: 'unit', unit: 3, fee: 6, units: 2 });
eq('whole order: $6 stays $6',           feeFor(order(1), 'order', 6, cat), { mode: 'order', unit: null, fee: 6, units: 2 });
eq('bad or negative amount → $0',        [feeFor(order(1), 'unit', -4, cat).fee, feeFor(order(1), 'unit', 'x', cat).fee], [0, 0]);
ins(2, ['3x Test Box @ $25.00', '1x Other Thing @ $25.00']);
eq('units add up across lines',          feeFor(order(2), 'unit', 2, cat).fee, 8);

console.log('\n── A product row sets the fee of that item in its orders ──');
raw.exec('DELETE FROM bot_orders');
ins(1, ['2x Test Box @ $25.00']);                                           // no fee
ins(2, ['3x Test Box @ $25.00'], { fee: 7, src: 'manual' });                // had $7 of its own
ins(3, ['1x Test Box @ $25.00', '1x Other Thing @ $25.00']);                // a box with another item, no fee yet
ins(4, ['2x Test Box @ $25.00'], { fee: 12, src: 'manual', mode: 'order' }); // counted as a whole order
ins(5, ['2x Test Box @ $25.00'], { status: 'Cancelled' });
const ids = [1, 2, 3, 4, 5], mine = { rawNames: ['Test Box'] };
const dry = setUnitFee(db, cat, ids, 3, { ...mine, dryRun: true });
eq('preview counts',                     dry, { orders: 4, set: 3, same: 0, changed: 1, inBoxes: 1, totalMoves: 1, skippedWhole: 1, tooBig: 0 });
eq('preview writes nothing',             [row(1).f, row(2).f, row(3).f], [0, 7, 0]);
setUnitFee(db, cat, ids, 3, mine);
eq('no-fee order: 2 × $3',               row(1), { f: 6, s: 'manual', m: 'unit', u: 3 });
eq('replaces a different fee: 3 × $3',   row(2), { f: 9, s: 'manual', m: 'unit', u: 3 });
eq('box: this item 1 × $3, other item $0', [row(3).f, row(3).s, JSON.parse(lines(3))], [3, 'manual', { 'test box': 3, _total: 'items' }]);
eq('whole-order fee left alone',         row(4), { f: 12, s: 'manual', m: 'order', u: null });
eq('cancelled left alone',               row(5).f, 0);
eq('again → nothing to change',          setUnitFee(db, cat, ids, 3, { ...mine, dryRun: true }).set, 0);
eq('new rate follows',                   (setUnitFee(db, cat, ids, 4, mine), [row(1).f, row(2).f, row(3).f]), [8, 12, 4]);
eq('an item that is not in the order is skipped', setUnitFee(db, cat, ids, 4, { rawNames: ['Nothing Here'], dryRun: true }).orders, 0);

console.log('\n── In a box the total stays; this item takes its part and the others share the rest ──');
raw.exec('DELETE FROM bot_orders');
ins(1, ['2x Test Box @ $25.00', '1x Display @ $90.00', '1x Bundle @ $27.00'], { fee: 57.5, src: 'manual', mode: 'unit', unit: 14.38 });   // a box of 4 units
ins(2, ['1x Test Box @ $25.00', '1x Display @ $90.00']);                                                                                   // a box with no fee yet
ins(3, ['2x Test Box @ $25.00', '2x Display @ $90.00'], { fee: 60, src: 'manual', mode: 'order' });                                        // a box counted as a whole
ins(4, ['2x Test Box @ $25.00', '1x Display @ $90.00'], { fee: 12, src: 'manual' });                                                       // a box with a small fee
const per = id => Object.fromEntries(orderLineCosts(order(id)).map(l => [l.rawName, Math.round(l.unitFinder * 100) / 100]));
const sum = id => orderLineCosts(order(id)).reduce((s, l) => s + l.unitFinder * l.qty, 0);
const near = (a, b) => Math.abs(a - b) <= 0.011;
const all4 = [1, 2, 3, 4];
const before = per(1);
eq('before: the box fee is shared by price',   [before['Test Box'], before.Display, before.Bundle], [8.61, 30.99, 9.3]);
eq('preview: 3 boxes set, 1 too small',        setUnitFee(db, cat, all4, 25, { ...mine, dryRun: true }), { orders: 4, set: 3, same: 0, changed: 2, inBoxes: 3, totalMoves: 1, skippedWhole: 0, tooBig: 1 });
eq('preview writes nothing',                   [row(1).f, lines(1)], [57.5, null]);
setUnitFee(db, cat, all4, 25, mine);
const after = per(1);
eq('this item is $25 each in the box',         after['Test Box'], 25);
eq('the box total did NOT change',             row(1).f, 57.5);
eq('the others share what is left ($7.50)',    [near(after.Display, 5.77), near(after.Bundle, 1.73)], [true, true]);
eq('the lines add up to the box total',        near(sum(1), 57.5), true);
eq('a box with no fee: this item is its fee',  [row(2).f, per(2)['Test Box'], per(2).Display], [25, 25, 0]);
eq('a box counted as a whole keeps its $60',   [row(3).f, row(3).m, per(3)['Test Box'], per(3).Display], [60, 'order', 25, 5]);
eq('a box too small for it is left alone',     [row(4).f, lines(4)], [12, null]);
eq('same price again → nothing to change',     setUnitFee(db, cat, all4, 25, { ...mine, dryRun: true }).set, 0);
setUnitFee(db, cat, all4, 5, { rawNames: ['Display'] });
eq('another item can have its own rate',       [per(1)['Test Box'], per(1).Display, per(1).Bundle], [25, 5, 2.5]);
eq('… still the same box total',               [near(sum(1), 57.5), row(1).f, row(3).f], [true, 57.5, 60]);
eq('a box made only of item fees follows them', [row(2).f, JSON.parse(lines(2))], [30, { 'test box': 25, _total: 'items', display: 5 }]);
eq('a typed box total never grows',            [setUnitFee(db, cat, [1], 3, { rawNames: ['Bundle'], dryRun: true }).tooBig, row(1).f], [1, 57.5]);
eq('a small box fee still fits a small item',   [row(4).f, per(4).Display, per(4)['Test Box']], [12, 5, 3.5]);
saveFee(db, 1, feeFor(order(1), 'order', 40, cat), '2026-11-12');
eq('a fee on the whole box replaces the item fees', [row(1).f, lines(1), per(1)['Test Box'] < 25], [40, null, true]);
eq('item fees bigger than the box total are ignored', (raw.prepare("UPDATE bot_orders SET fee_lines='{\"test box\":99}' WHERE id=1").run(), near(sum(1), 40)), true);

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
