'use strict';
// ─── ITEM VIEW AGGREGATION ───────────────────────────────────────────────────
// Turns bot_orders rows into ONE ROW PER PRODUCT with weighted per-unit landed
// cost (item / tax / ship / finder).
//
// "Product" is resolved through the SKU catalog (skuCatalog.js):
//   • a store title linked to a product groups under that product's short name;
//   • an unlinked title groups under its suggested short name and is flagged, so
//     the user can confirm or correct it.
// Order data is never rewritten — grouping is recomputed from the links on every
// load, which is what makes an edit regroup everything immediately.

const { parseItemName, parseItemPrice, splitItemParts, itemKey, shortenName } = require('./itemNames');
const { carrierOf, trackingUrl } = require('./carriers');

const productSkuKey = id => `#p${id}`;

function parseQty(str) {
  const m = str.match(/^(\d+)\s*[xX×]\s+/) || str.match(/\s+[xX×]\s*(\d+)$/);
  return m ? parseInt(m[1], 10) : 1;
}

const round2 = n => Math.round(n * 100) / 100;

/**
 * Per-unit landed cost of each item line in ONE order: item + share of tax,
 * shipping and the order's finder fee. The single source for these numbers —
 * the product view and the claims list both use it.
 * Returns an array of lines, with .taxEstimated / .costKnown set on the array.
 */
function orderLineCosts(order) {
  let arr; try { arr = JSON.parse(order.items || '[]'); } catch (_) { arr = []; }
  const expanded = (Array.isArray(arr) ? arr : [arr]).flatMap(splitItemParts);
  const out = [];
  if (!expanded.length) return out;

  // ── Order-level cost components ─────────────────────────────────────────
  const orderTotal = Number(order.order_total) || 0;
  let   taxAmount  = Number(order.tax_amount)  || 0;
  const shipCost   = Number(order.ship_cost)   || 0;
  const finderFee  = Number(order.finder_fee)  || 0;

  const itemPrices    = expanded.map(parseItemPrice);
  const hasPrices     = itemPrices.some(p => p !== null);
  const itemsValue    = hasPrices ? expanded.reduce((s, it, i) => s + (itemPrices[i] || 0) * parseQty(it), 0) : 0;
  const priceSubtotal = hasPrices ? (itemsValue || 1) : null;
  const totalOrderQty = expanded.reduce((s, it) => s + parseQty(it), 0) || 1;

  // Tax often never got stored as tax_amount (baseline imports don't carry it,
  // some emails hide it from the extractor) — yet the charged total proves it
  // was paid: $65.09 for 2 × $29.99 means $5.11 of tax. Recover the remainder,
  // but only when it's positive and at most 25% of the goods; anything larger
  // means the stored total is wrong and calling it tax would be inventing it.
  let taxEstimated = false;
  if (!taxAmount && hasPrices && orderTotal > 0 && itemsValue > 0) {
    const remainder = round2(orderTotal - itemsValue - shipCost);
    if (remainder > 0.009 && remainder <= itemsValue * 0.25) {
      taxAmount    = remainder;
      taxEstimated = true;
    }
  }
  const costKnown = hasPrices || orderTotal > 0;

  for (let idx = 0; idx < expanded.length; idx++) {
    const s       = expanded[idx];
    const rawName = parseItemName(s);
    const qty     = parseQty(s);
    const iPrice  = itemPrices[idx];

    let unitItem, unitTax, unitShip, unitFinder;
    if (hasPrices && priceSubtotal && iPrice !== null) {
      const share = (iPrice * qty) / priceSubtotal;
      unitItem   = iPrice;
      unitTax    = (taxAmount * share) / qty;
      unitShip   = (shipCost  * share) / qty;
      unitFinder = (finderFee * share) / qty;
    } else {
      // order_total is what was CHARGED, so it already contains tax and
      // shipping — take them out of the item portion or they count twice.
      const goods = Math.max(0, orderTotal - taxAmount - shipCost);
      unitItem   = goods     / totalOrderQty;
      unitTax    = taxAmount / totalOrderQty;
      unitShip   = shipCost  / totalOrderQty;
      unitFinder = finderFee / totalOrderQty;
    }
    const unitTotal = unitItem + unitTax + unitShip + unitFinder;
    out.push({ rawName, qty, iPrice, unitItem, unitTax, unitShip, unitFinder, unitTotal });
  }
  out.taxEstimated = taxEstimated;
  out.costKnown    = costKnown;
  return out;
}

