#!/usr/bin/env node
'use strict';
// ─── DATA CHECK ──────────────────────────────────────────────────────────────
//
// Reads a database backup (the admin page's "Backup" button) and reports
// anything that doesn't add up — double-counted fees, fees on cancelled orders,
// look-alike orders with different fees, stuck statuses, oversold products…
//
//   node tools/check-data.js backups/inventory-backup-2026-09-28-18-20.db
//
// Read-only: opens the file read-only and never changes it. It uses the site's
// own calculations (itemView / packageView / feeSplit), so numbers match what
// the admin page shows. Prints order numbers and product names — never customer
// names or addresses.

process.removeAllListeners('warning');
const path = require('path');
const fs   = require('fs');
const { DatabaseSync } = require('node:sqlite');
const { computeItemGroups } = require('../itemView');
const { computePackages }   = require('../packageView');
const { orderSignature }    = require('../feeSplit');
const Sku                   = require('../skuCatalog');
const { itemKey }           = require('../itemNames');

function openDb(file) {
  const raw = new DatabaseSync(file, { readOnly: true });
  const norm = p => (p === undefined ? [] : Array.isArray(p) ? p : [p]);
  return {
    raw,
    exec: () => { throw new Error('read-only'); },
    prepare: sql => {
      const st = raw.prepare(sql);
      return { all: p => st.all(...norm(p)), get: p => st.get(...norm(p)), run: () => { throw new Error('read-only'); } };
    },
  };
}
const hasTable = (db, t) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get([t]);
const hasCol   = (db, t, c) => db.prepare(`PRAGMA table_info(${t})`).all().some(r => r.name === c);
const money = n => (n < 0 ? '-' : '') + '$' + Math.abs(Number(n) || 0).toFixed(2);
const r2 = n => Math.round(n * 100) / 100;
const DEAD = new Set(['Cancelled', 'Refunded']);

/**
 * Runs every check. Returns { summary, findings: [{level, area, title, rows[]}] }.
 * level: 'problem' (almost certainly wrong) | 'check' (worth a look) | 'info'
 */
