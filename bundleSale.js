'use strict';
// ─── SELL SEVERAL PRODUCTS AS ONE ────────────────────────────────────────────
//
// One buyer, one payout, one set of fees — saved as one sale row per product
// (bot_sales), tied together by bundle_id. Profit, stock and the Sold list keep
// working per product exactly as before.
//
// Two ways to price it:
//   'each'  every product has its own price per unit.
//   'total' one total payout, split over the products by `weight` (the caller
//           sends qty × landed cost, so every product ends up with the same
//           margin). No weights → split by units.
//
// Everything is counted in cents so the saved rows add up to EXACTLY what was
// typed. A line total that doesn't divide evenly into its units becomes two
// rows (e.g. 3 units for $10.00 → 2 × $3.33 and 1 × $3.34).

const cents = n => Math.round((Number(n) || 0) * 100);

/** Split `total` cents over `weights` (≥ 0) so the parts add up to `total` exactly (largest remainder). */
function splitCents(total, weights) {
  const sum = weights.reduce((a, w) => a + w, 0);
  const w = sum > 0 ? weights : weights.map(() => 1);
  const W = sum > 0 ? sum : weights.length;
  const exact = w.map(x => total * x / W);
  const out = exact.map(Math.floor);
  let left = total - out.reduce((a, x) => a + x, 0);
  exact.map((x, i) => [x - Math.floor(x), i]).sort((a, b) => b[0] - a[0] || a[1] - b[1])
    .slice(0, left).forEach(([, i]) => { out[i]++; });
  return out;
}

/**
 * @param {{lines: {sku_key:string, product_name?:string, qty:number, unit_price?:number, weight?:number}[],
 *          mode: 'each'|'total', total?: number, fees?: number}} input
 * @returns {{error:string} | {rows, lines, revenue, fees}}
 */
function allocateBundle({ lines, mode, total, fees }) {
  if (!Array.isArray(lines) || !lines.length) return { error: 'Pick at least one product' };
  const seen = new Set();
  for (const l of lines) {
    if (!l || typeof l.sku_key !== 'string' || !l.sku_key) return { error: 'Each line needs a product' };
    if (seen.has(l.sku_key)) return { error: 'The same product is listed twice' };
    seen.add(l.sku_key);
    if (!Number.isInteger(Number(l.qty)) || Number(l.qty) < 1) return { error: 'Quantity must be a whole number of at least 1' };
  }
  const feeC = fees === undefined || fees === null || fees === '' ? 0 : cents(fees);
  if (!Number.isFinite(feeC) || feeC < 0) return { error: 'Fees must be a number' };

  // Each line's total in cents.
  let lineC;
  if (mode === 'total') {
    const t = Number(total);
    if (total === undefined || total === '' || !Number.isFinite(t) || t < 0) return { error: 'Enter the total payout' };
    const w = lines.map(l => Math.max(0, Number(l.weight) || 0));
    lineC = splitCents(cents(t), w.some(x => x > 0) ? w : lines.map(l => Number(l.qty)));      // no cost known → by units
  } else if (mode === 'each') {
    for (const l of lines) {
      const p = Number(l.unit_price);
      if (l.unit_price === undefined || l.unit_price === '' || !Number.isFinite(p) || p < 0) return { error: 'Enter a price for every product' };
    }
    lineC = lines.map(l => Number(l.qty) * cents(l.unit_price));
  } else return { error: 'mode must be each or total' };

  const feeParts = splitCents(feeC, lineC.some(x => x > 0) ? lineC : lines.map(l => Number(l.qty)));   // fees follow the money
  const rows = [], out = [];
  lines.forEach((l, i) => {
    const q = Number(l.qty), L = lineC[i];
    const base = Math.floor(L / q), r = L - base * q;
    const mk = (qty, c, f) => ({ sku_key: l.sku_key, product_name: l.product_name || null, qty, unit_price: c / 100, fees: f / 100 });
    if (r === 0) rows.push(mk(q, base, feeParts[i]));
    else {
      const [fa, fb] = splitCents(feeParts[i], [(q - r) * base, r * (base + 1)]);       // both rows carry their share of the fee
      rows.push(mk(q - r, base, fa)); rows.push(mk(r, base + 1, fb));
    }
    out.push({ sku_key: l.sku_key, qty: q, revenue: L / 100, unit: Math.round(L / q) / 100, fees: feeParts[i] / 100 });
  });
  return { rows, lines: out, revenue: lineC.reduce((a, x) => a + x, 0) / 100, fees: feeC / 100 };
}

module.exports = { allocateBundle, splitCents };
