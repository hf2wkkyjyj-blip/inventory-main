'use strict';
// ─── ONE FEE PER ORDER, COUNTED PER UNIT OR AS A WHOLE ───────────────────────
//
// An order's finder fee is one number, saved on the order (finder_fee). Every
// tab, the P&L, refunds and "fee still owed" read that number and nothing else.
//
// How it was worked out is remembered next to it (fee_mode):
//   'unit'  a rate × the units in the order      (fee_unit holds the rate)
//   'order' the amount you typed for the whole order
//   null    older fees, before this was tracked
//
// This replaces the separate FEE / UNIT typed on each product (bot_sku_prices
// .buyer_fee), which was added on top of the order fee — two fees for one thing.
// foldUnitFees() adds those old amounts into their orders once, so no order's
// total changes, then zeroes them.

const { orderLines } = require('./packageView');
const { itemKey } = require('./itemNames');

const r2 = n => Math.round((Number(n) || 0) * 100) / 100;
const DEAD = new Set(['Cancelled', 'Refunded']);

const unitsOf = (o, catalog) => orderLines(o, catalog).reduce((s, l) => s + l.qty, 0);
// Different store titles of one product are one product, so look at product names.
const productKeysOf = (o, catalog) => new Set(orderLines(o, catalog).map(l => itemKey(l.name)));

/** What an order's fee comes to for `amount` counted this way. */
function feeFor(o, mode, amount, catalog) {
  const a = Math.max(0, Number(amount) || 0);
  const units = unitsOf(o, catalog);
  if (mode === 'unit') return { mode: 'unit', unit: r2(a), fee: r2(a * units), units };
  return { mode: 'order', unit: null, fee: r2(a), units };
}

/** Save a fee you set yourself (never touched by the auto fee). */
function saveFee(db, id, f, at) {
  db.prepare("UPDATE bot_orders SET finder_fee=?, fee_source='manual', fee_set_at=?, fee_mode=?, fee_unit=? WHERE id=?")
    .run([f.fee, at, f.mode, f.unit, id]);
}

/**
 * A product's per-unit fee set from its row: each of these orders gets
 * rate × units. Only orders where this is the one product (a box of several
 * products has to be set as a whole), and never one you counted as a whole order.
 */
function setUnitFee(db, catalog, orderIds, perUnit, { dryRun = false, at = new Date().toISOString() } = {}) {
  const out = { orders: 0, set: 0, same: 0, changed: 0, skippedMixed: 0, skippedWhole: 0 };
  for (const id of orderIds) {
    const o = db.prepare('SELECT * FROM bot_orders WHERE id=?').get([id]);
    if (!o || DEAD.has(o.status)) continue;
    out.orders++;
    if (productKeysOf(o, catalog).size !== 1) { out.skippedMixed++; continue; }
    if (o.fee_mode === 'order')               { out.skippedWhole++; continue; }
    const f = feeFor(o, 'unit', perUnit, catalog);
    const had = Number(o.finder_fee) || 0;
    if (Math.abs(had - f.fee) < 0.005 && o.fee_source === 'manual' && o.fee_mode === 'unit') { out.same++; continue; }
    out.set++;
    if (had > 0 && Math.abs(had - f.fee) >= 0.005) out.changed++;     // replaces a different fee
    if (!dryRun) saveFee(db, o.id, f, at);
  }
  return out;
}

/**
 * One-time: fold each product's old FEE / UNIT into its orders. Order total fee
 * stays what it was (item fee + FEE / UNIT × units). Safe to run again: an order
 * already folded is skipped, and the flag is set last. Originals are kept in
 * fee_fold_backup and buyer_fee_legacy.
 */
function foldUnitFees(db, catalog) {
  const FLAG = 'fees_unified_v1';
  try { if (db.prepare('SELECT value FROM settings WHERE key=?').get([FLAG])) return { skipped: true }; } catch (_) { return { skipped: true }; }

  db.exec(`CREATE TABLE IF NOT EXISTS fee_fold_backup (order_id INTEGER PRIMARY KEY, finder_fee REAL, fee_source TEXT, fee_set_at TEXT, fee_mode TEXT, fee_unit REAL)`);
  db.exec(`CREATE TABLE IF NOT EXISTS buyer_fee_legacy (sku TEXT PRIMARY KEY, buyer_fee REAL)`);

  const pricing = new Map();
  let rows = [];
  try { rows = db.prepare('SELECT sku, buyer_fee FROM bot_sku_prices WHERE buyer_fee>0').all(); } catch (_) {}
  rows.forEach(r => pricing.set(itemKey(r.sku), Number(r.buyer_fee) || 0));

  let orders = 0, added = 0;
  if (pricing.size) {
    for (const o of db.prepare('SELECT * FROM bot_orders').all()) {
      if (DEAD.has(o.status)) continue;
      if (db.prepare('SELECT 1 FROM fee_fold_backup WHERE order_id=?').get([o.id])) continue;   // already done
      let extra = 0;
      for (const l of orderLines(o, catalog)) {
        const pid = catalog && catalog.aliases && catalog.aliases.get(l.item_key);
        const rate = (pid && pricing.get(itemKey('#p' + pid))) || pricing.get(l.item_key) || 0;
        extra += rate * l.qty;
      }
      extra = r2(extra);
      if (!(extra > 0)) continue;

      db.prepare('INSERT OR IGNORE INTO fee_fold_backup VALUES (?,?,?,?,?,?)')
        .run([o.id, o.finder_fee ?? null, o.fee_source ?? null, o.fee_set_at ?? null, o.fee_mode ?? null, o.fee_unit ?? null]);
      const had   = Number(o.finder_fee) || 0;
      const total = r2(had + extra);
      const onlyUnit = o.fee_source === 'auto' || !(had > 0);       // no fee of your own on it: this IS its per-unit fee
      const units = unitsOf(o, catalog);
      db.prepare("UPDATE bot_orders SET finder_fee=?, fee_source='manual', fee_mode=?, fee_unit=? WHERE id=?")
        .run([total, onlyUnit ? 'unit' : (o.fee_mode ?? null), onlyUnit && units ? r2(total / units) : (o.fee_unit ?? null), o.id]);
      orders++; added = r2(added + extra);
    }
    rows.forEach(r => db.prepare('INSERT OR IGNORE INTO buyer_fee_legacy VALUES (?,?)').run([r.sku, r.buyer_fee]));
    db.prepare('UPDATE bot_sku_prices SET buyer_fee=0 WHERE buyer_fee>0').run();
  }
  db.prepare('INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)').run([FLAG, new Date().toISOString()]);
  return { orders, added };
}

module.exports = { feeFor, saveFee, setUnitFee, foldUnitFees, unitsOf, productKeysOf };
