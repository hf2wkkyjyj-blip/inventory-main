'use strict';
// Box fee split (feeSplit.js), and that the landed cost in the item view
// ends up carrying exactly the per-unit fee the preview promised.
// All data here is made up.

const { splitBoxFee } = require('../feeSplit');
const { computeItemGroups } = require('../itemView');

let passed = 0, failed = 0;
const eq = (n, a, e) => {
  const ok = JSON.stringify(a) === JSON.stringify(e);
  if (ok) { passed++; console.log(`  ✅ ${n}`); }
  else { failed++; console.log(`  ❌ ${n} — got ${JSON.stringify(a)}, expected ${JSON.stringify(e)}`); }
};
const item = (r, re) => r.items.find(i => re.test(i.name));

console.log('\n── One order, 7 items, $100 fee — split by retail ──');
{
  const order = { id: 1, order_number: 'T1', order_total: 400,
    items: JSON.stringify(['2x Test Elite Trainer Box @ $59.99', '3x Test Booster Bundle @ $49.99', '2x Test Collector Tin @ $65.02']) };
  const r = splitBoxFee([order], 100);
  eq('retail total',            r.retail, 399.99);
  eq('basis is retail',         r.basis, 'retail');
  eq('rate ≈ 25%',              Math.round(r.rate * 1000) / 10, 25);
  eq('whole fee on the order',  r.orders[0].fee, 100);
  eq('ETB share',               item(r, /ETB/).fee, 30);
  eq('ETB per unit',            item(r, /ETB/).perUnit, 15);
  eq('Bundle per unit',         item(r, /Bundle/).perUnit, 12.5);
  eq('Tin per unit',            item(r, /Tin/).perUnit, 16.26);
  eq('item shares add to $100', Math.round(r.items.reduce((s, i) => s + i.fee, 0) * 100) / 100, 100);
}

console.log('\n── Whole box: two orders on one tracking ──');
{
  const orders = [
    { id: 1, order_number: 'F01', order_total: 140, items: JSON.stringify(['2x Test Deck Box @ $60.00', '1x Test Tin @ $20.00']) },
    { id: 2, order_number: 'F02', order_total: 120, items: JSON.stringify(['3x Test Bundle @ $40.00']) },
  ];
  const r = splitBoxFee(orders, 100);
  eq('box retail',              r.retail, 260);
  eq('order shares',            r.orders.map(o => o.fee), [53.85, 46.15]);
  eq('shares add up exactly',   Math.round(r.orders.reduce((s, o) => s + o.fee, 0) * 100) / 100, 100);
  eq('same rate across orders', [item(r, /Deck/).perUnit, item(r, /Bundle/).perUnit], [23.08, 15.38]);

  // Save the shares the way the endpoint does, then check landed cost.
  const saved = orders.map((o, i) => ({ ...o, retailer: 'Test', status: 'Delivered', finder_fee: r.orders[i].fee }));
  const groups = computeItemGroups(saved, []);
  const g = re => groups.find(x => re.test(x.name));
  eq('item view finder = preview (Deck)',   g(/Deck/).perUnitFinder,   item(r, /Deck/).perUnit);
  eq('item view finder = preview (Bundle)', g(/Bundle/).perUnitFinder, item(r, /Bundle/).perUnit);
  eq('Deck landed = $60 + $23.08',          g(/Deck/).perUnitTotal, 83.08);
}

console.log('\n── Rounding remainder never loses or adds a cent ──');
{
  const orders = [1, 2, 3].map(i => ({ id: i, order_total: 10, items: JSON.stringify(['1x Test Pack @ $10.00']) }));
  const r = splitBoxFee(orders, 100);
  eq('three-way split of $100',  r.orders.map(o => o.fee).sort(), [33.33, 33.33, 33.34]);
  eq('sum is exactly $100',      Math.round(r.orders.reduce((s, o) => s + o.fee, 0) * 100) / 100, 100);
}

console.log('\n── No item prices ──');
{
  const r = splitBoxFee([
    { id: 1, order_total: 90,  tax_amount: 10, items: JSON.stringify(['2x Test Box A']) },
    { id: 2, order_total: 50,  items: JSON.stringify(['1x Test Box B']) },
  ], 30);
  eq('uses charged goods (total − tax)', r.retail, 130);
  eq('order shares by goods value',      r.orders.map(o => o.fee), [18.46, 11.54]);

  const z = splitBoxFee([{ id: 1, items: JSON.stringify(['2x Test A']) }, { id: 2, items: JSON.stringify(['1x Test B']) }], 30);
  eq('nothing known → split by units',   [z.basis, ...z.orders.map(o => o.fee)], ['units', 20, 10]);
}

console.log('\n── Zero clears ──');
{
  const r = splitBoxFee([{ id: 1, order_total: 50, items: '["1x Test @ $50.00"]' }], 0);
  eq('all shares 0', r.orders.map(o => o.fee), [0]);
}

console.log('\n── Similar-order fingerprint ──');
{
  const { orderSignature: sig } = require('../feeSplit');
  const o = (retailer, items) => ({ retailer, items: JSON.stringify(items) });
  const base = sig(o('Mattel Creations', ['2x Test Car F40 @ $32.50']));
  eq('same store + items + qty match',      sig(o('Mattel Creations', ['2x Test Car F40 @ $32.50'])), base);
  eq('price difference still matches',      sig(o('Mattel Creations', ['2x Test Car F40 @ $30.00'])), base);
  eq('store name case/spaces ignored',      sig(o(' mattel creations ', ['2x Test Car F40'])), base);
  eq('different qty → no match',            sig(o('Mattel Creations', ['1x Test Car F40'])) === base, false);
  eq('different store → no match',          sig(o('Target', ['2x Test Car F40'])) === base, false);
  eq('extra item → no match',               sig(o('Mattel Creations', ['2x Test Car F40', '1x Test Tin'])) === base, false);
  eq('item order in the list ignored',
     sig(o('S', ['3x Test Bundle', '1x Test Tin'])), sig(o('S', ['1x Test Tin', '3x Test Bundle'])));
  eq('same item on two lines = summed qty', sig(o('S', ['1x Test Car', '1x Test Car'])), sig(o('S', ['2x Test Car'])));
  eq('no items → no fingerprint',           sig(o('S', [])), null);
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
