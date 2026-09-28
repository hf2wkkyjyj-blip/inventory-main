'use strict';
// ─── BOX FEE SPLIT ───────────────────────────────────────────────────────────
//
// A buyer/finder fee is usually charged for a whole box ("$100 for this
// shipment"), not per unit. This spreads it over everything in the box by
// retail cost: the box's fee ÷ its retail value is one rate, and every item
// carries that rate × its own price. A $59.99 ETB carries more than a $14.99
// pack.
//
// Each order's share is stored in bot_orders.finder_fee. itemView.js already
// spreads an order's finder_fee over its items by price share, so
//   order share = fee × order retail / box retail
//   item share  = order share × item retail / order retail
//               = fee × item retail / box retail           ← the same rate
// and landed cost picks it up with no further changes.
//
// Orders with no item prices fall back to what was charged for goods
// (total − tax − ship). If nothing in the box has a value, split by units.

const { parseItemName, parseItemPrice, splitItemParts, itemKey, shortenName } = require('./itemNames');

const round2 = n => Math.round(n * 100) / 100;

function parseQty(str) {
  const m = String(str).match(/^(\d+)\s*[xX×]\s+/) || String(str).match(/\s+[xX×]\s*(\d+)$/);
  return m ? parseInt(m[1], 10) : 1;
}

function nameFor(raw, catalog) {
  const pid = catalog && catalog.aliases && catalog.aliases.get(itemKey(raw));
  if (pid && catalog.products.has(pid)) return catalog.products.get(pid).name;
  return shortenName(raw);
}

// Retail value and item lines of one order.
function orderValue(o) {
  let arr; try { arr = JSON.parse(o.items || '[]'); } catch (_) { arr = []; }
  const parts  = (Array.isArray(arr) ? arr : [arr]).flatMap(splitItemParts).filter(p => parseItemName(p));
  const prices = parts.map(parseItemPrice);
  const units  = parts.reduce((s, p) => s + parseQty(p), 0);
  const priced = prices.some(p => p !== null);
  const itemsValue = priced ? parts.reduce((s, p, i) => s + (prices[i] || 0) * parseQty(p), 0) : 0;
  const goods = Math.max(0, (Number(o.order_total) || 0) - (Number(o.tax_amount) || 0) - (Number(o.ship_cost) || 0));
  return { parts, prices, units, priced, value: priced ? itemsValue : goods };
}

/**
 * @param {object[]} orders  bot_orders rows in the box
 * @param {number}   fee     total fee for the box
 * @returns {{ fee, retail, rate, basis, orders: {id, order_number, retail, fee}[],
 *             items: {name, qty, retail, fee, perUnit}[] }}
 */
function splitBoxFee(orders, fee, catalog) {
  fee = round2(Math.max(0, Number(fee) || 0));
  const vals   = orders.map(orderValue);
  const retail = vals.reduce((s, v) => s + v.value, 0);
  const units  = vals.reduce((s, v) => s + v.units, 0);
  const basis  = retail > 0 ? 'retail' : 'units';
  const weight = i => basis === 'retail' ? vals[i].value : vals[i].units;
  const total  = basis === 'retail' ? retail : units;

  // Per order, in cents; the rounding remainder goes to the biggest order so
  // the shares always add up to exactly the fee typed.
  const out = orders.map((o, i) => ({
    id: o.id, order_number: o.order_number || null,
    retail: round2(vals[i].value),
    fee: total > 0 ? round2(fee * weight(i) / total) : 0,
  }));
  if (out.length && total > 0) {
    const diff = round2(fee - out.reduce((s, x) => s + x.fee, 0));
    if (diff) {
      const big = out.reduce((b, x, i) => (weight(i) > weight(b) ? i : b), 0);
      out[big].fee = round2(out[big].fee + diff);
    }
  }

  // Per item, for the preview — the same way itemView.js spreads each
  // order's share (by price if the order has prices, else per unit).
  const items = new Map();
  orders.forEach((o, i) => {
    const v = vals[i];
    const share = out[i].fee;
    v.parts.forEach((p, j) => {
      const qty  = parseQty(p);
      const unitPrice = v.prices[j];
      const itemRetail = v.priced ? (unitPrice || 0) * qty : (v.units ? v.value * qty / v.units : 0);
      const itemFee = v.priced
        ? (v.value > 0 ? share * ((unitPrice || 0) * qty) / v.value : 0)
        : (v.units ? share * qty / v.units : 0);
      const name = nameFor(parseItemName(p), catalog);
      const k = itemKey(name);
      const it = items.get(k) || { name, qty: 0, retail: 0, fee: 0 };
      it.qty += qty; it.retail += itemRetail; it.fee += itemFee;
      items.set(k, it);
    });
  });

  return {
    fee,
    retail: round2(retail),
    rate: basis === 'retail' && retail > 0 ? fee / retail : null,
    basis,
    orders: out,
    items: [...items.values()]
      .map(it => ({ ...it, retail: round2(it.retail), fee: round2(it.fee), perUnit: it.qty ? round2(it.fee / it.qty) : 0 }))
      .sort((a, b) => b.fee - a.fee || a.name.localeCompare(b.name)),
  };
}

// "Same order" fingerprint for copying a fee: same store, same items, same
// quantities. Prices, dates and addresses don't matter — a drop of 26 identical
// Mattel orders all match. Returns null for an order with no items.
function orderSignature(o) {
  let arr; try { arr = JSON.parse(o.items || '[]'); } catch (_) { arr = []; }
  const qty = new Map();
  for (const p of (Array.isArray(arr) ? arr : [arr]).flatMap(splitItemParts)) {
    const name = parseItemName(p);
    if (!name) continue;
    const k = itemKey(name);
    qty.set(k, (qty.get(k) || 0) + parseQty(p));
  }
  if (!qty.size) return null;
  const store = String(o.retailer || '').trim().toLowerCase();
  return store + '|' + [...qty.entries()].sort().map(([k, n]) => `${n}x${k}`).join(';');
}

module.exports = { splitBoxFee, orderValue, orderSignature };
