'use strict';
// Selling several products as one: own prices or one total, exact to the cent.
const { allocateBundle, splitCents } = require('../bundleSale');
let passed = 0, failed = 0;
const eq = (n, a, b) => { if (JSON.stringify(a) === JSON.stringify(b)) { passed++; console.log(`  ✅ ${n}`); } else { failed++; console.log(`  ❌ ${n} — got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`); } };
const sum = (rows, f) => Math.round(rows.reduce((a, r) => a + f(r), 0) * 100) / 100;

console.log('\n── Each product at its own price ──');
{
  const r = allocateBundle({ mode: 'each', fees: 5, lines: [
    { sku_key: '#p1', product_name: 'Ferrari F40', qty: 2, unit_price: 40 },
    { sku_key: '#p2', product_name: 'Skyline GT-R', qty: 1, unit_price: 20 } ] });
  eq('one row per product',            r.rows.map(x => [x.sku_key, x.qty, x.unit_price]), [['#p1', 2, 40], ['#p2', 1, 20]]);
  eq('revenue = 2×40 + 20',            r.revenue, 100);
  eq('fees follow the money (80/20)',  r.rows.map(x => x.fees), [4, 1]);
  eq('per-line summary',               r.lines.map(l => [l.revenue, l.unit, l.fees]), [[80, 40, 4], [20, 20, 1]]);
}

console.log('\n── One total, split by landed cost ──');
{
  // Costs: A 2 × $10 = $20, B 1 × $30 = $30 → 40% / 60% of $100.
  const r = allocateBundle({ mode: 'total', total: 100, fees: 0, lines: [
    { sku_key: 'A', qty: 2, weight: 20 }, { sku_key: 'B', qty: 1, weight: 30 } ] });
  eq('A gets $40 (2 × $20), B gets $60', r.rows.map(x => [x.sku_key, x.qty, x.unit_price]), [['A', 2, 20], ['B', 1, 60]]);
  eq('adds up to the payout',            r.revenue, 100);
  const odd = allocateBundle({ mode: 'total', total: 100, lines: [
    { sku_key: 'A', qty: 1, weight: 1 }, { sku_key: 'B', qty: 1, weight: 1 }, { sku_key: 'C', qty: 1, weight: 1 } ] });
  eq('$100 over 3 equal items = 33.34 / 33.33 / 33.33', odd.rows.map(x => x.unit_price), [33.34, 33.33, 33.33]);
  eq('…still exactly $100',              sum(odd.rows, x => x.qty * x.unit_price), 100);
  const none = allocateBundle({ mode: 'total', total: 90, lines: [{ sku_key: 'A', qty: 1 }, { sku_key: 'B', qty: 2 }] });
  eq('no cost known → split by units',   none.lines.map(l => l.revenue), [30, 60]);
}

console.log('\n── A line that does not divide into its units ──');
{
  const r = allocateBundle({ mode: 'total', total: 10, lines: [{ sku_key: 'A', qty: 3, weight: 5 }] });
  eq('3 units for $10 → 2 × $3.33 + 1 × $3.34', r.rows.map(x => [x.qty, x.unit_price]), [[2, 3.33], [1, 3.34]]);
  eq('exactly $10',                       sum(r.rows, x => x.qty * x.unit_price), 10);
  const f = allocateBundle({ mode: 'total', total: 10, fees: 1, lines: [{ sku_key: 'A', qty: 3, weight: 5 }] });
  eq('the fee is shared by its rows (6.66 / 3.34)', f.rows.map(x => x.fees), [0.67, 0.33]);
  eq('…and adds up to the fee',          sum(f.rows, x => x.fees), 1);
}

console.log('\n── Always exact (random sweep) ──');
{
  let bad = 0;
  for (let n = 0; n < 500; n++) {
    const k = 1 + Math.floor(Math.random() * 5);
    const lines = Array.from({ length: k }, (_, i) => ({ sku_key: 'K' + i, qty: 1 + Math.floor(Math.random() * 6), weight: Math.random() * 90 }));
    const total = Math.round(Math.random() * 100000) / 100, fees = Math.round(Math.random() * 3000) / 100;
    const r = allocateBundle({ mode: 'total', total, fees, lines });
    if (r.error || sum(r.rows, x => x.qty * x.unit_price) !== total || sum(r.rows, x => x.fees) !== fees
        || lines.some(l => r.rows.filter(x => x.sku_key === l.sku_key).reduce((a, x) => a + x.qty, 0) !== l.qty)) bad++;
  }
  eq('500 random bundles: total, fees and units all exact', bad, 0);
}

console.log('\n── Bad input ──');
eq('nothing picked',             allocateBundle({ mode: 'each', lines: [] }).error, 'Pick at least one product');
eq('same product twice',         allocateBundle({ mode: 'each', lines: [{ sku_key: 'A', qty: 1, unit_price: 1 }, { sku_key: 'A', qty: 1, unit_price: 1 }] }).error, 'The same product is listed twice');
eq('quantity 0',                 allocateBundle({ mode: 'each', lines: [{ sku_key: 'A', qty: 0, unit_price: 1 }] }).error, 'Quantity must be a whole number of at least 1');
eq('quantity 1.5',               allocateBundle({ mode: 'each', lines: [{ sku_key: 'A', qty: 1.5, unit_price: 1 }] }).error, 'Quantity must be a whole number of at least 1');
eq('missing price',              allocateBundle({ mode: 'each', lines: [{ sku_key: 'A', qty: 1 }] }).error, 'Enter a price for every product');
eq('negative price',             allocateBundle({ mode: 'each', lines: [{ sku_key: 'A', qty: 1, unit_price: -1 }] }).error, 'Enter a price for every product');
eq('missing total',              allocateBundle({ mode: 'total', lines: [{ sku_key: 'A', qty: 1 }] }).error, 'Enter the total payout');
eq('negative fees',              allocateBundle({ mode: 'each', fees: -2, lines: [{ sku_key: 'A', qty: 1, unit_price: 1 }] }).error, 'Fees must be a number');
eq('unknown mode',               allocateBundle({ mode: 'x', lines: [{ sku_key: 'A', qty: 1 }] }).error, 'mode must be each or total');
eq('$0 total is allowed (give-away)', allocateBundle({ mode: 'total', total: 0, lines: [{ sku_key: 'A', qty: 2 }] }).revenue, 0);
eq('splitCents keeps the sum',   splitCents(100, [1, 1, 1]).reduce((a, b) => a + b, 0), 100);

console.log(`\n${'─'.repeat(60)}`);
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
