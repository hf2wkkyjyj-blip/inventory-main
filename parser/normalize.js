'use strict';
// ─── SHARED NORMALIZATION HELPERS ────────────────────────────────────────────
// Every parser layer (jsonld / microdata / dom / llm) produces the same canonical
// shape defined by emptyOrder(). These helpers make the values consistent so the
// layers can be merged without caring where each field came from.

function round2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

// Parse money from anything: 19.99, "$19.99", "USD 19.99", "1,234.56",
// European "1.234,56", "-$5.00", or a schema.org PriceSpecification object.
function parseMoney(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? round2(v) : null;

  if (typeof v === 'object') {
    if (Array.isArray(v)) {
      for (const x of v) { const p = parseMoney(x); if (p !== null) return p; }
      return null;
    }
    return parseMoney(v.price ?? v.value ?? v.amount ?? v.minPrice ?? null);
  }

  let s = String(v).trim();
  if (!s) return null;
  if (/^free$/i.test(s)) return 0;

  const negative = /^\s*[-(]/.test(s) || /-\s*[$£€]/.test(s);
  // Keep only digits and separators
  s = s.replace(/[^0-9.,]/g, '');
  if (!s) return null;

  // Decide which separator is the decimal point.
  const lastComma = s.lastIndexOf(',');
  const lastDot   = s.lastIndexOf('.');
  if (lastComma > lastDot) {
    s = s.replace(/\./g, '').replace(',', '.');   // European: 1.234,56
  } else {
    s = s.replace(/,/g, '');                      // US: 1,234.56
  }

  const n = parseFloat(s);
  if (!Number.isFinite(n)) return null;
  return round2(negative ? -n : n);
}

// schema.org orderStatus → this app's status vocabulary.
// Accepts "http://schema.org/OrderDelivered", "OrderDelivered", or { '@id': ... }.
const SCHEMA_STATUS = {
  orderprocessing:      'Confirmed',
  orderpaymentdue:      'Confirmed',
  orderpickupavailable: 'OFD',
  orderintransit:       'Shipped',
  ordershipped:         'Shipped',
  orderdelivered:       'Delivered',
  ordercancelled:       'Cancelled',
  ordercanceled:        'Cancelled',
  orderreturned:        'Refunded',
  orderproblem:         null,
};

function statusFromSchema(v) {
  if (!v) return null;
  let s = v;
  if (typeof v === 'object') s = v['@id'] || v.name || v.value || '';
  s = String(s).split(/[/#]/).pop().trim().toLowerCase();
  return SCHEMA_STATUS[s] ?? null;
}

function toDate(v) {
  if (!v) return null;
  const d = new Date(typeof v === 'object' ? (v['@value'] || v.value || '') : v);
  if (isNaN(d.getTime())) return null;
  return d.toISOString().split('T')[0];
}

function toInt(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'object') return toInt(v.value ?? v['@value'] ?? null);
  const n = parseInt(String(v).replace(/[^\d-]/g, ''), 10);
  return Number.isFinite(n) ? n : null;
}

const ENTITIES = {
  '&amp;':'&', '&quot;':'"', '&apos;':"'", '&#39;':"'", '&rsquo;':'’',
  '&lsquo;':'‘', '&ldquo;':'“', '&rdquo;':'”', '&nbsp;':' ',
  '&ndash;':'–', '&mdash;':'—', '&trade;':'™', '&reg;':'®',
  '&hellip;':'…', '&eacute;':'é', '&lt;':'<', '&gt;':'>',
};

function decodeEntities(s) {
  return String(s)
    .replace(/&[a-z]+;|&#\d+;/gi, m => {
      if (ENTITIES[m.toLowerCase()]) return ENTITIES[m.toLowerCase()];
      const num = m.match(/&#(\d+);/);
      if (num) { try { return String.fromCodePoint(parseInt(num[1], 10)); } catch (_) { return ' '; } }
      return ' ';
    });
}

function cleanName(s) {
  if (!s) return null;
  if (typeof s === 'object') s = s.name || s['@value'] || s.value || '';
  let n = decodeEntities(String(s)).replace(/\s+/g, ' ').trim();
  // Strip trailing separators left over from HTML splits
  n = n.replace(/[\s|,;:–-]+$/, '').trim();
  if (n.length < 2) return null;
  return n.slice(0, 200);
}

function str(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'object') return str(v.name ?? v['@value'] ?? v.value ?? v['@id'] ?? null);
  const s = String(v).trim();
  return s ? s : null;
}

function asArray(v) {
  if (v === null || v === undefined) return [];
  return Array.isArray(v) ? v : [v];
}

function firstUrl(v) {
  for (const x of asArray(v)) {
    if (typeof x === 'string' && /^https?:\/\//i.test(x)) return x;
    if (x && typeof x === 'object') {
      const u = x.url || x.contentUrl || x['@id'];
      if (typeof u === 'string' && /^https?:\/\//i.test(u)) return u;
    }
  }
  return null;
}

function formatAddress(a) {
  if (!a) return null;
  if (typeof a === 'string') return cleanName(a);
  const parts = [
    a.streetAddress, a.addressLocality, a.addressRegion, a.postalCode,
  ].map(x => str(x)).filter(Boolean);
  return parts.length ? parts.join(', ').slice(0, 250) : null;
}

// The canonical shape every layer returns.
function emptyOrder() {
  return {
    orderNumber: null,
    retailer: null,
    status: null,
    orderDate: null,
    items: [],                  // { name, sku, qty, unitPrice, lineTotal, imageUrl }
    subtotal: null,
    tax: null,
    shipping: null,
    discount: null,
    total: null,
    currency: 'USD',
    trackingNumber: null,
    carrier: null,
    trackingUrl: null,
    expectedDate: null,
    shippingName: null,
    shippingAddress: null,
    source: null,               // which layer produced the items
    confidence: 0,
  };
}

const SCALAR_FIELDS = [
  'orderNumber','retailer','status','orderDate','subtotal','tax','shipping',
  'discount','total','trackingNumber','carrier','trackingUrl','expectedDate',
  'shippingName','shippingAddress',
];

// Merge `extra` into `base`: base wins for anything already set.
// Items are taken from whichever side actually has them (base first).
function merge(base, extra) {
  if (!extra) return base;
  const out = { ...base };
  for (const f of SCALAR_FIELDS) {
    if (out[f] === null || out[f] === undefined) out[f] = extra[f] ?? null;
  }
  if ((!out.items || out.items.length === 0) && extra.items && extra.items.length) {
    out.items  = extra.items;
    out.source = out.source || extra.source;
  }
  if (!out.source && extra.source) out.source = extra.source;
  return out;
}

function hasAnything(o) {
  return !!(o && (o.orderNumber || (o.items && o.items.length) || o.trackingNumber || o.total !== null));
}

module.exports = {
  round2, parseMoney, statusFromSchema, toDate, toInt,
  decodeEntities, cleanName, str, asArray, firstUrl, formatAddress,
  emptyOrder, merge, hasAnything, SCALAR_FIELDS,
};
