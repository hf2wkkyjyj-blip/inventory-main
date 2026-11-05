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

// The scraper files mail from a Shopify-powered shop under "Shopify Store" (and a
// relayed notice under "Narvar") when it only knows the platform. The buying bot
// then names the real shop ("Topps"). Same order, two labels.
const PLATFORM_NAMES = new Set(['shopify store', 'narvar']);
// Plain short numbers ("25164") are what Shopify shops hand out, so two different
// shops can legitimately share one. "US-15162323-S" cannot collide that way.
const isShortNumber = n => /^#?\d{1,8}$/.test(String(n == null ? '' : n).trim());

// Do these rows plausibly describe the same order? Rows with no retailer are
// compatible with anything. Two DIFFERENT named retailers are not — except a
// platform label against one real shop name, and only when the order number is
// distinctive enough that two shops couldn't both have issued it.
function retailersCompatible(rows) {
  const named = new Set(rows.map(r => normRetailer(r.retailer)).filter(Boolean));
  if (named.size <= 1) return true;
  const shops = [...named].filter(n => !PLATFORM_NAMES.has(n));
  if (shops.length > 1) return false;
  return !rows.some(r => isShortNumber(r.order_number));
}

// The shop's own name beats a platform label — the fee rules and the store
// filters group by retailer, so one order must not sit under two names.
function betterRetailer(keep, donors) {
  if (keep.retailer && !PLATFORM_NAMES.has(normRetailer(keep.retailer))) return null;
  const d = donors.find(r => r && r.retailer && !PLATFORM_NAMES.has(normRetailer(r.retailer)));
  return d ? d.retailer : null;
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

// Names saved with a divider glued on ("---------------- Sang Nguyen", from a
// Shopify mail that underlined its "Shipping address" heading). Each spelling
// counted as another person on the address ("28 names on the labels"), and the
// dashed copy kept the clean one from being used. Idempotent.
function cleanNames(db, log = console.log) {
  let n = 0;
  try {
    const rows = db.prepare("SELECT id, shipping_name FROM bot_orders WHERE shipping_name GLOB '*---*' OR shipping_name GLOB '*===*' OR shipping_name GLOB '*___*'").all();
    for (const r of rows) {
      const name = String(r.shipping_name).replace(/[-=_*~]{3,}/g, ' ').replace(/\s+/g, ' ').trim();
      db.prepare('UPDATE bot_orders SET shipping_name=? WHERE id=?').run([name || null, r.id]);
      n++;
    }
  } catch (e) { log(`⚠️  name cleanup failed: ${e.message}`); }
  if (n) log(`🧹 ${n} name(s) had a divider line stuck on the front — cleaned`);
  return n;
}

// Things you did on a duplicate row — checked it in, logged a missing item,
// tied a presale to it — move to the row that stays, so deleting the copy
// doesn't take them with it. A table that doesn't exist yet is simply skipped.
function moveChildren(db, fromIds, keepId) {
  for (const id of fromIds) {
    const run = sql => { try { db.prepare(sql).run([keepId, id]); } catch (_) {} };
    run('INSERT OR IGNORE INTO bot_checkins (order_id, checked_at) SELECT ?, checked_at FROM bot_checkins WHERE order_id=?');
    try { db.prepare('DELETE FROM bot_checkins WHERE order_id=?').run([id]); } catch (_) {}
    run('UPDATE bot_issues SET order_id=? WHERE order_id=?');
    run('UPDATE bot_sales SET order_id=? WHERE order_id=?');
  }
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
    const shop = betterRetailer(keep, others);
    if (shop) { const i = sets.indexOf('retailer'); if (i >= 0) { sets.splice(i, 1); vals.splice(i, 1); } sets.push('retailer'); vals.push(shop); }
    // Take the furthest a duplicate got (Confirmed → Shipped → Delivered). The
    // fill above copied a donor's delivered_date / tracking_status but left the
    // kept row's older status, so a delivered order stayed listed as Shipped.
    // Cancelled/Refunded are never taken from a donor — too final to guess.
    const furthest = others.filter(r => (RANK[r.status] || 0) <= RANK.Delivered)
      .reduce((b, r) => ((RANK[r.status] || 0) > (RANK[b.status] || 0) ? r : b), keep);
    if (furthest !== keep && (RANK[keep.status] || 0) <= RANK.Delivered) {
      sets.push('status'); vals.push(furthest.status);
    }
    if (sets.length) {
      db.prepare(`UPDATE bot_orders SET ${sets.map(c => `${c}=?`).join(',')} WHERE id=?`)
        .run([...vals, keep.id]);
    }

    const ids = others.map(r => r.id);
    moveChildren(db, ids, keep.id);
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
  // Same retailer, either side unnamed, or a platform label ("Shopify Store")
  // against the real shop name — see retailersCompatible.
  return rows.find(r => retailersCompatible([r, { retailer, order_number: orderNumber }])) || null;
}

// Apply an incoming order onto an existing row, filling ONLY empty fields —
// never clobbering data the email scraper already extracted.
function fillExisting(db, existing, incoming) {
  const { sets, vals } = planFill(existing, [incoming]);
  const shop = betterRetailer(existing, [incoming]);
  if (shop) { const i = sets.indexOf('retailer'); if (i >= 0) { sets.splice(i, 1); vals.splice(i, 1); } sets.push('retailer'); vals.push(shop); }
  if (sets.length) {
    db.prepare(`UPDATE bot_orders SET ${sets.map(c => `${c}=?`).join(',')} WHERE id=?`)
      .run([...vals, existing.id]);
  }
  return sets;
}

// An order whose tracking says Delivered, with a delivery date, IS delivered —
// the package view already shows it that way. Older code could leave status
// behind at Shipped (Repair Statuses undoing a hand-marked delivery; the merge
// above). Those orders sat in the Shipped list forever. Idempotent.
function reconcileDelivered(db, log = console.log) {
  let n = 0;
  try {
    const rows = db.prepare(`SELECT id FROM bot_orders WHERE status IN ('Confirmed','Unship','Shipped')
                             AND tracking_status='Delivered' AND delivered_date IS NOT NULL AND delivered_date<>''`).all();
    for (const r of rows) {
      db.prepare(`UPDATE bot_orders SET status='Delivered', status_source=COALESCE(status_source,'manual') WHERE id=?`).run([r.id]);
      n++;
    }
  } catch (e) { log(`⚠️  delivered reconcile failed: ${e.message}`); }
  if (n) log(`📬 ${n} order(s) marked delivered but still listed as Shipped — fixed`);
  return n;
}

module.exports = {
  reconcileDelivered, cleanNames,
  mergeDuplicateOrders, findExisting, fillExisting,
  planFill, richness, retailersCompatible, betterRetailer, moveChildren, isEmpty, FILLABLE,
};
