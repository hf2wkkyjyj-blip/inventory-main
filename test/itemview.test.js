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

console.log('\n── Per-unit finder fee is part of landed cost ──');
{
  // Reported: typed $8 in FINDER FEE and landed cost didn't move.
  const orders = [1, 2, 3].map(i => ({
    id: i, retailer: 'Target', status: 'Delivered',
    items: '["2x Pokémon 30th Anniversary EX Box 1 @ $29.99"]', order_total: 65.09,
  }));
  const [base] = computeItemGroups(orders, []);
  const [g]    = computeItemGroups(orders, [{ sku: 'Pokémon 30th Anniversary EX Box 1', buyer_fee: 8, sale_price: 50 }]);
  eq('landed without fee',          base.perUnitTotal, 32.55);
  eq('landed rises by exactly $8',  g.perUnitTotal, 40.55);
  eq('finder line shows the $8',    g.perUnitFinder, 8);
  eq('other lines unchanged',       [g.perUnitItem, g.perUnitTax, g.perUnitShip].join(), [base.perUnitItem, base.perUnitTax, base.perUnitShip].join());
  eq('box share 0 when only a typed fee', g.perUnitBoxFee, 0);
  eq('breakdown still adds up',     Math.round((g.perUnitItem + g.perUnitTax + g.perUnitShip + g.perUnitFinder) * 100) / 100, g.perUnitTotal);
}

console.log('\n── Sales recorded in parts ──');
{
  const TITLE = 'Pokémon 30th Anniversary EX Box 1';
  const orders = [1, 2, 3].map(i => ({
    id: i, retailer: 'Target', status: 'Delivered', items: `["2x ${TITLE} @ $29.99"]`, order_total: 65.09,
  }));
  const pricing = [{ sku: TITLE, buyer_fee: 8, sale_price: 50 }];

  const [none] = computeItemGroups(orders, pricing, undefined, []);
  eq('nothing sold yet',             none.soldQty, 0);
  eq('no realized profit yet',       none.realizedProfit, null);
  eq('all 6 left',                   none.unitsLeft, 6);
  eq('expected on all 6 at asking',  none.expectedProfitLeft, 56.7);   // 6 × (50 − 40.55)

  const sales = [
    { id: 1, sku_key: TITLE, qty: 2, unit_price: 50, fees: 0, channel: 'Local', sold_at: '2026-09-20' },
    { id: 2, sku_key: TITLE, qty: 1, unit_price: 55, fees: 4, channel: 'eBay',  sold_at: '2026-09-25' },
  ];
  const [g] = computeItemGroups(orders, pricing, undefined, sales);
  eq('sold 3',                       g.soldQty, 3);
  eq('gross',                        g.soldGross, 155);
  eq('fees',                         g.soldFees, 4);
  eq('average price',                g.avgSalePrice, 51.67);
  // 155 − 4 − 3 × 40.55 (landed already includes the $8 fee — not taken twice)
  eq('realized profit exact',        g.realizedProfit, 29.35);
  eq('3 left',                       g.unitsLeft, 3);
  eq('expected on the 3 left',       g.expectedProfitLeft, 28.35);
  eq('history newest first',         g.sales.map(x => x.id).join(), '2,1');
  eq('realized ROI = 29.35 / 121.65', g.realizedROI, 0.2413);
  eq('no ROI before any sale',        none.realizedROI, null);

  // Deleting a sale = it's just gone from the rows.
  const [after] = computeItemGroups(orders, pricing, undefined, sales.slice(0, 1));
  eq('after deleting one: sold 2',   after.soldQty, 2);
  eq('after deleting one: 4 left',   after.unitsLeft, 4);

  // Sale recorded under the store title, product linked later: still counted,
  // and a row reachable by two keys is counted once.
  const catalog = { products: new Map([[7, { id: 7, name: 'EX Box 1' }]]),
                    aliases:  new Map([[require('../itemNames').itemKey(TITLE), 7]]) };
  const mixed = [
    { id: 10, sku_key: '#p7', qty: 1, unit_price: 50, fees: 0, sold_at: '2026-09-26' },
    { id: 11, sku_key: TITLE, qty: 1, unit_price: 50, fees: 0, sold_at: '2026-09-21' },
  ];
  const [linked] = computeItemGroups(orders, pricing, catalog, mixed);
  eq('sales under both keys found',  linked.soldQty, 2);
  const [dup] = computeItemGroups(orders, pricing, catalog, [mixed[0], mixed[0]]);
  eq('same sale never counted twice', dup.soldQty, 1);

  // Oversold (units bought elsewhere): left never goes negative.
  const [over] = computeItemGroups(orders, pricing, undefined, [{ id: 20, sku_key: TITLE, qty: 9, unit_price: 50 }]);
  eq('units left floors at 0',       over.unitsLeft, 0);
  eq('no expected profit when none left', over.expectedProfitLeft, null);
}

console.log('\n── Box/order fee share is reported separately ──');
{
  const orders = [{ id: 1, retailer: 'Test', status: 'Delivered', order_total: 125, finder_fee: 75,
                    items: '["12x Test Knock Out @ $9.99"]' }];
  const [g]  = computeItemGroups(orders, []);
  eq('box share per unit',          g.perUnitBoxFee, 6.25);
  eq('finder line = box share',     g.perUnitFinder, 6.25);
  const [g2] = computeItemGroups(orders, [{ sku: 'Test Knock Out', buyer_fee: 1 }]);
  eq('box share unchanged by extra', g2.perUnitBoxFee, 6.25);
  eq('finder line = box + extra',    g2.perUnitFinder, 7.25);
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