/**
 * @param {object[]} orders       bot_orders rows
 * @param {object[]} pricingRows  bot_sku_prices rows
 * @param {{products: Map, aliases: Map}} [catalog]  from skuCatalog.loadCatalog()
 * @param {object[]} [salesRows]  bot_sales rows (partial sales, keyed by skuKey)
 * @param {{checkedIn: Map|Set, issues: object[], adjustments: object[]}} [stock]
 *        Pick-up check-ins, claims and stock-count corrections. When given,
 *        stock ("in hand") counts only units you've picked up and confirmed
 *        (plus/minus count corrections); without it every unit counts.
 */
function computeItemGroups(orders, pricingRows, catalog, salesRows, stock) {
  const products = (catalog && catalog.products) || new Map();
  const aliases  = (catalog && catalog.aliases)  || new Map();

  const groups = {};

  // Store title → product (linked name, or the suggested short name).
  const productFor = rawName => {
    const pid = aliases.get(itemKey(rawName));
    if (pid && products.has(pid)) return { key: `p:${pid}`, display: products.get(pid).name, productId: pid };
    const display = shortenName(rawName);
    return { key: `u:${itemKey(display)}`, display, productId: null };
  };
  const groupFor = ({ key, display, productId }) => {
    let g = groups[key];
    if (!g) {
      g = groups[key] = {
        name: display, productId, unlinked: !productId,
        qty: 0, statuses: {}, addresses: [], retailers: [], categories: [],
        _rawNames: new Map(),       // itemKey → the store title as seen
        _orderIds: new Set(),
        _lines:    new Map(),       // order id → this product's line in that order
        _sumItem: 0, _sumTax: 0, _sumShip: 0, _sumFinder: 0, _sumTotal: 0,
        _taxEstUnits: 0, _unknownCostUnits: 0,
        inHand: 0, toPickUp: 0, onTheWay: 0, inClaim: 0, _claimValue: 0, writtenOff: 0, refundedUnits: 0,
        _batches: [],               // { date, qty, c:{item,tax,ship,fee} } picked-up units at THEIR cost (FIFO)
      };
    } else if (!productId && /[^\x00-\x7F]/.test(display) && !/[^\x00-\x7F]/.test(g.name)) {
      g.name = display;   // prefer the retailer's proper "Pokémon" spelling
    }
    return g;
  };

  // ── Pick-up / claims ────────────────────────────────────────────────────
  const tracked   = !!stock;
  const checkedIn = (stock && stock.checkedIn) || new Set();
  const issuesAt  = new Map();                 // "orderId|itemKey" → issues
  for (const is of (stock && stock.issues) || []) {
    const k = `${is.order_id}|${is.item_key}`;
    if (!issuesAt.has(k)) issuesAt.set(k, []);
    issuesAt.get(k).push(is);
  }
  const OPEN = new Set(['open', 'claim_filed']);
  const kept = [];                             // wrong items kept after a denied claim

  for (const order of orders) {
    const lines = orderLineCosts(order);
    if (!lines.length) continue;
    const { taxEstimated, costKnown } = lines;

    for (let idx = 0; idx < lines.length; idx++) {
      const { rawName, qty, unitItem, unitTax, unitShip, unitFinder, unitTotal } = lines[idx];

      // ── Which product is this? ────────────────────────────────────────────
      const g = groupFor(productFor(rawName));

      const rk = itemKey(rawName);
      if (!g._rawNames.has(rk)) g._rawNames.set(rk, rawName);
      const oKey = order.id != null ? order.id : `${order.order_number}|${idx}`;
      g._orderIds.add(oKey);

      // Per-order detail, so a product row can be expanded to show every order
      // behind it — tracking number, carrier link, status, dates, ship-to.
      const line = g._lines.get(oKey);
      if (line) line.qty += qty;                 // same product twice in one order
      else g._lines.set(oKey, {
        id:              order.id ?? null,
        order_number:    order.order_number || null,
        retailer:        order.retailer || null,
        status:          order.status || 'Confirmed',
        qty,
        tracking:        order.tracking || null,
        carrier:         carrierOf(order.tracking),
        trackUrl:        trackingUrl(order.tracking),
        tracking_status: order.tracking_status || null,
        expected_date:   order.expected_date || null,
        delivered_date:  order.delivered_date || null,
        order_date:      order.order_date || null,
        shipping_name:   order.shipping_name || null,
        shipping_address: order.shipping_address || null,
        jig_address:     order.jig_address || null,      // the exact text on the label, when grouped
        checked_in:      tracked ? (order.id != null && checkedIn.has(order.id)) : null,
      });

      if (taxEstimated) g._taxEstUnits      += qty;
      if (!costKnown)   g._unknownCostUnits += qty;
      g.qty        += qty;
      g._sumItem   += unitItem   * qty;
      g._sumTax    += unitTax    * qty;
      g._sumShip   += unitShip   * qty;
      g._sumFinder += unitFinder * qty;
      g._sumTotal  += unitTotal  * qty;

      // ── Where are these units? ────────────────────────────────────────────
      // Checked in = picked up and opened; minus anything missing, wrong or
      // damaged (those sit in a claim, or were refunded / written off).
      // Not checked in: delivered → waiting to be picked up; else on the way.
      if (!tracked) {
        g.inHand += qty;
      } else if (order.id != null && checkedIn.has(order.id)) {
        let out = 0;
        for (const is of issuesAt.get(`${order.id}|${rk}`) || []) {
          const n = Math.min(Number(is.qty) || 0, qty - out);
          if (n <= 0) continue;
          if (is.status === 'denied_keep' && is.kind !== 'wrong' && is.kind !== 'missing') continue;  // damaged, kept → still stock
          out += n;
          if (OPEN.has(is.status))            { g.inClaim += n; g._claimValue += n * unitTotal; }
          else if (is.status === 'refunded')  g.refundedUnits += n;
          else if (is.status === 'denied_writeoff' || (is.status === 'denied_keep' && is.kind === 'missing')) g.writtenOff += n;
          else if (is.status === 'denied_keep' && is.kind === 'wrong' && is.got_item) {
            kept.push({ got: is.got_item, qty: n, unitItem, unitTax, unitShip, unitFinder, unitTotal, order });
          }
        }
        g.inHand += Math.max(0, qty - out);
        if (qty - out > 0) g._batches.push({ date: (checkedIn.get && checkedIn.get(order.id)) || null, qty: qty - out,
                                             c: { item: unitItem, tax: unitTax, ship: unitShip, fee: unitFinder } });
      } else if (order.status === 'Delivered' || order.tracking_status === 'Delivered') {
        g.toPickUp += qty;
      } else {
        g.onTheWay += qty;
      }

      const st = order.status || 'Confirmed';
      g.statuses[st] = (g.statuses[st] || 0) + qty;
      if (order.shipping_address) g.addresses.push(order.shipping_address);
      if (order.retailer && !g.retailers.includes(order.retailer)) g.retailers.push(order.retailer);
      const cat = order.category || 'Other';
      if (!g.categories.includes(cat)) g.categories.push(cat);
    }
  }

  // A wrong item you kept (claim denied): it joins the product it really is, at
  // what you paid for the item you ordered — so its profit is real when sold.
  for (const k of kept) {
    const g = groupFor(productFor(k.got));
    const rk = itemKey(k.got);
    if (!g._rawNames.has(rk)) g._rawNames.set(rk, k.got);
    g.qty        += k.qty;
    g.inHand     += k.qty;
    g._batches.push({ date: null, qty: k.qty, c: { item: k.unitItem, tax: k.unitTax, ship: k.unitShip, fee: k.unitFinder } });
    g._sumItem   += k.unitItem   * k.qty;
    g._sumTax    += k.unitTax    * k.qty;
    g._sumShip   += k.unitShip   * k.qty;
    g._sumFinder += k.unitFinder * k.qty;
    g._sumTotal  += k.unitTotal  * k.qty;
    g.statuses.Kept = (g.statuses.Kept || 0) + k.qty;
    if (k.order.retailer && !g.retailers.includes(k.order.retailer)) g.retailers.push(k.order.retailer);
  }

  // Saved buyer fee / sale price. Linked products keep theirs under "#p<id>" so a
  // rename can't orphan them; prices typed before linking were saved under the
  // store title, so fall back to that.
  const pricing = {};
  (pricingRows || []).forEach(r => { if (r && r.sku) pricing[itemKey(r.sku)] = r; });

  // Sales and stock-count corrections, bucketed by the key they were recorded under.
  const bucket = rows => {
    const m = new Map();
    for (const r of rows || []) {
      if (!r || !r.sku_key) continue;
      const k = itemKey(r.sku_key);
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(r);
    }
    return m;
  };
  const salesByKey = bucket(salesRows);
  const adjByKey   = bucket(stock && stock.adjustments);

  return Object.values(groups).map(g => {
    const rawNames = [...g._rawNames.values()];
    const skuKey   = g.productId ? productSkuKey(g.productId) : rawNames[0];
    const p = pricing[itemKey(skuKey)]
           || rawNames.map(n => pricing[itemKey(n)]).find(Boolean)
           || pricing[itemKey(g.name)]
           || {};

    const qty = g.qty || 1;
    const {
      _rawNames, _orderIds, _lines, _sumItem, _sumTax, _sumShip, _sumFinder, _sumTotal,
      _taxEstUnits, _unknownCostUnits, _claimValue, _batches, ...rest
    } = g;

    // Soonest-arriving first; anything already delivered sinks to the bottom.
    const orderLines = [..._lines.values()].sort((a, b) => {
      const ad = a.status === 'Delivered', bd = b.status === 'Delivered';
      if (ad !== bd) return ad ? 1 : -1;
      return String(a.expected_date || '9999').localeCompare(String(b.expected_date || '9999'))
          || String(a.order_number || '').localeCompare(String(b.order_number || ''));
    });

    const perUnitTotal = round2(_sumTotal / qty + (Number(p.buyer_fee) || 0));

    // ── Sales ────────────────────────────────────────────────────────────────
    // Recorded under the product key, or under a store title before it was
    // linked. Each sale is counted once even if several keys point at it.
    const seenSale = new Set();
    const sales = [skuKey, ...rawNames].flatMap(k => salesByKey.get(itemKey(k)) || [])
      .filter(r => {
        if (r.id == null) return true;
        if (seenSale.has(r.id)) return false;
        seenSale.add(r.id); return true;
      })
      .map(r => ({
        id: r.id ?? null, qty: Number(r.qty) || 0, unit_price: Number(r.unit_price) || 0,
        fees: Number(r.fees) || 0, channel: r.channel || null, sold_at: r.sold_at || null,
      }))
      .sort((a, b) => String(b.sold_at || '').localeCompare(String(a.sold_at || '')) || (b.id || 0) - (a.id || 0));
    const soldQty    = sales.reduce((s, r) => s + r.qty, 0);
    const soldGross  = sales.reduce((s, r) => s + r.qty * r.unit_price, 0);
    const soldFees   = sales.reduce((s, r) => s + r.fees, 0);
    // ── Stock-count corrections ─────────────────────────────────────────────
    // Counted fewer than expected → units gone (a loss at landed cost);
    // counted more → units found. Same key rules as sales, each row once.
    const seenAdj = new Set();
    const adjustments = [skuKey, ...rawNames].flatMap(k => adjByKey.get(itemKey(k)) || [])
      .filter(r => (r.id == null) || (!seenAdj.has(r.id) && seenAdj.add(r.id)));
    const shortUnits = adjustments.reduce((s, r) => s + Math.max(0, -Number(r.qty) || 0), 0);
    const extraUnits = adjustments.reduce((s, r) => s + Math.max(0, Number(r.qty) || 0), 0);
    const countLoss  = adjustments.reduce((s, r) => s + (Number(r.qty) < 0 ? -Number(r.qty) * (Number(r.unit_cost) || 0) : 0), 0);
    const inHand     = tracked ? Math.max(0, g.inHand + extraUnits - shortUnits) : g.inHand;

    // What you can still sell: units in hand (when pick-ups are tracked).
    const unitsLeft  = Math.max(0, (tracked ? inHand : g.qty) - soldQty);

    // ── Real cost per unit, oldest first (FIFO) ──────────────────────────────
    // Each checked-in box is a batch at ITS order's cost (item + tax + ship +
    // finder fee) plus any extra per-unit fee. Sales use up the oldest units
    // first, so a sale's cost is what those units really cost; what's left is
    // valued at the real cost of the units still on the shelf. Units found in a
    // count join at the average. Without pick-up tracking: the average.
    const extra = Number(p.buyer_fee) || 0;
    const avgC = { item: _sumItem / qty, tax: _sumTax / qty, ship: _sumShip / qty, fee: _sumFinder / qty };
    const queue = [..._batches].sort((a, b) => String(a.date || '0000').localeCompare(String(b.date || '0000')))
      .map(b => ({ ...b }));
    if (extraUnits) queue.push({ date: null, qty: extraUnits, c: avgC });
    const unitCost = c => c.item + c.tax + c.ship + c.fee + extra;
    const take = n => {                      // cost of the next n units, oldest first
      let cost = 0;
      while (n > 0 && queue.length) {
        const b = queue[0], t = Math.min(n, b.qty);
        cost += t * unitCost(b.c); b.qty -= t; n -= t;
        if (!b.qty) queue.shift();
      }
      return cost + n * perUnitTotal;        // more sold than recorded in hand → average
    };
    if (tracked) {
      [...sales].sort((a, b) => String(a.sold_at || '').localeCompare(String(b.sold_at || '')) || (a.id || 0) - (b.id || 0))
        .forEach(sl => { sl.cost = round2(take(sl.qty)); });
      if (shortUnits) take(shortUnits);
    } else {
      sales.forEach(sl => { sl.cost = round2(sl.qty * perUnitTotal); });
    }
    const soldCost = sales.reduce((a, sl) => a + sl.cost, 0);
    const left = tracked ? queue.filter(b => b.qty > 0) : [];
    const leftUnits = left.reduce((a, b) => a + b.qty, 0);
    const sumLeft = k => left.reduce((a, b) => a + b.qty * b.c[k], 0);
    const stockAtCost = tracked ? left.reduce((a, b) => a + b.qty * unitCost(b.c), 0) : unitsLeft * perUnitTotal;
    // Breakdown of what's on the shelf (per unit), for the click popup.
    const stockUnit = leftUnits ? {
      item: round2(sumLeft('item') / leftUnits), tax: round2(sumLeft('tax') / leftUnits),
      ship: round2(sumLeft('ship') / leftUnits), fee: round2(sumLeft('fee') / leftUnits + extra),
      total: round2(stockAtCost / leftUnits),
    } : null;
    const oldestInStock = unitsLeft && left.length ? left[0].date : null;
    const asking     = Number(p.sale_price) || 0;

    return {
      ...rest,
      rawNames, skuKey,
      stockTracked: tracked,
      inHand,
      shortUnits, extraUnits,
      countLoss:     round2(countLoss),
      oldestInStock,
      // At real cost — what's still unsold (FIFO), and where the rest is.
      stockAtCost:    round2(stockAtCost),
      stockUnit,
      toPickUpCost:   round2((g.toPickUp || 0) * perUnitTotal),
      onTheWayCost:   round2((g.onTheWay || 0) * perUnitTotal),
      claimValue: round2(_claimValue),
      sales,
      soldQty,
      soldGross:      round2(soldGross),
      soldFees:       round2(soldFees),
      avgSalePrice:   soldQty ? round2(soldGross / soldQty) : null,
      // What the sold units actually made after their fees and their landed cost.
      soldCost:       round2(soldCost),
      realizedProfit: soldQty ? round2(soldGross - soldFees - soldCost) : null,
      // Return on what the sold units really cost you, e.g. 0.4 = 40%.
      realizedROI: soldQty && soldCost > 0
        ? Math.round((soldGross - soldFees - soldCost) / soldCost * 10000) / 10000 : null,
      unitsLeft,
      // What the rest would make at the asking price (before any selling fees).
      expectedProfitLeft: asking > 0 && unitsLeft > 0 ? round2(unitsLeft * (asking - perUnitTotal)) : null,
      orders:        _orderIds.size,
      orderLines,
      trackingCount: orderLines.filter(l => l.tracking).length,
      perUnitItem:   round2(_sumItem   / qty),
      perUnitTax:    round2(_sumTax    / qty),
      perUnitShip:   round2(_sumShip   / qty),
      // The per-unit fee typed in the product row (stored as buyer_fee) is a
      // real cost of each unit — it belongs IN landed cost. It used to be
      // subtracted only when showing profit, so typing $8 changed nothing in
      // the landed figure or its breakdown. It's folded into the Finder line,
      // alongside any per-order finder fee spread across the units.
      perUnitFinder: round2(_sumFinder / qty + (Number(p.buyer_fee) || 0)),
      perUnitTotal,
      perUnitFeeTyped: Number(p.buyer_fee) || 0,
      // The part of the finder fee that came from order/box fees (not typed per unit).
      perUnitBoxFee: round2(_sumFinder / qty),
      taxEstimated:  _taxEstUnits > 0,
      costUnknown:   _unknownCostUnits === g.qty,
      buyer_fee:     p.buyer_fee  || 0,
      sale_price:    p.sale_price || 0,
    };
  }).sort((a, b) => (a.unlinked === b.unlinked ? a.name.localeCompare(b.name) : (a.unlinked ? 1 : -1)));
}

module.exports = { computeItemGroups, orderLineCosts };
