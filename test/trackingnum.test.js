'use strict';
// Tracking numbers: read whatever follows the label, in any format
// (parser/tracking.js). All values made up.
const { findTrackingNumber: f } = require('../parser/tracking');

let passed = 0, failed = 0;
const eq = (n, a, e) => {
  if (a === e) { passed++; console.log(`  ✅ ${n}`); }
  else { failed++; console.log(`  ❌ ${n} — got ${JSON.stringify(a)}, expected ${JSON.stringify(e)}`); }
};

console.log('\n── After the label, any format ──');
eq('877… on the next line (the reported miss)', f('Tracking Number:\r\n 877000000123 \r\n Payment will be taken'), '877000000123');
eq('a format nobody has seen yet',  f('Tracking Number: 878000000001'), '878000000001');
eq('Mattel markdown link',          f('[Tracking #1ZAA11110000000009](https://ups.com/x)'), '1ZAA11110000000009');
eq('USPS printed with spaces',      f('Tracking Number: 9400 1118 9922 3856 9256 83 Delivered'), '9400111899223856925683');
eq('Amazon',                        f('Tracking ID: TBA123456789012'), 'TBA123456789012');
eq('DHL',                           f('Tracking: JD014600006281234567'), 'JD014600006281234567');
eq('words after it are not taken',  f('Tracking Number: 870000000999 Sincerely, Store'), '870000000999');

console.log('\n── Not a tracking number ──');
eq('"unavailable" is a word, not a number', f('Tracking number: unavailable'), null);
eq('"pending confirmation"',        f('Tracking: PendingConfirmation'), null);
eq('"will be emailed"',             f('Your tracking number will be emailed when it ships'), null);
eq('never the order number',        f('Tracking: 102000000000011', { orderNumber: '102000000000011' }), null);
eq('order number alone',            f('Order #902000000000022 placed. Total $65.09'), null);
eq('empty',                         f(''), null);

console.log('\n── No label: known shapes as a fallback ──');
eq('UPS in a sentence',             f('Your package 1ZAA11110000000001 is on the way'), '1ZAA11110000000001');
eq('Pokemon Center 876',            f('Shipped 876000000001 today'), '876000000001');

console.log(`\n${'─'.repeat(60)}`);
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
