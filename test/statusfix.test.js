'use strict';
// Delivered orders stuck in the Shipped list: status said Shipped while the
// tracking status and delivery date said Delivered. Real SQLite (node:sqlite).
// All data made up.

process.removeAllListeners('warning');
const { DatabaseSync } = require('node:sqlite');
const M = require('../orderMerge');

let passed = 0, failed = 0;
const eq = (n, a, e) => {
  if (a === e) { passed++; console.log(`  ✅ ${n}`); }
  else { failed++; console.log(`  ❌ ${n} — got ${JSON.stringify(a)}, expected ${JSON.stringify(e)}`); }
};

function makeDb() {
  const raw = new DatabaseSync(':memory:');
  const db = {
    exec: sql => raw.exec(sql),
    prepare: sql => {
      const st = raw.prepare(sql);
      const norm = p => (p === undefined ? [] : Array.isArray(p) ? p : [p]);
      return { all: p => st.all(...norm(p)), get: p => st.get(...norm(p)), run: p => st.run(...norm(p)) };
    },
  };
  db.exec(`CREATE TABLE bot_orders (id INTEGER PRIMARY KEY, order_number TEXT, retailer TEXT, status TEXT,
    tracking TEXT, tracking_status TEXT, delivered_date TEXT, expected_date TEXT, status_changed_at TEXT,
    status_source TEXT, items TEXT, order_total REAL DEFAULT 0, tax_amount REAL DEFAULT 0, ship_cost REAL DEFAULT 0,
    finder_fee REAL DEFAULT 0, shipping_name TEXT, shipping_address TEXT, account_email TEXT, order_date TEXT,
    notes TEXT, category TEXT)`);
  return db;
}
const ins = (db, o) => db.prepare(`INSERT INTO bot_orders (id, order_number, retailer, status, tracking, tracking_status,
  delivered_date, status_source, order_total, items) VALUES (?,?,?,?,?,?,?,?,?,?)`)
  .run([o.id, o.num, o.retailer || 'Test Store', o.status, o.tracking || null, o.ts || null, o.dd || null,
        o.src || null, o.total || 0, o.items || null]);
const get = (db, id) => db.prepare('SELECT * FROM bot_orders WHERE id=?').get([id]);
const quiet = () => {};

console.log('\n── Reconcile: tracking says delivered + delivery date → Delivered ──');
{
  const db = makeDb();
  ins(db, { id: 1, num: 'A1', status: 'Shipped',   ts: 'Delivered', dd: '2026-09-27' });            // the reported case
  ins(db, { id: 2, num: 'A2', status: 'Confirmed', ts: 'Delivered', dd: '2026-09-27' });
  ins(db, { id: 3, num: 'A3', status: 'Shipped',   ts: 'OFD' });                                      // really in transit
  ins(db, { id: 4, num: 'A4', status: 'Shipped',   ts: 'Delivered', dd: null });                      // no date — not enough
  ins(db, { id: 5, num: 'A5', status: 'Cancelled', ts: 'Delivered', dd: '2026-09-27' });              // never override
  ins(db, { id: 6, num: 'A6', status: 'Shipped',   ts: 'Delivered', dd: '2026-09-27', src: 'carrier' });

  eq('fixed 3 rows',                  M.reconcileDelivered(db, quiet), 3);
  eq('Shipped → Delivered',           get(db, 1).status, 'Delivered');
  eq('Confirmed → Delivered',         get(db, 2).status, 'Delivered');
  eq('marked manual (survives Repair)', get(db, 1).status_source, 'manual');
  eq('existing source kept',          get(db, 6).status_source, 'carrier');
  eq('in-transit untouched',          get(db, 3).status, 'Shipped');
  eq('no delivery date → untouched',  get(db, 4).status, 'Shipped');
  eq('Cancelled untouched',           get(db, 5).status, 'Cancelled');
  eq('delivery date not changed',     get(db, 1).delivered_date, '2026-09-27');
  eq('second run does nothing',       M.reconcileDelivered(db, quiet), 0);
}

console.log('\n── Duplicate merge keeps the furthest status ──');
{
  const db = makeDb();
  // Kept row (richer: total + tracking) is Shipped; the duplicate got Delivered.
  ins(db, { id: 1, num: 'B1', status: 'Shipped',   tracking: '870000000501', total: 60, items: '["1x Test @ $55.00"]' });
  ins(db, { id: 2, num: 'B1', status: 'Delivered', ts: 'Delivered', dd: '2026-09-20' });
  // Kept row Delivered, duplicate Cancelled: Cancelled is never taken from a donor.
  ins(db, { id: 3, num: 'B2', status: 'Delivered', tracking: '870000000502', total: 60, items: '["1x Test @ $55.00"]', ts: 'Delivered', dd: '2026-09-20' });
  ins(db, { id: 4, num: 'B2', status: 'Cancelled' });
  // Kept row Cancelled stays Cancelled even if a donor is Delivered.
  ins(db, { id: 5, num: 'B3', status: 'Cancelled', tracking: '870000000503', total: 60, items: '["1x Test @ $55.00"]' });
  ins(db, { id: 6, num: 'B3', status: 'Shipped' });

  M.mergeDuplicateOrders(db, quiet);
  eq('one row per order',                db.prepare('SELECT COUNT(*) n FROM bot_orders').get().n, 3);
  eq('Shipped + Delivered dup → Delivered', get(db, 1).status, 'Delivered');
  eq('delivery date carried over',       get(db, 1).delivered_date, '2026-09-20');
  eq('Cancelled donor not taken',        get(db, 3).status, 'Delivered');
  eq('kept Cancelled stays Cancelled',   get(db, 5).status, 'Cancelled');
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
