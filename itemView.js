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
 * @param {{checkedIn: Map|Set, issues: object[]}} [stock]
 *        Pick-up check-ins and claims. When given, stock ("in hand") counts only
 *        units you've picked up and confirmed; without it every unit counts.
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
        qty: 0, statuses: {}, addresses: [], retailers: [],
        _rawNames: new Map(),       // itemKey → the store title as seen
        _orderIds: new Set(),
        _lines:    new Map(),       // order id → this product's line in that order
        _sumItem: 0, _sumTax: 0, _sumShip: 0, _sumFinder: 0, _sumTotal: 0,
        _taxEstUnits: 0, _unknownCostUnits: 0,
        inHand: 0, toPickUp: 0, onTheWay: 0, inClaim: 0, _claimValue: 0, writtenOff: 0, refundedUnits: 0,
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
      } else if (order.status === 'Delivered' || order.tracking_status === 'Delivered') {
        g.toPickUp += qty;
      } else {
        g.onTheWay += qty;
      }

      const st = order.status || 'Confirmed';
      g.statuses[st] = (g.statuses[st] || 0) + qty;
      if (order.shipping_address) g.addresses.push(order.shipping_address);
      if (order.retailer && !g.retailers.includes(order.retailer)) g.retailers.push(order.retailer);
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

  // Sales, bucketed by the key they were recorded under.
  const salesByKey = new Map();
  for (const r of salesRows || []) {
    if (!r || !r.sku_key) continue;
    const k = itemKey(r.sku_key);
    if (!salesByKey.has(k)) salesByKey.set(k, []);
    salesByKey.get(k).push(r);
  }

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
      _taxEstUnits, _unknownCostUnits, _claimValue, ...rest
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
    // What you can still sell: units in hand (when pick-ups are tracked).
    const unitsLeft  = Math.max(0, (tracked ? g.inHand : g.qty) - soldQty);
    const asking     = Number(p.sale_price) || 0;

    return {
      ...rest,
      rawNames, skuKey,
      stockTracked: tracked,
      claimValue: round2(_claimValue),
      sales,
      soldQty,
      soldGross:      round2(soldGross),
      soldFees:       round2(soldFees),
      avgSalePrice:   soldQty ? round2(soldGross / soldQty) : null,
      // What the sold units actually made after their fees and their landed cost.
      realizedProfit: soldQty ? round2(soldGross - soldFees - soldQty * perUnitTotal) : null,
      // Return on what the sold units cost you (landed), e.g. 0.4 = 40%.
      realizedROI: soldQty && perUnitTotal > 0
        ? Math.round((soldGross - soldFees - soldQty * perUnitTotal) / (soldQty * perUnitTotal) * 10000) / 10000 : null,
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