function checkData(db) {
  const findings = [];
  const add = (level, area, title, rows = []) => findings.push({ level, area, title, rows });

  const all     = db.prepare('SELECT * FROM bot_orders').all();
  const live    = all.filter(o => !DEAD.has(o.status));
  const pricing = hasTable(db, 'bot_sku_prices') ? db.prepare('SELECT * FROM bot_sku_prices').all() : [];
  const sales   = hasTable(db, 'bot_sales') ? db.prepare('SELECT * FROM bot_sales').all() : [];
  const catalog = hasTable(db, 'sku_products') ? Sku.loadCatalog(db) : { products: new Map(), aliases: new Map() };
  const groups  = computeItemGroups(live, pricing, catalog, sales);
  const label   = o => `#${o.order_number || o.id} (${o.retailer || '?'}, ${o.status})`;

  // ── Summary: the same totals the cards show (All time) ───────────────────
  const byStatus = {};
  all.forEach(o => { byStatus[o.status || 'null'] = (byStatus[o.status || 'null'] || 0) + 1; });
  const spent = live.reduce((s, o) => s + (Number(o.order_total) || 0) - (Number(o.refunded_amount) || 0), 0);
  const unitFeeByOrder = new Map();
  for (const g of groups) {
    if (!g.perUnitFeeTyped) continue;
    for (const l of g.orderLines) if (l.id != null) unitFeeByOrder.set(l.id, (unitFeeByOrder.get(l.id) || 0) + l.qty * g.perUnitFeeTyped);
  }
  const orderFeeTotal = live.reduce((s, o) => s + (Number(o.finder_fee) || 0), 0);
  const unitFeeTotal  = [...unitFeeByOrder.values()].reduce((s, v) => s + v, 0);
  const saleRows = groups.flatMap(g => g.sales.map(s => ({ ...s, cost: s.qty * g.perUnitTotal })));
  const salesProfit = saleRows.reduce((s, x) => s + x.qty * x.unit_price - x.fees - x.cost, 0);
  const summary = {
    orders: all.length, byStatus, spent: r2(spent),
    finderFees: r2(orderFeeTotal + unitFeeTotal), boxOrOrderFees: r2(orderFeeTotal), perUnitFees: r2(unitFeeTotal),
    ordersWithFee: live.filter(o => Number(o.finder_fee) > 0).length,
    products: groups.length, sales: sales.length, unitsSold: saleRows.reduce((s, x) => s + x.qty, 0),
    salesProfit: r2(salesProfit),
  };

  // ── FEES ──────────────────────────────────────────────────────────────────
  // 1. Box/order fee AND a typed per-unit fee on the same product: both are
  //    added to landed cost. Right only if the extra is truly a second fee.
  const both = groups.filter(g => g.perUnitBoxFee > 0 && g.perUnitFeeTyped > 0);
  if (both.length) add('problem', 'Fees', 'Fee counted twice? Product has a box/order fee AND an extra per-unit fee (both are added to landed cost)',
    both.map(g => `${g.name}: box ${money(g.perUnitBoxFee)}/unit + extra ${money(g.perUnitFeeTyped)}/unit = ${money(g.perUnitFinder)}/unit`));

  // 2. Fees on cancelled/refunded orders (not counted anywhere — was it paid?)
  const deadFee = all.filter(o => DEAD.has(o.status) && Number(o.finder_fee) > 0);
  if (deadFee.length) add('check', 'Fees', 'Fee on a cancelled/refunded order (left out of totals — was it actually paid?)',
    deadFee.map(o => `${label(o)}: ${money(o.finder_fee)}`));

  // 3. Look-alike orders (same store, items, qty) with different fees.
  const bySig = new Map();
  for (const o of live) {
    const sig = orderSignature(o);
    if (!sig) continue;
    if (!bySig.has(sig)) bySig.set(sig, []);
    bySig.get(sig).push(o);
  }
  // Orders in a multi-order box carry a SHARE of a box fee, so they can't be
  // compared with single-order boxes — leave them out of this check.
  const trkCount = new Map();
  live.forEach(o => { if (o.tracking) trkCount.set(o.tracking, (trkCount.get(o.tracking) || 0) + 1); });
  const inSharedBox = o => o.tracking && trkCount.get(o.tracking) > 1;
  const mismatch = [];
  for (const os of bySig.values()) {
    const solo = os.filter(o => !inSharedBox(o));
    if (solo.length < 2) continue;
    const fees = new Map();
    solo.forEach(o => { const f = r2(Number(o.finder_fee) || 0); fees.set(f, [...(fees.get(f) || []), o]); });
    if (fees.size < 2 || ![...fees.keys()].some(f => f > 0)) continue;
    const g = groups.find(x => x.orderLines.some(l => l.id === solo[0].id));
    const parts = [...fees.entries()].sort((a, b) => b[1].length - a[1].length)
      .map(([f, list]) => `${list.length}× ${f ? money(f) : 'no fee'}` +
        (list.length <= 6 ? ` (${list.map(o => '#' + (o.order_number || o.id)).join(', ')})` : ''));
    mismatch.push(`${solo[0].retailer || '?'} · ${g ? g.name : '?'} — ${parts.join(' · ')}`);
  }
  if (mismatch.length) add('check', 'Fees', 'Same store + items + qty, but different fees (missed one, or a typo?)', mismatch);

  // 4. Fee out of proportion to what was bought.
  const high = live.filter(o => Number(o.finder_fee) > 0 && Number(o.order_total) > 0 && Number(o.finder_fee) > Number(o.order_total) * 0.6);
  if (high.length) add('check', 'Fees', 'Fee is more than 60% of the order total (typo, or fee typed on the wrong order?)',
    high.map(o => `${label(o)}: fee ${money(o.finder_fee)} on a ${money(o.order_total)} order`));

  // 5. Multi-order box with a fee on only some of its orders — usually a fee
  //    typed into one order's ✎ instead of the box's Fee button.
  const pk = computePackages(live, catalog).filter(p => p.orderIds.length > 1);
  const partial = [];
  for (const p of pk) {
    const os = p.orderIds.map(id => live.find(o => o.id === id)).filter(Boolean);
    const withFee = os.filter(o => Number(o.finder_fee) > 0);
    if (withFee.length && withFee.length < os.length)
      partial.push(`${p.tracking}: fee on ${withFee.map(o => '#' + o.order_number).join(', ')} only, not on ${os.filter(o => !(Number(o.finder_fee) > 0)).map(o => '#' + o.order_number).join(', ')}`);
  }
  if (partial.length) add('check', 'Fees', 'Box with several orders, but the fee is on only some of them', partial);

  // 6. Per-unit fees saved for a product that no longer exists (ignored).
  const liveKeys = new Set(groups.flatMap(g => [g.skuKey, ...g.rawNames, g.name].map(itemKey)));
  const orphanFees = pricing.filter(p => Number(p.buyer_fee) > 0 && !liveKeys.has(itemKey(p.sku)));
  if (orphanFees.length) add('info', 'Fees', 'Per-unit fee saved for a product with no current orders (not counted anywhere)',
    orphanFees.map(p => `${p.sku.startsWith('#p') ? (catalog.products.get(Number(p.sku.slice(2))) || {}).name || p.sku : p.sku}: ${money(p.buyer_fee)}/unit`));

  // ── STATUS ────────────────────────────────────────────────────────────────
  const mixed = all.filter(o => ['Confirmed', 'Unship', 'Shipped'].includes(o.status) && o.tracking_status === 'Delivered');
  if (mixed.length) add('problem', 'Status', 'Tracking says Delivered but status is not (sits in the wrong tab)',
    mixed.map(o => `${label(o)} delivered ${o.delivered_date || '?'}`));

  const conflicts = computePackages(live, catalog).filter(p => p.conflict);
  if (conflicts.length) add('problem', 'Status', 'One tracking number on orders going to different addresses (a wrong tracking number)',
    conflicts.map(p => `${p.tracking}: ${p.orders.map(o => '#' + o.order_number).join(', ')} → ${p.shipTo.length} addresses`));

  const dupNums = db.prepare(`SELECT order_number, COUNT(*) n FROM bot_orders WHERE order_number IS NOT NULL AND order_number<>''
                              GROUP BY order_number HAVING n>1`).all();
  if (dupNums.length) add('problem', 'Status', 'Same order number on more than one row (duplicates)',
    dupNums.map(r => `#${r.order_number} × ${r.n}`));

  const oldShipped = live.filter(o => o.status === 'Shipped' && o.expected_date &&
    (Date.now() - new Date(o.expected_date + 'T00:00:00').getTime()) > 7 * 86400000);
  if (oldShipped.length) add('check', 'Status', 'Still Shipped more than a week after the expected date (delivered? lost?)',
    oldShipped.map(o => `${label(o)} expected ${o.expected_date}`));

  // ── COST ──────────────────────────────────────────────────────────────────
  const noItems = live.filter(o => { try { const a = JSON.parse(o.items || '[]'); return !a.length; } catch (_) { return true; } });
  if (noItems.length) add('check', 'Cost', 'Order with no items (not in any product row, so its cost and fee go nowhere)',
    noItems.map(o => `${label(o)} total ${money(o.order_total)}${Number(o.finder_fee) ? `, fee ${money(o.finder_fee)}` : ''}`));

  const unknown = groups.filter(g => g.costUnknown);
  if (unknown.length) add('check', 'Cost', 'Product with no price and no order total (landed cost unknown)',
    unknown.map(g => `${g.name} (${g.qty} units)`));

  // ── SALES ─────────────────────────────────────────────────────────────────
  const oversold = groups.filter(g => g.soldQty > g.qty);
  if (oversold.length) add('check', 'Sales', 'Sold more than bought (units from elsewhere, or a sale on the wrong product?)',
    oversold.map(g => `${g.name}: sold ${g.soldQty} of ${g.qty}`));

  const counted = new Set(groups.flatMap(g => g.sales.map(s => s.id)));
  const orphanSales = sales.filter(s => !counted.has(s.id));
  if (orphanSales.length) add('problem', 'Sales', 'Sale that matches no current product (missing from SOLD and profit)',
    orphanSales.map(s => `sale ${s.id}: ${s.product_name || s.sku_key} — ${s.qty} × ${money(s.unit_price)} on ${s.sold_at}`));

  const freeSales = sales.filter(s => !(Number(s.unit_price) > 0));
  if (freeSales.length) add('check', 'Sales', 'Sale recorded at $0', freeSales.map(s => `sale ${s.id}: ${s.product_name || s.sku_key} × ${s.qty}`));

  const losses = groups.filter(g => g.soldQty && g.realizedProfit < 0);
  if (losses.length) add('info', 'Sales', 'Sold at a loss (after fees and landed cost)',
    losses.map(g => `${g.name}: ${money(g.realizedProfit)} on ${g.soldQty} sold`));

  return { summary, findings };
}

