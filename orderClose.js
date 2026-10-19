'use strict';
// ─── CANCEL / REFUND ARITHMETIC FOR ONE ORDER ────────────────────────────────
// Kept free of the database so it can be tested (test/orderclose.test.js).
//
//   cancel → status Cancelled.
//   refund → how much came back. The whole amount still outstanding = fully
//            refunded (status Refunded, refunded_amount = order total). A
//            smaller amount is a partial refund: the status doesn't change.
//   An order with no total on file just becomes Refunded.
//
// A finder fee that isn't returned ("feeOwed") stays in your costs, but only
// once the order is dead (Cancelled / Refunded) — on a live order it's an
// ordinary fee and needs no flag.

const r2 = n => Math.round(n * 100) / 100;

function resolveClose(order, body) {
  body = body || {};
  const kind = body.kind;
  if (kind !== 'cancel' && kind !== 'refund') return { error: "kind must be 'cancel' or 'refund'" };
  if (order.status === 'Cancelled' || order.status === 'Refunded') return { error: 'This order is already ' + order.status.toLowerCase() };

  let feeOwed = null;
  if (body.finder_fee !== undefined && body.finder_fee !== null && body.finder_fee !== '') {
    feeOwed = Number(body.finder_fee);
    if (!Number.isFinite(feeOwed) || feeOwed < 0) return { error: 'Finder fee must be a number' };
    feeOwed = r2(feeOwed);
  }

  const total = Number(order.order_total) || 0;
  let refunded = Number(order.refunded_amount) || 0;
  let status = order.status;
  if (kind === 'cancel') {
    status = 'Cancelled';
  } else if (total <= 0) {
    status = 'Refunded';
  } else {
    const remaining = r2(total - refunded);
    let amt = body.amount === undefined || body.amount === null || body.amount === '' ? remaining : Number(body.amount);
    if (!Number.isFinite(amt) || amt <= 0) return { error: 'Refund must be more than $0' };
    amt = r2(amt);
    if (amt > remaining + 0.005) return { error: 'That is more than is left on this order ($' + remaining.toFixed(2) + ')' };
    const next = r2(refunded + amt);
    if (next >= total - 0.005) { status = 'Refunded'; refunded = total; }   // everything is back
    else refunded = next;                                                    // partial: keeps its status
  }
  const dead = status === 'Cancelled' || status === 'Refunded';
  return {
    status, refunded, dead, feeOwed,
    statusChanged: status !== order.status,
    partial: kind === 'refund' && status === order.status,
    feeKept: dead && feeOwed !== null && feeOwed > 0,
  };
}

module.exports = { resolveClose };
