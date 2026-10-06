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

console.log('\n── Stock = what you picked up and checked ──');
{
  const { itemKey } = require('../itemNames');
  const T = 'Test Elite Box';
  const mk = (id, status, extra = {}) => ({ id, retailer: 'Test', status, order_total: 106, items: `["2x ${T} @ $50.00"]`, ...extra });
  const orders = [
    mk(1, 'Delivered'), mk(2, 'Delivered'), mk(3, 'Delivered'),        // 6 units delivered
    mk(4, 'Shipped'), mk(5, 'Confirmed'),                               // 4 on the way
    mk(6, 'Shipped', { tracking_status: 'Delivered' }),                 // carrier says delivered
  ];
  const K = itemKey(T);

  const [legacy] = computeItemGroups(orders, []);
  eq('without check-in data: all 12 count', legacy.inHand, 12);

  const none = computeItemGroups(orders, [], undefined, [], { checkedIn: new Set(), issues: [] })[0];
  eq('nothing picked up: 0 in hand',     none.inHand, 0);
  eq('8 waiting to be picked up',        none.toPickUp, 8);
  eq('4 on the way',                     none.onTheWay, 4);
  eq('ordered qty unchanged',            none.qty, 12);
  eq('nothing sellable yet',             none.unitsLeft, 0);

  const issues = [
    { id: 1, order_id: 2, item_key: K, qty: 1, kind: 'missing', status: 'open' },
    { id: 2, order_id: 3, item_key: K, qty: 1, kind: 'wrong', got_item: 'Test Booster Bundle', status: 'claim_filed' },
  ];
  const g = computeItemGroups(orders, [], undefined,
    [{ id: 9, sku_key: T, qty: 1, unit_price: 70, fees: 0 }], { checkedIn: new Set([1, 2, 3]), issues })[0];
  eq('3 boxes checked: 6 − 2 in claims = 4 in hand', g.inHand, 4);
  eq('2 in claim',                        g.inClaim, 2);
  eq('claim value = 2 × landed',          g.claimValue, Math.round(2 * g.perUnitTotal * 100) / 100);
  eq('landed per unit unaffected',        g.perUnitTotal, legacy.perUnitTotal);
  eq('left to sell = 4 in hand − 1 sold', g.unitsLeft, 3);
  eq('still 2 to pick up (order 6)',      g.toPickUp, 2);
  eq('order line knows it was checked in', g.orderLines.find(l => l.id === 1).checked_in, true);

  const out = s => computeItemGroups(orders, [], undefined, [], { checkedIn: new Set([2, 3]), issues: issues.map(i => ({ ...i, status: s })) });
  const ref = out('refunded')[0];
  eq('refunded: units gone, not in claim', [ref.inHand, ref.inClaim, ref.refundedUnits].join(), '2,0,2');
  const wo = out('denied_writeoff')[0];
  eq('written off: units gone',           [wo.inHand, wo.writtenOff].join(), '2,2');

  // Wrong item kept: the Booster Bundle joins stock at what the Elite Box cost.
  const keep = out('denied_keep');
  const box = keep.find(x => /Elite/.test(x.name)), bb = keep.find(x => /Bundle/.test(x.name));
  eq('kept: missing one written off, wrong one moved', [box.inHand, box.writtenOff].join(), '2,1');
  eq('bundle now in stock',               bb && bb.inHand, 1);
  eq('bundle carries the cost you paid',  bb && bb.perUnitTotal, box.perUnitTotal);

  // Damaged but kept → back in stock.
  const dmg = computeItemGroups(orders, [], undefined, [], { checkedIn: new Set([1]),
    issues: [{ order_id: 1, item_key: K, qty: 1, kind: 'damaged', status: 'denied_keep' }] })[0];
  eq('damaged + kept → still in hand',    dmg.inHand, 2);
}

console.log('\n── Stock counts, oldest-first aging, stock at cost ──');
{
  const T = 'Test Count Box';
  const mk = (id, extra = {}) => ({ id, retailer: 'Test', status: 'Delivered', order_total: 100, items: `["2x ${T} @ $50.00"]`, ...extra });
  const orders = [mk(1), mk(2), mk(3), mk(4, { status: 'Shipped' })];
  const checkedIn = new Map([[1, '2026-09-01'], [2, '2026-09-10'], [3, '2026-09-20']]);   // 6 units picked up
  const sales = [{ id: 1, sku_key: T, qty: 3, unit_price: 70, fees: 0, sold_at: '2026-09-21' }];
  const run = adj => computeItemGroups(orders, [], undefined, sales, { checkedIn, issues: [], adjustments: adj })[0];

  const g = run([]);
  eq('in hand 6, sold 3 → 3 left',          [g.inHand, g.unitsLeft].join(), '6,3');
  eq('stock at cost = 3 × $50',             g.stockAtCost, 150);
  eq('on the way at cost = 2 × $50',        g.onTheWayCost, 100);
  // FIFO: the 3 sold came out of Sep 1 (2) and Sep 10 (1) → oldest left is Sep 10.
  eq('oldest unit still on the shelf',      g.oldestInStock, '2026-09-10');

  const short = run([{ id: 1, sku_key: T, qty: -1, unit_cost: 50, counted_at: '2026-09-25' }]);
  eq('count 1 short → 2 left',              short.unitsLeft, 2);
  eq('shortage is a loss at cost',          short.countLoss, 50);
  eq('in hand drops too',                   short.inHand, 5);
  eq('short unit taken oldest-first',       short.oldestInStock, '2026-09-20');
  eq('stock at cost follows',               short.stockAtCost, 100);

  const extra = run([{ id: 2, sku_key: T, qty: 2, unit_cost: 50 }]);
  eq('count 2 extra → 5 left',              [extra.unitsLeft, extra.extraUnits, extra.countLoss].join(), '5,2,0');

  const all = run([{ id: 3, sku_key: T, qty: -3, unit_cost: 50 }]);
  eq('everything gone → no oldest date',    [all.unitsLeft, all.oldestInStock].join(), '0,');
  const dup = run([{ id: 4, sku_key: T, qty: -1, unit_cost: 50 }, { id: 4, sku_key: T, qty: -1, unit_cost: 50 }]);
  eq('same correction counted once',        dup.shortUnits, 1);
  eq('category carried for filters',        g.categories.join(), 'Other');
}

