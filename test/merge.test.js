'use strict';
// Duplicate-order merging. Reproduces the rows seen in production: the email
// scraper's row (priced items, total, tracking) plus the bot API's duplicate
// (buyer name only, unpriced item, no total).

const M = require('../orderMerge');

let passed = 0, failed = 0;
const eq = (n, a, e) => {
  if (a === e) { passed++; console.log(`  ✅ ${n}`); }
  else { failed++; console.log(`  ❌ ${n} — got ${JSON.stringify(a)}, expected ${JSON.stringify(e)}`); }
};

// Tiny in-memory table implementing just the SQL orderMerge.js issues.
function makeDb(rows) {
  const table = rows.map(r => ({ ...r }));
  return {
    table,
    prepare(sql) {
      const s = sql.replace(/\s+/g, ' ').trim();
      return {
        all(p = []) {
          if (/GROUP BY order_number HAVING/i.test(s)) {
            const c = {};
            table.filter(r => r.order_number && String(r.order_number).trim())
                 .forEach(r => { c[r.order_number] = (c[r.order_number] || 0) + 1; });
            return Object.entries(c).filter(([, n]) => n > 1).map(([order_number]) => ({ order_number }));
          }
          if (/WHERE order_number=\?/i.test(s)) {
            return table.filter(r => r.order_number === p[0]).sort((a, b) => a.id - b.id);
          }
          return [];
        },
        run(p = []) {
          if (/^UPDATE/i.test(s)) {
            const id = p[p.length - 1];
            const cols = s.match(/SET (.+) WHERE/i)[1].split(',').map(c => c.split('=')[0].trim());
            const row = table.find(r => r.id === id);
            cols.forEach((c, i) => { row[c] = p[i]; });
          } else if (/^DELETE/i.test(s)) {
            for (const id of p) { const i = table.findIndex(r => r.id === id); if (i >= 0) table.splice(i, 1); }
          }
        },
      };
    },
  };
}

const silent = () => {};

console.log('\n── The real duplicates from the screenshot ──');
{
  const db = makeDb([
    // Email scraper's row: the good one.
    { id: 10, order_number: '902003715669815', retailer: 'Target', category: 'Pokemon', status: 'Delivered',
      items: '["2x Pokemon Trading Card Game: 30th Celebration Booster Bundle @ $29.99"]',
      order_total: 65.09, tax_amount: 5.11, ship_cost: 0, tracking: '1ZWY0657YW04307471',
      shipping_name: null, shipping_address: null, account_email: null },
    // Bot API's duplicate: buyer only.
    { id: 11, order_number: '902003715669815', retailer: 'Target', category: 'Pokemon', status: 'Delivered',
      items: '["Pokemon TCG: 30th Celebration Booster Bundle"]',
      order_total: 0, tax_amount: 0, ship_cost: 0, tracking: null,
      shipping_name: 'Sang', shipping_address: '7964 Brooklyn Blvd', account_email: 'sang@example.com' },
  ]);

  const r = M.mergeDuplicateOrders(db, silent);
  eq('one order merged', r.merged, 1);
  eq('one duplicate removed', r.removed, 1);
  eq('single row remains', db.table.length, 1);

  const row = db.table[0];
  eq('kept the scraper row', row.id, 10);
  eq('kept priced items', /@ \$29\.99/.test(row.items), true);
  eq('kept real total', row.order_total, 65.09);
  eq('kept tracking', row.tracking, '1ZWY0657YW04307471');
  eq('gained buyer from bot row', row.shipping_name, 'Sang');
  eq('gained address from bot row', row.shipping_address, '7964 Brooklyn Blvd');
  eq('gained account from bot row', row.account_email, 'sang@example.com');
}

console.log('\n── Richest row wins even if it was inserted second ──');
{
  const db = makeDb([
    { id: 1, order_number: 'P0040756156', retailer: 'Pokemon Center', status: 'Confirmed',
      items: '["Booster Bundle"]', order_total: 0, tracking: null, shipping_name: 'Sang' },
    { id: 2, order_number: 'P0040756156', retailer: 'Pokemon Center', status: 'Shipped',
      items: '["3x Booster Bundle @ $35.14"]', order_total: 112.84, tracking: '876543210987', shipping_name: null },
  ]);
  M.mergeDuplicateOrders(db, silent);
  eq('kept id 2 (priced, tracked)', db.table[0].id, 2);
  eq('buyer filled in', db.table[0].shipping_name, 'Sang');
}

console.log('\n── Same number, DIFFERENT retailers must not merge ──');
{
  // Short Shopify-style numbers legitimately collide across stores.
  const db = makeDb([
    { id: 1, order_number: '25164', retailer: 'Bear Walker',   items: '["Skateboard @ $129.85"]', order_total: 125.48 },
    { id: 2, order_number: '25164', retailer: 'Shopify Store', items: '["T-shirt @ $20.00"]',    order_total: 22.00 },
  ]);
  const r = M.mergeDuplicateOrders(db, silent);
  eq('skipped, not merged', r.skipped, 1);
  eq('both rows kept', db.table.length, 2);
}

console.log('\n── Idempotent ──');
{
  const db = makeDb([
    { id: 1, order_number: 'X1', retailer: 'Target', order_total: 10, items: '["A @ $10.00"]' },
    { id: 2, order_number: 'X1', retailer: 'Target', order_total: 0,  items: '[]', shipping_name: 'Sang' },
  ]);
  M.mergeDuplicateOrders(db, silent);
  const second = M.mergeDuplicateOrders(db, silent);
  eq('second run finds nothing', second.merged, 0);
  eq('still one row', db.table.length, 1);
}

console.log('\n── Bot API: findExisting + fillExisting ──');
{
  const db = makeDb([
    { id: 5, order_number: '912003760648863', retailer: 'Target', order_total: 65.09,
      items: '["2x Pokemon TCG @ $29.99"]', tracking: '1ZWY0657YW04307994', shipping_name: null },
  ]);
  const hit = M.findExisting(db, '912003760648863', 'Target');
  eq('finds the scraper row', hit && hit.id, 5);
  eq('matches when bot omits retailer', (M.findExisting(db, '912003760648863', null) || {}).id, 5);
  eq('no match for another store', M.findExisting(db, '912003760648863', 'Walmart'), null);

  const filled = M.fillExisting(db, hit, { shipping_name: 'Sang', order_total: 0, items: '["Pokemon TCG"]' });
  eq('only empty field filled', filled.join(','), 'shipping_name');
  eq('total not clobbered by bot 0', db.table[0].order_total, 65.09);
  eq('priced items not clobbered', /@ \$29\.99/.test(db.table[0].items), true);
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
