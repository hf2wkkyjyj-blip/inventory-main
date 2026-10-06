'use strict';
// ─── PACKAGE VIEW ────────────────────────────────────────────────────────────
//
// Tracking belongs to a PACKAGE, not a product. One Pokemon Center order can
// hold an ETB, a Knock Out Collection and two Tech Sticker sets in a single box
// with one tracking number — the product view listed that box four times.
// Here each tracking number is one row, with its contents listed.
//
// Orders with no tracking yet each stand as their own row.
//
// A package whose orders ship to DIFFERENT addresses is flagged: one box can't
// go to two places, so that's almost certainly a tracking number the scraper
// attached to the wrong order. Bulk actions must not treat it as routine.

const { parseItemName, splitItemParts, itemKey, shortenName } = require('./itemNames');
const { carrierOf, trackingUrl, CARRIER_LABEL } = require('./carriers');

const RANK = { Confirmed: 1, Unship: 1, Shipped: 2, OFD: 3, Delivered: 4, Cancelled: 5, Refunded: 5 };

function parseQty(str) {
  const m = String(str).match(/^(\d+)\s*[xX×]\s+/) || String(str).match(/\s+[xX×]\s*(\d+)$/);
  return m ? parseInt(m[1], 10) : 1;
}

// Addresses are compared loosely: "Rm 4" vs "Room 4", commas, spacing.
function addressKey(a) {
  return String(a || '').toLowerCase()
    .replace(/\b(room|rm)\b/g, 'rm').replace(/\b(apartment|apt)\b/g, 'apt')
    .replace(/\b(avenue|ave)\b/g, 'ave').replace(/\b(north|n)\b/g, 'n')
    .replace(/[^a-z0-9]/g, '');
}

// Same short product name the item view shows — linked product name if the
// store title is in the catalog, else the suggested short name.
function productNameFor(rawTitle, catalog) {
  const pid = catalog && catalog.aliases && catalog.aliases.get(itemKey(rawTitle));
  if (pid && catalog.products.has(pid)) return catalog.products.get(pid).name;
  return shortenName(rawTitle);
}

/**
 * @param {object[]} orders   bot_orders rows
 * @param {{products: Map, aliases: Map}} [catalog]
 * @param {{checkedIn: Map}} [stock]  pick-up check-ins (order id → date)
 * @returns package rows, soonest-arriving first
 */
function computePackages(orders, catalog, stock) {
  const checkedIn = (stock && stock.checkedIn) || new Map();
  const pkgs = new Map();

  for (const o of orders) {
    const tracking = String(o.tracking || '').replace(/\s+/g, '');
    const key = tracking ? `t:${tracking.toUpperCase()}` : `o:${o.id}`;

    let p = pkgs.get(key);
    if (!p) {
      p = {
        key, tracking: tracking || null,
        carrier:  carrierOf(tracking),
        carrierLabel: CARRIER_LABEL[carrierOf(tracking)] || null,
        trackUrl: trackingUrl(tracking),
        orders: [], _contents: new Map(),
      };
      pkgs.set(key, p);
    }

    // Each order's item lines, for the pick-up check-in (what should be inside).
    const lines = [];
    p.orders.push({
      id: o.id, order_number: o.order_number || null, retailer: o.retailer || null,
      checked_in: checkedIn.has(o.id), checked_at: checkedIn.get ? (checkedIn.get(o.id) || null) : null,
      lines,
      status: o.status || 'Confirmed', tracking_status: o.tracking_status || null,
      expected_date: o.expected_date || null, delivered_date: o.delivered_date || null,
      order_date: o.order_date || null, finder_fee: Number(o.finder_fee) || 0,
      shipping_name: o.shipping_name || null, shipping_address: o.shipping_address || null,
      jig_address: o.jig_address || null,
      owner: o.owner || null,
      partner_id: o.partner_id || null, partner_name: o.partner_name || null,
      partner_check_name: o.partner_check_name || null,
    });

    let arr; try { arr = JSON.parse(o.items || '[]'); } catch (_) { arr = []; }
    for (const part of (Array.isArray(arr) ? arr : [arr]).flatMap(splitItemParts)) {
      const raw  = parseItemName(part);
      if (!raw) continue;
      const name = productNameFor(raw, catalog);
      const k    = itemKey(name);
      const lk   = itemKey(raw);
      const ln   = lines.find(l => l.item_key === lk);
      if (ln) ln.qty += parseQty(part);
      else lines.push({ item_key: lk, item_name: raw, name, qty: parseQty(part), cost: (o._lineCosts && o._lineCosts[lk]) || null });
      const c    = p._contents.get(k);
      if (c) c.qty += parseQty(part);
      else p._contents.set(k, { name, qty: parseQty(part) });
    }
  }

  const out = [...pkgs.values()].map(p => {
    const { _contents, ...rest } = p;

    // A package is only as far along as its least-advanced order.
    const effective = o => (o.tracking_status === 'OFD' && o.status === 'Shipped') ? 'OFD'
                         : (o.tracking_status === 'Delivered' && o.status === 'Shipped') ? 'Delivered'
                         : o.status;
    const statuses  = p.orders.map(effective);
    const status    = statuses.reduce((a, b) => ((RANK[b] || 0) < (RANK[a] || 0) ? b : a), statuses[0]);

    const exp  = p.orders.map(o => o.expected_date).filter(Boolean).sort()[0] || null;
    const dlv  = p.orders.map(o => o.delivered_date).filter(Boolean).sort().pop() || null;
    const ord  = p.orders.map(o => o.order_date).filter(Boolean).sort()[0] || null;

    const addrs = [...new Map(p.orders.filter(o => o.shipping_address)
      .map(o => [addressKey(o.shipping_address), o])).values()];

    return {
      ...rest,
      status,
      mixedStatus:   new Set(statuses).size > 1,
      expected_date: exp, delivered_date: dlv, order_date: ord,
      shipTo:        addrs.map(o => ({ name: o.shipping_name, address: o.shipping_address, owner: o.owner || null })),
      conflict:      addrs.length > 1,       // one box, two destinations — suspicious
      retailers:     [...new Set(p.orders.map(o => o.retailer).filter(Boolean))],
      orderIds:      p.orders.map(o => o.id),
      contents:      [..._contents.values()].sort((a, b) => b.qty - a.qty || a.name.localeCompare(b.name)),
      units:         [..._contents.values()].reduce((s, c) => s + c.qty, 0),
      checkedIn:     p.orders.every(o => o.checked_in),
      // Box fee = what's been put on its orders (see feeSplit.js).
      fee:           Math.round(p.orders.reduce((s, o) => s + o.finder_fee, 0) * 100) / 100,
    };
  });

  // Out for delivery first, then soonest ETA; delivered and no-tracking last.
  const bucket = p => p.status === 'OFD' ? 0 : p.status === 'Delivered' ? 3 : p.tracking ? 1 : 2;
  out.sort((a, b) => bucket(a) - bucket(b)
    || String(a.expected_date || '9999').localeCompare(String(b.expected_date || '9999'))
    || String(a.tracking || a.key).localeCompare(String(b.tracking || b.key)));

  return out;
}

module.exports = { computePackages, addressKey };
