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

const productSkuKey = id => `#p${id}`;

function parseQty(str) {
  const m = str.match(/^(\d+)\s*[xX×]\s+/) || str.match(/\s+[xX×]\s*(\d+)$/);
  return m ? parseInt(m[1], 10) : 1;
}

const round2 = n => Math.round(n * 100) / 100;

/**
 * @param {object[]} orders       bot_orders rows
 * @param {object[]} pricingRows  bot_sku_prices rows
 * @param {{products: Map, aliases: Map}} [catalog]  from skuCatalog.loadCatalog()
 */
function computeItemGroups(orders, pricingRows, catalog) {
  const products = (catalog && catalog.products) || new Map();
  const aliases  = (catalog && catalog.aliases)  || new Map();

  const groups = {};

  for (const order of orders) {
    let arr; try { arr = JSON.parse(order.items || '[]'); } catch (_) { arr = []; }
    const expanded = (Array.isArray(arr) ? arr : [arr]).flatMap(splitItemParts);
    if (!expanded.length) continue;

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

      // ── Which product is this? ────────────────────────────────────────────
      const pid = aliases.get(itemKey(rawName));
      let key, display, productId = null;
      if (pid && products.has(pid)) {
        productId = pid;
        key       = `p:${pid}`;
        display   = products.get(pid).name;
      } else {
        display = shortenName(rawName);
        key     = `u:${itemKey(display)}`;
      }

      let g = groups[key];
      if (!g) {
        g = groups[key] = {
          name: display, productId, unlinked: !productId,
          qty: 0, statuses: {}, addresses: [], retailers: [],
          _rawNames: new Map(),       // itemKey → the store title as seen
          _orderIds: new Set(),
          _sumItem: 0, _sumTax: 0, _sumShip: 0, _sumFinder: 0, _sumTotal: 0,
          _taxEstUnits: 0, _unknownCostUnits: 0,
        };
      } else if (!productId && /[^\x00-\x7F]/.test(display) && !/[^\x00-\x7F]/.test(g.name)) {
        g.name = display;   // prefer the retailer's proper "Pokémon" spelling
      }

      const rk = itemKey(rawName);
      if (!g._rawNames.has(rk)) g._rawNames.set(rk, rawName);
      g._orderIds.add(order.id != null ? order.id : `${order.order_number}|${idx}`);

      if (taxEstimated) g._taxEstUnits      += qty;
      if (!costKnown)   g._unknownCostUnits += qty;
      g.qty        += qty;
      g._sumItem   += unitItem   * qty;
      g._sumTax    += unitTax    * qty;
      g._sumShip   += unitShip   * qty;
      g._sumFinder += unitFinder * qty;
      g._sumTotal  += unitTotal  * qty;

      const st = order.status || 'Confirmed';
      g.statuses[st] = (g.statuses[st] || 0) + qty;
      if (order.shipping_address) g.addresses.push(order.shipping_address);
      if (order.retailer && !g.retailers.includes(order.retailer)) g.retailers.push(order.retailer);
    }
  }

  // Saved buyer fee / sale price. Linked products keep theirs under "#p<id>" so a
  // rename can't orphan them; prices typed before linking were saved under the
  // store title, so fall back to that.
  const pricing = {};
  (pricingRows || []).forEach(r => { if (r && r.sku) pricing[itemKey(r.sku)] = r; });

  return Object.values(groups).map(g => {
    const rawNames = [...g._rawNames.values()];
    const skuKey   = g.productId ? productSkuKey(g.productId) : rawNames[0];
    const p = pricing[itemKey(skuKey)]
           || rawNames.map(n => pricing[itemKey(n)]).find(Boolean)
           || pricing[itemKey(g.name)]
           || {};

    const qty = g.qty || 1;
    const {
      _rawNames, _orderIds, _sumItem, _sumTax, _sumShip, _sumFinder, _sumTotal,
      _taxEstUnits, _unknownCostUnits, ...rest
    } = g;

    return {
      ...rest,
      rawNames, skuKey,
      orders:        _orderIds.size,
      perUnitItem:   round2(_sumItem   / qty),
      perUnitTax:    round2(_sumTax    / qty),
      perUnitShip:   round2(_sumShip   / qty),
      perUnitFinder: round2(_sumFinder / qty),
      perUnitTotal:  round2(_sumTotal  / qty),
      taxEstimated:  _taxEstUnits > 0,
      costUnknown:   _unknownCostUnits === g.qty,
      buyer_fee:     p.buyer_fee  || 0,
      sale_price:    p.sale_price || 0,
    };
  }).sort((a, b) => (a.unlinked === b.unlinked ? a.name.localeCompare(b.name) : (a.unlinked ? 1 : -1)));
}

module.exports = { computeItemGroups };
