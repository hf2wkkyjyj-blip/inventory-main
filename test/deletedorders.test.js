'use strict';
// Deleted orders: a copy is kept and Restore puts the order back as it was; orders
// deleted before that existed are rebuilt from saved emails. Made-up data.
process.removeAllListeners('warning');
const { DatabaseSync } = require('node:sqlite');
const D = require('../deletedOrders');
let passed = 0, failed = 0;
const eq = (n, a, b) => { if (JSON.stringify(a) === JSON.stringify(b)) { passed++; console.log(`  ✅ ${n}`); } else { failed++; console.log(`  ❌ ${n} — got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`); } };

const raw = new DatabaseSync(':memory:');
const a = p => (p === undefined ? [] : Array.isArray(p) ? p : [p]);
const db = {
  exec: sql => raw.exec(sql),
  prepare: sql => { const st = raw.prepare(sql); return { all: p => st.all(...a(p)), get: p => st.get(...a(p)), run: p => st.run(...a(p)) }; },
};
raw.exec(`CREATE TABLE bot_orders (id INTEGER PRIMARY KEY AUTOINCREMENT, email_id TEXT UNIQUE, order_number TEXT, retailer TEXT, status TEXT, items TEXT,
  finder_fee REAL, fee_source TEXT, notes TEXT)`);
raw.exec('CREATE TABLE bot_checkins (order_id INTEGER PRIMARY KEY, checked_at TEXT)');
raw.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)');
raw.exec('CREATE TABLE raw_emails (message_id TEXT PRIMARY KEY, subject TEXT, html TEXT, text TEXT)');
const add = (id, no, status, extra = {}) => raw.prepare('INSERT INTO bot_orders (id, email_id, order_number, retailer, status, items, finder_fee, fee_source, notes) VALUES (?,?,?,?,?,?,?,?,?)')
  .run(id, 'e' + id, no, 'Topps', status, '["2x Box @ $10.00"]', extra.fee ?? 0, extra.src ?? null, extra.notes ?? null);
const live = () => raw.prepare('SELECT id FROM bot_orders ORDER BY id').all().map(r => r.id);
const nums = () => raw.prepare('SELECT order_number FROM bot_orders ORDER BY id').all().map(r => r.order_number);

console.log('\n── A delete keeps a copy, Restore puts it back as it was ──');
add(1, 'US-1-S', 'Cancelled', { fee: 6, src: 'manual', notes: 'hand-typed note' });
add(2, 'US-2-S', 'Delivered');
raw.exec("INSERT INTO bot_checkins VALUES (1, '2026-11-01')");
eq('copy saved',                  D.archiveOrders(db, [1], 'test'), 1);
raw.exec('DELETE FROM bot_orders WHERE id=1');
raw.exec("DELETE FROM bot_checkins WHERE order_id=1");
D.saveBlocked(db, ['US-1-S']);
eq('listed as deleted',           D.listDeleted(db).map(d => d.order_number), ['US-1-S']);
eq('restore',                     D.restoreDeleted(db, D.listDeleted(db).map(d => d.id)), { restored: 1, already: 0, failed: 0 });
const back = raw.prepare('SELECT * FROM bot_orders WHERE id=1').get();
eq('same id, same status',        [back.id, back.status], [1, 'Cancelled']);
eq('hand-typed fee + note kept',  [back.finder_fee, back.fee_source, back.notes], [6, 'manual', 'hand-typed note']);
eq('check-in is back',            raw.prepare('SELECT checked_at c FROM bot_checkins WHERE order_id=1').get().c, '2026-11-01');
eq('no longer blocked',           D.loadBlocked(db), []);
eq('no longer listed',            D.listDeleted(db), []);
eq('restoring twice does nothing', D.restoreDeleted(db, [1]), { restored: 0, already: 0, failed: 0 });

console.log('\n── The scraper already made it again ──');
D.archiveOrders(db, [2], 'test'); raw.exec('DELETE FROM bot_orders WHERE id=2');
add(9, 'US-2-S', 'Confirmed');                                                    // same number, new id
const r2 = D.restoreDeleted(db, D.listDeleted(db).map(d => d.id));
eq('not duplicated',              [r2.restored, r2.already, nums().filter(n => n === 'US-2-S').length], [0, 1, 1]);

console.log('\n── Id taken by another order: restored under a new id ──');
add(20, 'US-20-S', 'Confirmed'); D.archiveOrders(db, [20], 'test'); raw.exec('DELETE FROM bot_orders WHERE id=20');
add(20, 'US-OTHER-S', 'Confirmed');
eq('restored',                    D.restoreDeleted(db, D.listDeleted(db).map(d => d.id)).restored, 1);
eq('both exist, different ids',   nums().filter(n => n === 'US-20-S' || n === 'US-OTHER-S').length, 2);

console.log('\n── Deleted before copies were kept: rebuild from saved emails ──');
raw.exec('DELETE FROM bot_orders'); raw.exec('DELETE FROM settings');
D.saveBlocked(db, ['OLD-1', 'US-15162323-S', 'US-15162131-S', 'US-15161821-S']);   // OLD-1 was deleted long ago
raw.exec("INSERT INTO raw_emails VALUES ('m1','Order US-15162323-S confirmed','', 'Thanks! Order US-15162323-S')");
raw.exec("INSERT INTO raw_emails VALUES ('m2','Shipped','<p>Order US-15162131-S</p>', '')");      // text empty → html is searched
raw.exec("INSERT INTO raw_emails VALUES ('m3','Unrelated','', 'nothing here')");
const plan = D.planRebuild(db, 3);
eq('the last 3 deleted, not older ones', plan.numbers, ['US-15162323-S', 'US-15162131-S', 'US-15161821-S']);
eq('finds their emails',                 [...plan.messageIds].sort(), ['m1', 'm2']);
eq('one has no saved email',             plan.noEmail, ['US-15161821-S']);
eq('unblock the ones asked for',         D.unblock(db, plan.numbers), 3);
eq('older block stays',                  D.loadBlocked(db), ['OLD-1']);
add(5, 'US-15162323-S', 'Confirmed');
eq('an order that exists again is not asked for', D.planRebuild(db, 3).numbers.includes('US-15162323-S'), false);

console.log(`\n${'─'.repeat(60)}\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
