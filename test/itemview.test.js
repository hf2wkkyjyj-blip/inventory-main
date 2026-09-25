'use strict';
// Runs the REAL item-view aggregation (itemView.js), using figures taken from
// the user's own orders.

const { computeItemGroups } = require('../itemView');

let passed = 0, failed = 0;
const eq = (n, a, e) => {
  if (a === e) { passed++; console.log(`  ✅ ${n}`); }
  else { failed++; console.log(`  ❌ ${n} — got ${JSON.stringify(a)}, expected ${JSON.stringify(e)}`); }
};
const find = (rows, re) => rows.find(r => re.test(r.name));

console.log('\n── Tax recovered from order total (the EX Box 1 case) ──');
{
  // Real figures: $65.09 charged for 2 × $29.99, free shipping, tax never stored.
  const orders = [1, 2, 3].map(i => ({
    id: i, order_number: `90200367618575${i}`, retailer: 'Target', status: 'Delivered',
    items: '["2x Pokémon 30th Anniversary EX Box 1 @ $29.99"]',
    order_total: 65.09, tax_amount: 0, ship_cost: 0, finder_fee: 0,
  }));
  const [g] = computeItemGroups(orders, []);

  eq('qty summed across orders', g.qty, 6);
  eq('item cost unchanged',      g.perUnitItem, 29.99);
  eq('tax recovered per unit',   g.perUnitTax, 2.56);      // $5.11 / 2 units
  eq('landed = charged / units', g.perUnitTotal, 32.55);   // matches the list view's $32.55/unit
  eq('flagged as estimated',     g.taxEstimated, true);
  eq('order count',              g.orders, 3);
}

console.log('\n── A stored tax_amount is used as-is, not estimated ──');
{
  const [g] = computeItemGroups([{
    id: 1, retailer: 'Target', status: 'Delivered',
    items: '["2x Poster Collection @ $19.99"]',
    order_total: 43.39, tax_amount: 3.41, ship_cost: 0,
  }], []);
  eq('tax from email', g.perUnitTax, 1.71);
  eq('not flagged',    g.taxEstimated, false);
}

console.log('\n── Guard rails: implausible remainders are NOT called tax ──');
{
  // Stored total is wildly larger than the goods — likely spans several
  // shipments or is simply wrong. 25% cap refuses to invent a "tax".
  const [g] = computeItemGroups([{
    id: 1, retailer: 'Target', status: 'Delivered',
    items: '["1x Booster Box @ $50.00"]', order_total: 400.00, tax_amount: 0, ship_cost: 0,
  }], []);
  eq('no fake tax',     g.perUnitTax, 0);
  eq('not flagged',     g.taxEstimated, false);

  // A discount makes the total LOWER than the goods: no tax to recover.
  const [d] = computeItemGroups([{
    id: 2, retailer: 'Target', status: 'Delivered',
    items: '["1x Booster Box @ $50.00"]', order_total: 45.00, tax_amount: 0, ship_cost: 0,
  }], []);
  eq('discount → no tax', d.perUnitTax, 0);
}

console.log('\n── Unpriced items: tax must not be counted twice ──');
{
  // order_total already INCLUDES tax. The old fallback used the whole total as
  // the item cost and then added tax on top.
  const [g] = computeItemGroups([{
    id: 1, retailer: "Sam's Club", status: 'Delivered',
    items: '["2x POKEMON (Item 990518062) - in-club purchase"]',
    order_total: 111.96, tax_amount: 8.00, ship_cost: 0,
  }], []);
  eq('landed = total / units (no double tax)', g.perUnitTotal, 55.98);
  eq('item excludes the tax',                  g.perUnitItem, 51.98);
}

console.log('\n── Unknown cost is reported as unknown, not $0 ──');
{
  // The bot-API duplicate rows: no price anywhere, no total.
  const [g] = computeItemGroups([{
    id: 1, retailer: 'Target', status: 'Delivered',
    items: '["Pokemon TCG: 30th Celebration Tin (Sylveon or Espeon)"]',
    order_total: 0, tax_amount: 0, ship_cost: 0,
  }], []);
  eq('costUnknown set', g.costUnknown, true);
}

console.log('\n── "Pokémon" and "Pokemon" are ONE product ──');
{
  const orders = [
    { id: 1, retailer: 'Target', status: 'Delivered', order_total: 43.39,
      items: '["2x Pokémon Trading Card Game: 30th Celebration Tech Sticker Collection @ $19.99"]' },
    { id: 2, retailer: 'Target', status: 'Delivered', order_total: 43.39,
      items: '["2x Pokemon Trading Card Game: 30th Celebration Tech Sticker Collection @ $19.99"]' },
  ];
  const rows = computeItemGroups(orders, []);
  eq('merged into one row',           rows.length, 1);
  eq('qty combined',                  rows[0].qty, 4);
  eq('shows the short suggested name', rows[0].name, '30th Celebration Tech Sticker Collection');
  eq('flagged unlinked until confirmed', rows[0].unlinked, true);
  eq('both store titles kept for linking', rows[0].rawNames.length, 1); // same title once deaccented
}

console.log('\n── Retailers are reported per product ──');
{
  const rows = computeItemGroups([
    { id: 1, retailer: 'Target',      status: 'Delivered', order_total: 20, items: '["1x Sticker Set @ $19.99"]' },
    { id: 2, retailer: "Sam's Club",  status: 'Delivered', order_total: 20, items: '["1x Sticker Set @ $19.99"]' },
  ], []);
  eq('both retailers listed', rows[0].retailers.slice().sort().join('|'), "Sam's Club|Target");
}

console.log('\n── Saved buyer fee / sale price survive the spelling change ──');
{
  // Price was saved back when the row was labelled with the plain spelling.
  const rows = computeItemGroups([
    { id: 1, retailer: 'Target', status: 'Delivered', order_total: 43.39,
      items: '["2x Pokémon 30th Anniversary Poster Collection @ $19.99"]' },
  ], [{ sku: 'Pokemon 30th Anniversary Poster Collection', buyer_fee: 3, sale_price: 35 }]);
  eq('sale price still found', rows[0].sale_price, 35);
  eq('buyer fee still found',  rows[0].buyer_fee, 3);
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