function report({ summary: s, findings }) {
  const L = [];
  L.push('DATA CHECK', '='.repeat(60));
  L.push(`Orders: ${s.orders}  (${Object.entries(s.byStatus).map(([k, v]) => `${k} ${v}`).join(', ')})`);
  L.push(`Spent: ${money(s.spent)}`);
  L.push(`Finder fees: ${money(s.finderFees)}  = box/order fees ${money(s.boxOrOrderFees)} on ${s.ordersWithFee} orders + per-unit fees ${money(s.perUnitFees)}`);
  L.push(`Products: ${s.products}   Sales: ${s.sales} (${s.unitsSold} units)   Sales profit: ${money(s.salesProfit)}`);
  const order = { problem: 0, check: 1, info: 2 };
  const icon  = { problem: '❌', check: '⚠️ ', info: 'ℹ️ ' };
  if (!findings.length) L.push('', '✅ Nothing looks off.');
  for (const f of [...findings].sort((a, b) => order[a.level] - order[b.level])) {
    L.push('', `${icon[f.level]} [${f.area}] ${f.title} — ${f.rows.length}`);
    f.rows.slice(0, 40).forEach(r => L.push('     • ' + r));
    if (f.rows.length > 40) L.push(`     … and ${f.rows.length - 40} more`);
  }
  return L.join('\n');
}

module.exports = { checkData, report, openDb };

if (require.main === module) {
  let file = process.argv[2];
  if (!file) {
    // Newest backup in backups/ by default.
    const dir = path.join(__dirname, '..', 'backups');
    const list = fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => f.endsWith('.db')).sort() : [];
    if (!list.length) { console.error('Usage: node tools/check-data.js <backup.db>   (or put backups in ./backups)'); process.exit(2); }
    file = path.join(dir, list[list.length - 1]);
  }
  const db = openDb(file);
  console.log(`(${path.basename(file)})\n`);
  console.log(report(checkData(db)));
}