console.log('\n── Real cost per unit, oldest first (the ETB $77 vs $91 report) ──');
{
  const T = 'Test Real ETB';
  // Cheap batch first (no fee), expensive batch later ($30 order fee on 2 units).
  const orders = [
    { id: 1, retailer: 'Test', status: 'Delivered', order_total: 140, items: `["2x ${T} @ $70.00"]` },
    { id: 2, retailer: 'Test', status: 'Delivered', order_total: 140, finder_fee: 30, items: `["2x ${T} @ $70.00"]` },
    { id: 3, retailer: 'Test', status: 'Shipped',   order_total: 140, items: `["2x ${T} @ $70.00"]` },   // on the way
  ];
  const checkedIn = new Map([[1, '2026-09-01'], [2, '2026-10-01']]);
  const run = sales => computeItemGroups(orders, [], undefined, sales, { checkedIn, issues: [], adjustments: [] })[0];

  const g0 = run([]);
  eq('average over everything bought',       g0.perUnitTotal, 75);          // (70×6 + 30) / 6
  eq('stock valued at the real batches',     g0.stockAtCost, 310);          // 2×70 + 2×85
  eq('cost/unit on the shelf',               g0.stockUnit.total, 77.5);
  eq('shelf fee share',                      g0.stockUnit.fee, 7.5);

  const g1 = run([{ id: 1, sku_key: T, qty: 2, unit_price: 100, fees: 0, sold_at: '2026-10-02' }]);
  eq('sale uses the OLDEST units ($70 each)', g1.sales[0].cost, 140);
  eq('profit from real cost',                g1.realizedProfit, 60);        // 200 − 140
  eq('ROI on real cost',                     g1.realizedROI, 0.4286);
  eq('what\'s left is the $85 batch',        [g1.unitsLeft, g1.stockAtCost, g1.stockUnit.total].join(), '2,170,85');

  const g2 = run([{ id: 1, sku_key: T, qty: 3, unit_price: 100, fees: 0, sold_at: '2026-10-02' }]);
  eq('3 sold = 2×$70 + 1×$85',               g2.sales[0].cost, 225);
  eq('spent = sold cost + stock cost',       Math.round((g2.soldCost + g2.stockAtCost) * 100) / 100, 310);

  // Two sales: the EARLIER sale gets the older units, whatever order they were typed in.
  const g3 = run([{ id: 9, sku_key: T, qty: 1, unit_price: 100, fees: 0, sold_at: '2026-10-05' },
                  { id: 8, sku_key: T, qty: 2, unit_price: 100, fees: 0, sold_at: '2026-10-02' }]);
  const byId = id => g3.sales.find(x => x.id === id);
  eq('earlier sale: the two $70 units',      byId(8).cost, 140);
  eq('later sale: the next unit ($85)',      byId(9).cost, 85);
}

console.log('\n── Partner units: each sale\'s money goes to whose units were sold ──');
{
  const T = 'Test Pal Box';
  const orders = [
    { id: 1, retailer: 'Test', status: 'Delivered', order_total: 20, items: `["2x ${T} @ $10.00"]` },                  // mine, oldest
    { id: 2, retailer: 'Test', status: 'Delivered', order_total: 60, items: `["3x ${T} @ $20.00"]`, partner_id: 7 },   // his
  ];
  const checkedIn = new Map([[1, '2026-09-01'], [2, '2026-09-05']]);
  const run = sales => computeItemGroups(orders, [], undefined, sales, { checkedIn, issues: [] })[0];
  const g0 = run([]);
  eq('shelf: 2 mine, 3 his',                 [g0.stockByOwner[0].units, g0.stockByOwner[7].units].join(), '2,3');
  eq('his stock at his cost',                g0.stockByOwner[7].cost, 60);
  const g = run([{ id: 1, sku_key: T, qty: 3, unit_price: 30, fees: 3, sold_at: '2026-09-10' }]);
  const parts = Object.fromEntries(g.sales[0].parts.map(x => [x.owner, x]));
  eq('2 of mine + 1 of his sold (oldest first)', [parts[0].qty, parts[7].qty].join(), '2,1');
  eq('his share of revenue',                 parts[7].revenue, 30);
  eq('selling fees split by units',          [parts[0].fees, parts[7].fees].join(), '2,1');
  eq('his unit at his cost',                 parts[7].cost, 20);
  eq('left on shelf: 2 of his',              [g.stockByOwner[0] ? g.stockByOwner[0].units : 0, g.stockByOwner[7].units].join(), '0,2');
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
