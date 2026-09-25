'use strict';
// ─── DUPLICATE ORDER MERGING ─────────────────────────────────────────────────
//
// bot_orders.order_number has no unique constraint, and the bot API endpoint
// used `INSERT OR IGNORE` — which only ignores on a constraint violation, so it
// never ignored anything. Every order the buying bot posted that the email
// scraper had already created became a second row: buyer set, but no prices,
// no total, no tracking. Those rows doubled item counts and produced the $0.00
// landed costs in the item view.
//
// This module merges such duplicates into a single row, and gives the insert
// paths a way to find an existing order instead of creating another.

const MONEY_COLS = new Set(['order_total', 'tax_amount', 'ship_cost', 'finder_fee']);

// Columns that may be filled from a duplicate when the kept row lacks them.
const FILLABLE = [
  'shipping_name', 'shipping_address', 'account_email',
  'tracking', 'tracking_status',
  'order_total', 'tax_amount', 'ship_cost', 'finder_fee',
  'items', 'order_date', 'delivered_date', 'expected_date', 'status_changed_at',
  'notes', 'category', 'retailer',
];

const RANK = { Confirmed: 1, Unship: 1, Shipped: 2, OFD: 3, Delivered: 4, Cancelled: 5, Refunded: 5 };

function isEmpty(col, v) {
  if (v === null || v === undefined) return true;
  if (typeof v === 'string' && v.trim() === '') return true;
  if (col === 'items' && String(v).trim() === '[]') return true;
  if (col === 'category' && v === 'Other') return true;        // the default, not a real choice
  if (MONEY_COLS.has(col) && Number(v) === 0) return true;     // column default is 0
  return false;
}

// Which row carries the most real information? That one survives.
function richness(r) {
  let s = 0;
  if (Number(r.order_total) > 0)         s += 8;
  if (r.tracking)                        s += 4;
  if (/@\s*\$/.test(r.items || ''))      s += 4;   // priced items ⇒ extracted from a real email
  if (Number(r.tax_amount) > 0)          s += 2;
  if (r.shipping_address)                s += 1;
  s += (RANK[r.status] || 0) * 0.1;
  return s;
}

const normRetailer = r => (r || '').trim().toLowerCase();

// Do these rows plausibly describe the same order? Rows with no retailer are
// compatible with anything; two DIFFERENT named retailers are not — short order
// numbers like Shopify's "#25164" can legitimately collide across stores.
function retailersCompatible(rows) {
  const named = new Set(rows.map(r => normRetailer(r.retailer)).filter(Boolean));
  return named.size <= 1;
}

// Fill empty columns on `keep` from `donors`. Returns the columns changed.
function planFill(keep, donors) {
  const sets = [], vals = [];
  for (const col of FILLABLE) {
    if (!(col in keep)) continue;
    if (!isEmpty(col, keep[col])) continue;
    const donor = donors.find(d => d && col in d && !isEmpty(col, d[col]));
    if (donor) { sets.push(col); vals.push(donor[col]); }
  }
  return { sets, vals };
}

function mergeDuplicateOrders(db, log = console.log) {
  let groups;
  try {
    groups = db.prepare(
      `SELECT order_number FROM bot_orders
        WHERE order_number IS NOT NULL AND TRIM(order_number) != ''
        GROUP BY order_number HAVING COUNT(*) > 1`
    ).all();
  } catch (e) {
    log(`⚠️  duplicate scan failed: ${e.message}`);
    return { groups: 0, merged: 0, removed: 0, skipped: 0 };
  }

  let merged = 0, removed = 0, skipped = 0;

  for (const g of groups) {
    const rows = db.prepare('SELECT * FROM bot_orders WHERE order_number=? ORDER BY id').all([g.order_number]);
    if (rows.length < 2) continue;

    if (!retailersCompatible(rows)) {
      skipped++;
      log(`   ⚠️  #${g.order_number}: ${rows.length} rows from different retailers — left alone`);
      continue;
    }

    rows.sort((a, b) => (richness(b) - richness(a)) || (a.id - b.id));
    const keep   = rows[0];
    const others = rows.slice(1);

    const { sets, vals } = planFill(keep, others);
    if (sets.length) {
      db.prepare(`UPDATE bot_orders SET ${sets.map(c => `${c}=?`).join(',')} WHERE id=?`)
        .run([...vals, keep.id]);
    }

    const ids = others.map(r => r.id);
    db.prepare(`DELETE FROM bot_orders WHERE id IN (${ids.map(() => '?').join(',')})`).run(ids);

    merged++;
    removed += ids.length;
    log(`   🔗 #${g.order_number}: merged ${rows.length} rows → kept id ${keep.id}` +
        (sets.length ? ` (filled ${sets.join(', ')})` : ''));
  }

  if (merged || skipped) log(`🔗 Duplicate merge: ${merged} order(s) merged, ${removed} duplicate row(s) removed, ${skipped} skipped`);
  return { groups: groups.length, merged, removed, skipped };
}

// Find an existing row for an incoming order, so callers can update instead of
// inserting a duplicate.
function findExisting(db, orderNumber, retailer) {
  if (!orderNumber || !String(orderNumber).trim()) return null;
  const rows = db.prepare('SELECT * FROM bot_orders WHERE order_number=? ORDER BY id').all([String(orderNumber).trim()]);
  if (!rows.length) return null;
  const want = normRetailer(retailer);
  // Same retailer, or either side unnamed.
  return rows.find(r => !want || !normRetailer(r.retailer) || normRetailer(r.retailer) === want) || null;
}

// Apply an incoming order onto an existing row, filling ONLY empty fields —
// never clobbering data the email scraper already extracted.
function fillExisting(db, existing, incoming) {
  const { sets, vals } = planFill(existing, [incoming]);
  if (sets.length) {
    db.prepare(`UPDATE bot_orders SET ${sets.map(c => `${c}=?`).join(',')} WHERE id=?`)
      .run([...vals, existing.id]);
  }
  return sets;
}

module.exports = {
  mergeDuplicateOrders, findExisting, fillExisting,
  planFill, richness, retailersCompatible, isEmpty, FILLABLE,
};
