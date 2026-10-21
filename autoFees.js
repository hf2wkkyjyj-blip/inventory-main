'use strict';
// ─── FINDER FEE ON NEW ORDERS, FROM THE LAST ONE YOU SET ─────────────────────
//
// A fee is saved on each order. New orders of a product you've already paid a
// finder fee on used to start at $0 — you had to remember to type it again.
//
// Now each product remembers your last fee PER UNIT, PER STORE: the most
// recent order of it (at that store) whose fee you set yourself. Any order of
// that product with no fee gets it filled in automatically (units × that
// rate), marked fee_source='auto'. It's stored on the order like any other
// fee, so every card, tab and total sees it.
//
//   • An order whose fee you set yourself (✎, box fee, "same fee" on similar
//     orders) is never touched — even if you set it to $0.
//   • Change your fee on a newer order → every 'auto' order of that product at
//     that store follows the new rate.
//   • Auto fees never become the source of a rate (only fees you typed do).
//
// A store that charges for the WHOLE order (your latest fee there was counted
// that way, see feeRules.js) gets that same amount on a new order instead of a
// per-unit rate — the fee doesn't grow with the units.

const { orderLineCosts } = require('./itemView');
const { productNameFor } = require('./packageView');
const { itemKey } = require('./itemNames');

const norm = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase().replace(/\s+/g, ' ');
const r2 = n => Math.round(n * 100) / 100;
const DEAD = new Set(['Cancelled', 'Refunded']);
const isAuto = o => o.fee_source === 'auto';
const when = o => String(o.order_date || o.received_at || o.created_at || '');
// "Your last fee" = the one you typed most recently; older fees (before this
// was tracked) count by their order date.
const setAt = o => String(o.fee_set_at || when(o));

// Each line of an order: its product key and its share of the order's fee per unit.
function linesOf(o, catalog) {
  return orderLineCosts(o).map(l => ({
    key: itemKey(productNameFor(l.rawName, catalog)), name: productNameFor(l.rawName, catalog),
    qty: l.qty, perUnitFee: l.unitFinder,
  }));
}

/** "store|product" → { perUnit, order_id, order_number, date } from the latest fee you set. */
function typedFees(orders) {
  return orders.filter(o => !DEAD.has(o.status) && !isAuto(o) && Number(o.finder_fee) > 0)
    .sort((a, b) => setAt(a).localeCompare(setAt(b)) || (a.id || 0) - (b.id || 0));   // newest last → wins
}

/** store → { mode: 'order'|'unit', fee, order_number } from the latest fee you set there. */
function storeModes(orders) {
  const modes = new Map();
  for (const o of typedFees(orders)) {
    modes.set(norm(o.retailer), { mode: o.fee_mode === 'order' ? 'order' : 'unit', fee: r2(o.finder_fee), order_number: o.order_number || null });
  }
  return modes;
}

function feeRates(orders, catalog) {
  const rates = new Map();
  const src = typedFees(orders).filter(o => o.fee_mode !== 'order');   // a whole-order fee says nothing about a per-unit rate
  for (const o of src) {
    for (const l of linesOf(o, catalog)) {
      if (!(l.perUnitFee > 0)) continue;
      rates.set(`${norm(o.retailer)}|${l.key}`, { perUnit: r2(l.perUnitFee), order_id: o.id, order_number: o.order_number || null, date: when(o) });
    }
  }
  return rates;
}

/** What the auto fee for this order would be, or null if no line has a rate. */
function autoFeeFor(o, rates, catalog, modes) {
  const m = modes && modes.get(norm(o.retailer));
  if (m && m.mode === 'order') return { fee: m.fee, flat: true, used: [{ name: 'the whole order', qty: 1, perUnit: m.fee, from: m.order_number }] };
  let fee = 0; const used = [];
  for (const l of linesOf(o, catalog)) {
    const r = rates.get(`${norm(o.retailer)}|${l.key}`);
    if (!r) continue;
    fee += r.perUnit * l.qty;
    used.push({ name: l.name, qty: l.qty, perUnit: r.perUnit, from: r.order_number });
  }
  return used.length ? { fee: r2(fee), used } : null;
}

// Fills / updates auto fees. Returns how many orders changed.
function applyAutoFees(db, catalog) {
  let orders;
  try { orders = db.prepare('SELECT * FROM bot_orders').all(); } catch (_) { return 0; }
  const rates = feeRates(orders, catalog);
  const modes = storeModes(orders);
  let changed = 0;
  for (const o of orders) {
    if (DEAD.has(o.status)) continue;
    const eligible = isAuto(o) || (!o.fee_source && !(Number(o.finder_fee) > 0));
    if (!eligible) continue;
    const a = autoFeeFor(o, rates, catalog, modes);
    if (!a) continue;
    const mode = a.flat ? 'order' : 'unit';
    if (isAuto(o) && Math.abs((Number(o.finder_fee) || 0) - a.fee) < 0.005 && o.fee_mode === mode) continue;
    const units = a.flat ? 0 : linesOf(o, catalog).reduce((s, l) => s + l.qty, 0);
    db.prepare("UPDATE bot_orders SET finder_fee=?, fee_source='auto', fee_mode=?, fee_unit=? WHERE id=?")
      .run([a.fee, mode, a.flat || !units ? null : r2(a.fee / units), o.id]);
    changed++;
  }
  return changed;
}

module.exports = { feeRates, storeModes, autoFeeFor, applyAutoFees };
