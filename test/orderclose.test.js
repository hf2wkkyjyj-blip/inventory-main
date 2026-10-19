'use strict';
// Cancel / refund arithmetic (orderClose.js): what status an order ends up in,
// what counts as refunded, and when a finder fee is kept as a loss.
// All data here is made up.

const { resolveClose } = require('../orderClose');

let passed = 0, failed = 0;
const eq = (n, a, e) => {
  const ok = JSON.stringify(a) === JSON.stringify(e);
  if (ok) { passed++; console.log(`  ✅ ${n}`); }
  else { failed++; console.log(`  ❌ ${n} — got ${JSON.stringify(a)}, expected ${JSON.stringify(e)}`); }
};
const order = (o = {}) => Object.assign({ status: 'Shipped', order_total: 174.06, refunded_amount: 0 }, o);

console.log('\n── Cancel ──');
{
  const r = resolveClose(order({ status: 'Confirmed' }), { kind: 'cancel' });
  eq('status Cancelled',              r.status, 'Cancelled');
  eq('status changed',                r.statusChanged, true);
  eq('no fee given → no fee kept',    r.feeKept, false);
  const k = resolveClose(order(), { kind: 'cancel', finder_fee: 100 });
  eq('fee still owed is kept',        [k.feeKept, k.feeOwed], [true, 100]);
  eq('fee 0 → nothing kept',          resolveClose(order(), { kind: 'cancel', finder_fee: 0 }).feeKept, false);
  eq('fee as text works',             resolveClose(order(), { kind: 'cancel', finder_fee: '12.345' }).feeOwed, 12.35);
  eq('negative fee rejected',         !!resolveClose(order(), { kind: 'cancel', finder_fee: -1 }).error, true);
  eq('junk fee rejected',             !!resolveClose(order(), { kind: 'cancel', finder_fee: 'abc' }).error, true);
}

console.log('\n── Full refund ──');
{
  const r = resolveClose(order(), { kind: 'refund' });
  eq('blank amount = everything',     [r.status, r.refunded, r.partial], ['Refunded', 174.06, false]);
  const e = resolveClose(order(), { kind: 'refund', amount: 174.06 });
  eq('exact total = Refunded',        e.status, 'Refunded');
  eq('a cent short still full',       resolveClose(order(), { kind: 'refund', amount: 174.055 }).status, 'Refunded');
  const f = resolveClose(order(), { kind: 'refund', finder_fee: 100 });
  eq('fee kept on a refund',          [f.feeKept, f.dead], [true, true]);
  eq('more than the total rejected',  resolveClose(order(), { kind: 'refund', amount: 999 }).error, 'That is more than is left on this order ($174.06)');
}

console.log('\n── Partial refund ──');
{
  const p = resolveClose(order(), { kind: 'refund', amount: 50, finder_fee: 9 });
  eq('keeps its status',              [p.status, p.statusChanged, p.partial], ['Shipped', false, true]);
  eq('refunded goes up',              p.refunded, 50);
  eq('not dead → fee not flagged',    [p.dead, p.feeKept], [false, false]);
  const rest = resolveClose(order({ refunded_amount: 50 }), { kind: 'refund' });
  eq('the rest completes it',         [rest.status, rest.refunded], ['Refunded', 174.06]);
  eq('only what is left is allowed',  resolveClose(order({ refunded_amount: 50 }), { kind: 'refund', amount: 130 }).error, 'That is more than is left on this order ($124.06)');
  eq('refund twice adds up',          resolveClose(order({ refunded_amount: 50 }), { kind: 'refund', amount: 24.06 }).refunded, 74.06);
  eq('$0 refund rejected',            !!resolveClose(order(), { kind: 'refund', amount: 0 }).error, true);
}

console.log('\n── Odd orders and bad requests ──');
{
  const z = resolveClose(order({ order_total: 0 }), { kind: 'refund' });
  eq('no total → just Refunded',      [z.status, z.dead], ['Refunded', true]);
  eq('already cancelled',             resolveClose(order({ status: 'Cancelled' }), { kind: 'cancel' }).error, 'This order is already cancelled');
  eq('already refunded',              resolveClose(order({ status: 'Refunded' }), { kind: 'refund' }).error, 'This order is already refunded');
  eq('unknown kind',                  !!resolveClose(order(), { kind: 'delete' }).error, true);
  eq('no body',                       !!resolveClose(order(), undefined).error, true);
  const c = resolveClose(order({ refunded_amount: 20 }), { kind: 'cancel' });
  eq('cancel keeps an earlier partial refund figure', c.refunded, 20);
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
