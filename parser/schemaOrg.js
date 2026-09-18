'use strict';
// ─── schema.org NODE EXTRACTORS ──────────────────────────────────────────────
// Shared by jsonld.js and microdata.js — both produce plain JS objects shaped
// like schema.org entities, so the extraction logic below is identical for each.
//
// Reference: https://developers.google.com/gmail/markup  (Google's email markup
// spec, which is why nearly every major retailer emits this data.)

const {
  parseMoney, statusFromSchema, toDate, toInt, cleanName, str, asArray,
  firstUrl, formatAddress, emptyOrder, round2,
} = require('./normalize');

// Normalize an @type value ("http://schema.org/Order", "Order", ["Order"]) to
// a lowercase set of bare type names.
function typesOf(node) {
  const raw = node && (node['@type'] || node.type || node.itemtype);
  return new Set(asArray(raw).map(t => String(t).split(/[/#]/).pop().trim().toLowerCase()));
}

// Walk a parsed JSON-LD structure and return every entity object found,
// unwrapping arrays, @graph, and the EmailMessage/potentialAction wrappers that
// some retailers use.
function flattenNodes(node, out = [], depth = 0) {
  if (!node || typeof node !== 'object' || depth > 12) return out;
  if (Array.isArray(node)) {
    for (const n of node) flattenNodes(n, out, depth + 1);
    return out;
  }
  out.push(node);
  for (const key of ['@graph', 'potentialAction', 'about', 'mainEntity', 'mainEntityOfPage', 'itemListElement', 'result', 'target']) {
    if (node[key]) flattenNodes(node[key], out, depth + 1);
  }
  return out;
}

// ── Offer → item ─────────────────────────────────────────────────────────────
function offerToItem(off) {
  if (!off || typeof off !== 'object') return null;

  const prod = off.itemOffered || off.item || off.itemShipped || {};
  const name = cleanName(prod.name || prod.title || off.name || prod.description);
  if (!name) return null;

  const qty =
    toInt(off.eligibleQuantity?.value ?? off.eligibleQuantity) ??
    toInt(prod.eligibleQuantity?.value ?? prod.eligibleQuantity) ??
    toInt(off.quantity?.value ?? off.quantity) ??
    1;

  const price = parseMoney(off.price ?? off.priceSpecification ?? prod.price ?? prod.offers?.price);
  const sku   = str(prod.sku || prod.productID || prod.mpn || prod.gtin13 || prod.gtin12 || off.sku);

  return {
    name,
    sku:       sku || null,
    qty:       qty && qty > 0 ? qty : 1,
    unitPrice: price,
    // lineTotal is filled in by the reconcile step once we know whether `price`
    // was a unit price or a line total.
    lineTotal: null,
    imageUrl:  firstUrl(prod.image),
  };
}

// ── ParcelDelivery ───────────────────────────────────────────────────────────
function extractParcelDelivery(node) {
  const o = emptyOrder();

  o.trackingNumber = str(node.trackingNumber);
  o.trackingUrl    = str(node.trackingUrl) || firstUrl(node.url);
  o.carrier        = cleanName(node.carrier?.name ?? node.carrier ?? node.provider?.name);
  o.expectedDate   = toDate(node.expectedArrivalUntil || node.expectedArrivalFrom);

  const addr = node.deliveryAddress;
  if (addr) {
    o.shippingAddress = formatAddress(addr);
    o.shippingName    = cleanName(addr.name || node.recipient?.name);
  }

  const po = node.partOfOrder;
  if (po && typeof po === 'object') {
    o.orderNumber = str(po.orderNumber) || o.orderNumber;
    o.retailer    = cleanName(po.merchant?.name ?? po.merchant ?? po.seller?.name) || o.retailer;
    o.status      = statusFromSchema(po.orderStatus);
    for (const off of asArray(po.acceptedOffer)) {
      const it = offerToItem(off);
      if (it) o.items.push(it);
    }
    o.total = parseMoney(po.totalPaymentDue ?? po.price ?? po.priceSpecification);
  }

  // A parcel notification means it's at least shipped, unless the order says more.
  const deliveryStatus = statusFromSchema(node.deliveryStatus);
  o.status = o.status || deliveryStatus || (o.trackingNumber ? 'Shipped' : null);

  return o;
}

// ── Order ────────────────────────────────────────────────────────────────────
function extractOrder(node) {
  const o = emptyOrder();

  o.orderNumber = str(node.orderNumber) || str(node.confirmationNumber) || str(node.identifier);
  o.status      = statusFromSchema(node.orderStatus);
  o.orderDate   = toDate(node.orderDate);
  o.retailer    = cleanName(node.merchant?.name ?? node.merchant ?? node.seller?.name ?? node.seller ?? node.broker?.name);

  for (const off of asArray(node.acceptedOffer)) {
    const it = offerToItem(off);
    if (it) o.items.push(it);
  }
  // Some emitters put products under orderedItem instead of acceptedOffer
  for (const oi of asArray(node.orderedItem)) {
    const it = offerToItem(oi.itemOffered || oi.orderedItem ? oi : { itemOffered: oi, price: oi.price, eligibleQuantity: oi.orderQuantity });
    if (it && !o.items.some(x => x.name === it.name && x.unitPrice === it.unitPrice)) o.items.push(it);
  }

  o.total = parseMoney(node.totalPaymentDue ?? node.price ?? node.priceSpecification);

  // Discounts are sometimes on the order itself
  const disc = parseMoney(node.discount);
  if (disc !== null && disc !== 0) o.discount = Math.abs(disc);

  const cur = str(node.priceCurrency) || str(node.totalPaymentDue?.priceCurrency) || str(node.priceSpecification?.priceCurrency);
  if (cur) o.currency = cur;

  const cust = node.customer;
  if (cust) o.shippingName = cleanName(cust.name) || o.shippingName;

  // orderDelivery carries tracking + address
  const del = node.orderDelivery;
  if (del && typeof del === 'object') {
    o.trackingNumber = str(del.trackingNumber) || o.trackingNumber;
    o.trackingUrl    = str(del.trackingUrl) || firstUrl(del.url) || o.trackingUrl;
    o.carrier        = cleanName(del.carrier?.name ?? del.carrier ?? del.provider?.name) || o.carrier;
    o.expectedDate   = toDate(del.expectedArrivalUntil || del.expectedArrivalFrom) || o.expectedDate;
    if (del.deliveryAddress) {
      o.shippingAddress = formatAddress(del.deliveryAddress) || o.shippingAddress;
      o.shippingName    = cleanName(del.deliveryAddress.name) || o.shippingName;
    }
    const ds = statusFromSchema(del.deliveryStatus);
    if (!o.status && ds) o.status = ds;
  }

  if (!o.status && o.orderNumber) o.status = 'Confirmed';

  return o;
}

// Given a flat list of schema.org nodes, build one merged order.
function fromNodes(nodes) {
  const orders  = [];
  const parcels = [];

  for (const n of nodes) {
    const t = typesOf(n);
    if (t.has('order'))                                    orders.push(extractOrder(n));
    else if (t.has('parceldelivery'))                      parcels.push(extractParcelDelivery(n));
    // Some retailers emit a bare object with orderNumber and no @type at all
    else if (!t.size && (n.orderNumber || n.acceptedOffer)) orders.push(extractOrder(n));
  }

  if (!orders.length && !parcels.length) return null;

  // Prefer the order with the most information, then fold in parcel data.
  const score = o => (o.items.length * 10) + (o.orderNumber ? 5 : 0) + (o.total !== null ? 3 : 0);
  orders.sort((a, b) => score(b) - score(a));

  const base = orders[0] || emptyOrder();
  for (const p of parcels) {
    base.trackingNumber  = base.trackingNumber  ?? p.trackingNumber;
    base.trackingUrl     = base.trackingUrl     ?? p.trackingUrl;
    base.carrier         = base.carrier         ?? p.carrier;
    base.expectedDate    = base.expectedDate    ?? p.expectedDate;
    base.shippingAddress = base.shippingAddress ?? p.shippingAddress;
    base.shippingName    = base.shippingName    ?? p.shippingName;
    base.orderNumber     = base.orderNumber     ?? p.orderNumber;
    base.retailer        = base.retailer        ?? p.retailer;
    base.total           = base.total           ?? p.total;
    if (!base.items.length && p.items.length) base.items = p.items;
    if (!base.status && p.status) base.status = p.status;
  }

  return base;
}

module.exports = { typesOf, flattenNodes, fromNodes, extractOrder, extractParcelDelivery, offerToItem };
