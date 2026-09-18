'use strict';
// Tests for determineStatus().
//
// The bug these exist to prevent: the old version did `body.includes('cancel')`,
// and every retailer footer contains "Cancel order" / "cancellation policy". So
// every shipping email — tracking number and all — was stored as Cancelled.

const Module = require('module');
const originalLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'node-imap')  return function Imap() {};
  if (request === 'mailparser') return { simpleParser: async () => ({}) };
  return originalLoad.apply(this, [request, ...rest]);
};

const { __test } = require('../emailScraper');
const determineStatus = __test.determineStatus;

let passed = 0, failed = 0;
function eq(name, actual, expected) {
  if (actual === expected) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name} — got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`); }
}

// Footer text that appears verbatim on nearly every retailer email.
const FOOTER = `
  Need to make changes? Act fast.
  You can cancel this order within 30 minutes of placing it.
  Cancel order | Track order | Return policy
  See our cancellation policy and refund policy for details.
  Questions? Contact us. Unsubscribe.
`;

console.log('\n── Footer text must NOT drive status ──');

eq('shipping email with cancel link → Shipped',
   determineStatus('Your order has shipped', `Your package is on its way. ${FOOTER}`, { hasTracking: true }),
   'Shipped');

eq('confirmation with cancel link → Confirmed',
   determineStatus('Thanks for your order', `Your order has been placed. ${FOOTER}`, { hasTracking: false }),
   'Confirmed');

eq('delivered email with cancel link → Delivered',
   determineStatus('Your order was delivered', `Your package was delivered to the front door. ${FOOTER}`, { hasTracking: true }),
   'Delivered');

eq('refund policy in footer must not mean Refunded',
   determineStatus('Thanks for your order', `Your order has been placed. ${FOOTER}`, { hasTracking: false }),
   'Confirmed');

console.log('\n── Real cancellations must still be caught ──');

eq('subject says cancelled',
   determineStatus('Your Target order was cancelled', `We're sorry. ${FOOTER}`, { hasTracking: false }),
   'Cancelled');

eq('body states cancellation',
   determineStatus('Update on your order', `Your order has been cancelled and you will not be charged. ${FOOTER}`, { hasTracking: false }),
   'Cancelled');

eq('"we have cancelled" phrasing',
   determineStatus('Order update', `We have cancelled the items below. ${FOOTER}`, { hasTracking: false }),
   'Cancelled');

console.log('\n── Real refunds must still be caught ──');

eq('subject says refund',
   determineStatus('Your refund has been issued', `Details below. ${FOOTER}`, { hasTracking: false }),
   'Refunded');

eq('body states refund issued',
   determineStatus('Order update', `Your refund has been processed to your card. ${FOOTER}`, { hasTracking: false }),
   'Refunded');

console.log('\n── Delivery estimates must not read as Delivered ──');

eq('estimated delivery date is not Delivered',
   determineStatus('Your estimated delivery is Sep 22', `Arrives Sep 17 - Sep 22. Delivery by end of day. ${FOOTER}`, { hasTracking: true }),
   'Shipped');

eq('"delivery date" wording is not Delivered',
   determineStatus('Order shipped', `Expected delivery date: Sep 20. ${FOOTER}`, { hasTracking: true }),
   'Shipped');

console.log('\n── Tracking implies shipped when nothing else is stated ──');

eq('bare tracking email → Shipped',
   determineStatus('Tracking for your order', `Here is your tracking info. ${FOOTER}`, { hasTracking: true }),
   'Shipped');

eq('out for delivery',
   determineStatus('Out for delivery', `Your package is out for delivery today. ${FOOTER}`, { hasTracking: true }),
   'OFD');

console.log(`\n${'─'.repeat(60)}`);
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
