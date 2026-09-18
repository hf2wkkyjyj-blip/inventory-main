'use strict';
// Proves the baseline import cannot duplicate or resurrect orders.
//
// The incident this guards against: a run-once flag meant that after a
// Wipe & Rescan the baseline never re-imported, and ~100 Pokemon Center and
// Mattel Creations orders — retailers the email scraper cannot read at all —
// were permanently lost.

const fs   = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'bot_orders_import.json');

let passed = 0, failed = 0;
function eq(name, actual, expected) {
  if (actual === expected) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name} — got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`); }
}
function check(name, cond, detail) {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}

// Mirror of importBaselineOrders() against an in-memory table.
function runImport(rows, orders, blocked, force = false) {
  const blockedSet = new Set(force ? [] : blocked);
  const existing = new Set(rows.filter(r => r.order_number).map(r => String(r.order_number)));
  let imported = 0, skipped = 0, blockedCount = 0;

  for (const o of orders) {
    const num = o.order_number ? String(o.order_number) : null;
    if (num && existing.has(num))   { skipped++;      continue; }
    if (num && blockedSet.has(num)) { blockedCount++; continue; }
    rows.push({ order_number: num, retailer: o.retailer, status: o.status });
    if (num) existing.add(num);
    imported++;
  }
  return { imported, skipped, blocked: blockedCount };
}

const orders = JSON.parse(fs.readFileSync(FILE, 'utf8')).orders;

console.log('\n── Baseline file integrity ──');
eq('134 orders in file', orders.length, 134);
const byRetailer = orders.reduce((m, o) => (m[o.retailer] = (m[o.retailer] || 0) + 1, m), {});
eq('52 Pokemon Center', byRetailer['Pokemon Center'], 52);
eq('50 Mattel Creations', byRetailer['Mattel Creations'], 50);
eq("8 Sam's Club", byRetailer["Sam's Club"], 8);
check('every order has an order_number', orders.every(o => !!o.order_number));

console.log('\n── Import into an empty DB ──');
{
  const rows = [];
  const r = runImport(rows, orders, []);
  eq('all imported', r.imported, 134);
  eq('table size',   rows.length, 134);
}

console.log('\n── Running it twice must not duplicate ──');
{
  const rows = [];
  runImport(rows, orders, []);
  const second = runImport(rows, orders, []);
  eq('second run adds nothing', second.imported, 0);
  eq('second run skips all',    second.skipped, 134);
  eq('table still 134',         rows.length, 134);
}

console.log('\n── Against 59 already-scraped orders (the real situation) ──');
{
  // 20 Target orders in the file overlap with what the scraper found.
  const scraped = orders.filter(o => o.retailer === 'Target')
                        .map(o => ({ order_number: o.order_number, retailer: 'Target', status: 'Confirmed' }));
  const rows = [...scraped];
  const before = rows.length;
  const r = runImport(rows, orders, []);

  eq('overlapping Target orders skipped', r.skipped, before);
  eq('no duplicates created', rows.length, 134);

  const nums = rows.map(x => x.order_number);
  eq('all order numbers unique', new Set(nums).size, nums.length);

  const pkc = rows.filter(x => x.retailer === 'Pokemon Center').length;
  const mat = rows.filter(x => x.retailer === 'Mattel Creations').length;
  eq('Pokemon Center restored', pkc, 52);
  eq('Mattel restored',         mat, 50);
}

console.log('\n── Deleted orders stay deleted (blocklist honoured) ──');
{
  const rows = [];
  const victim = orders.find(o => o.retailer === "Sam's Club").order_number;
  const r = runImport(rows, orders, [victim]);
  eq('one blocked', r.blocked, 1);
  eq('table short by one', rows.length, 133);
  check('blocked order absent', !rows.some(x => x.order_number === victim));
}

console.log('\n── force:true overrides the blocklist (explicit restore) ──');
{
  const rows = [];
  const victim = orders.find(o => o.retailer === "Sam's Club").order_number;
  const r = runImport(rows, orders, [victim], true);
  eq('nothing blocked', r.blocked, 0);
  check('order present', rows.some(x => x.order_number === victim));
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
