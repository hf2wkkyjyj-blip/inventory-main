'use strict';
// Auto finder fee: your last fee per unit, per product, per store. Made-up data.
process.removeAllListeners('warning');
const { DatabaseSync } = require('node:sqlite');
const { applyAutoFees, feeRates } = require('../autoFees');
let passed = 0, failed = 0;
const eq = (n, a, b) => { if (JSON.stringify(a) === JSON.stringify(b)) { passed++; console.log(`  ✅ ${n}`); } else { failed++; console.log(`  ❌ ${n} — got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`); } };

const raw = new DatabaseSync(':memory:');
const db = { prepare: sql => { const st = raw.prepare(sql); const a = p => (p === undefined ? [] : Array.isArray(p) ? p : [p]);
  return { all: p => st.all(...a(p)), get: p => st.get(...a(p)), run: p => st.run(...a(p)) }; } };
raw.exec(`CREATE TABLE bot_orders (id INTEGER PRIMARY KEY, retailer TEXT, order_number TEXT, status TEXT, items TEXT, order_total REAL,
  tax_amount REAL, ship_cost REAL, finder_fee REAL, fee_source TEXT, fee_set_at TEXT, fee_mode TEXT, fee_unit REAL, order_date TEXT, received_at TEXT, created_at TEXT)`);
const cat = { products: new Map(), aliases: new Map() };
const ins = (id, retailer, items, fee, extra = {}) => raw.prepare(`INSERT INTO bot_orders (id, retailer, order_number, status, items, order_total, finder_fee, fee_source, fee_set_at, order_date)
  VALUES (?,?,?,?,?,?,?,?,?,?)`).run(id, retailer, 'T' + id, extra.status || 'Confirmed', JSON.stringify(items), extra.total || 50, fee, extra.src || null, extra.at || null, extra.date || '2026-10-01');
const fee = id => raw.prepare('SELECT finder_fee f, fee_source s FROM bot_orders WHERE id=?').get(id);

ins(1, 'Test Mart', ['2x Test Box @ $25.00'], 10, { date: '2026-09-01' });                 // yours: $5/unit at Test Mart
ins(2, 'Toy Center', ['2x Test Box @ $25.00'], 16, { date: '2026-09-02' });                // yours: $8/unit at Toy Center
ins(3, 'Test Mart', ['3x Test Box @ $25.00'], 0, { total: 75 });                            // new, no fee
ins(4, 'Toy Center', ['1x Test Box @ $25.00'], 0, { total: 25 });                           // new, no fee
ins(5, 'Test Mart', ['2x Test Box @ $25.00'], 0, { src: 'manual' });                        // you set $0 on purpose
ins(6, 'Test Mart', ['2x Test Box @ $25.00'], 0, { status: 'Cancelled' });
ins(7, 'Test Mart', ['1x Test Box @ $25.00', '1x Other Thing @ $25.00'], 0);                // only one line has a rate
ins(8, 'Other Shop', ['2x Test Box @ $25.00'], 0);                                          // store with no fee history

console.log('\n── Fill orders with no fee ──');
eq('changed 3 orders',                         applyAutoFees(db, cat), 3);
eq('Test Mart: 3 × $5 = $15, auto',            fee(3), { f: 15, s: 'auto' });
eq('Toy Center: its own rate 1 × $8',          fee(4), { f: 8, s: 'auto' });
eq('$0 you set stays $0',                      fee(5), { f: 0, s: 'manual' });
eq('cancelled untouched',                      fee(6), { f: 0, s: null });
eq('mixed order: only the line with a rate',   fee(7), { f: 5, s: 'auto' });
eq('store with no history untouched',          fee(8), { f: 0, s: null });
eq('your old fees untouched',                  [fee(1).f, fee(2).f], [10, 16]);

console.log('\n── Your newest fee is the rate; auto orders follow ──');
raw.prepare("UPDATE bot_orders SET finder_fee=14, fee_source='manual', fee_set_at='2026-10-11T10:00:00Z' WHERE id=1").run();   // now $7/unit
applyAutoFees(db, cat);
eq('auto order follows: 3 × $7 = $21',         fee(3).f, 21);
eq('… mixed one too: $7',                      fee(7).f, 7);
eq('auto fees never become the rate',          feeRates(raw.prepare('SELECT * FROM bot_orders').all(), cat).get('test mart|' + require('../itemNames').itemKey(require('../packageView').productNameFor('Test Box', cat))).order_id, 1);
eq('running again changes nothing',            applyAutoFees(db, cat), 0);

console.log('\n── A whole-order store gets the same amount, not a rate ──');
raw.exec('DELETE FROM bot_orders');
ins(21, 'Flat Shop', ['2x Test Box @ $25.00'], 12, { src: 'manual', at: '2026-10-12T10:00:00Z', date: '2026-10-12' });
raw.prepare("UPDATE bot_orders SET fee_mode='order' WHERE id=21").run();                    // $12 for the whole order
ins(22, 'Flat Shop', ['5x Test Box @ $25.00'], 0, { total: 125 });                          // bigger order, no fee yet
ins(23, 'Unit Shop', ['2x Test Box @ $25.00'], 10, { src: 'manual', at: '2026-10-12T10:00:00Z', date: '2026-10-12' });
raw.prepare("UPDATE bot_orders SET fee_mode='unit', fee_unit=5 WHERE id=23").run();         // $5 per unit
ins(24, 'Unit Shop', ['3x Test Box @ $25.00'], 0, { total: 75 });
const tail = id => raw.prepare('SELECT finder_fee f, fee_source s, fee_mode m, fee_unit u FROM bot_orders WHERE id=?').get(id);
applyAutoFees(db, cat);
eq('whole-order store: same $12, not 5 × a rate', tail(22), { f: 12, s: 'auto', m: 'order', u: null });
eq('per-unit store: 3 × $5, remembers the rate',  tail(24), { f: 15, s: 'auto', m: 'unit', u: 5 });
eq('a whole-order fee is no per-unit rate',       feeRates(raw.prepare('SELECT * FROM bot_orders').all(), cat).size, 1);
eq('running again changes nothing',               applyAutoFees(db, cat), 0);

console.log(`\n${'─'.repeat(60)}`);
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
