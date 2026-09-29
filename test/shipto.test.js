'use strict';
// Reading the ship-to address from order emails (parser/shipTo.js), and the
// scraper saving it. Emails are made up but copy each store's real layout.

const Module = require('module');
const origLoad = Module._load;
Module._load = function (req, ...rest) {
  if (req === 'node-imap')  return function Imap() {};
  if (req === 'mailparser') return { simpleParser: async () => ({}) };
  return origLoad.apply(this, [req, ...rest]);
};
process.removeAllListeners('warning');

const { extractShipTo } = require('../parser/shipTo');
const { parseOrderEmail } = require('../parser');

let passed = 0, failed = 0;
const eq = (n, a, e) => {
  const ok = JSON.stringify(a) === JSON.stringify(e);
  if (ok) { passed++; console.log(`  ✅ ${n}`); }
  else { failed++; console.log(`  ❌ ${n} — got ${JSON.stringify(a)}, expected ${JSON.stringify(e)}`); }
};

// Target: label on one line, value on the next.
const TARGET = `Order #912000000000099

 Thanks for your order, Test!

 Order total
$65.09

Visit order details

Shipping

 Delivers to:
Test Buyer, 0100 Maple Avenue North Apt 7d, Springfield, MN 55001

Pokemon Trading Card Game: Test Tin
 Qty: 2
 $29.99 / ea

Order Summary
Subtotal (2 items)
$59.98
Delivery
Free
Estimated taxes
Based on 55001
$5.11
Total
 $65.09`;

// Mattel Creations: a block under "Shipping Address", markdown links around.
const MATTEL = `[Mattel Creations](https://creations.mattel.com)

Order Shipped

Hey Test, your order is on the way!

[Tracking #1ZAA11110000000009](https://www.ups.com/track?tracknum=1ZAA11110000000009)

Order #[CHP0000099](https://creations.mattel.com/orders/x)

What's Inside
Hot Wheels Test Car
Quantity: 2

Shipping Address

Test Buyer Market
42 Example Blvd, unit 109
Springfield, Minnesota 55003
United States

[My Account](https://creations.mattel.com/account/)

Mattel, Inc. 333 Continental Blvd.,
El Segundo, CA 90245, USA`;

console.log('\n── Target "Delivers to:" ──');
eq('name',     extractShipTo(TARGET).name, 'Test Buyer');
eq('address',  extractShipTo(TARGET).address, '0100 Maple Avenue North Apt 7d, Springfield, MN 55001');
eq('same-line form', extractShipTo('Delivers to: Acme Market, 4200 Example Blvd, 109, Springfield, MN 55003'),
   { name: 'Acme Market', address: '4200 Example Blvd, 109, Springfield, MN 55003' });

console.log('\n── Mattel "Shipping Address" block ──');
eq('name',     extractShipTo(MATTEL).name, 'Test Buyer Market');
eq('address',  extractShipTo(MATTEL).address, '42 Example Blvd, unit 109, Springfield, Minnesota 55003');
eq('store footer address not taken', /Continental/.test(extractShipTo(MATTEL).address), false);

console.log('\n── Pokemon Center one-liner ──');
eq('name + address split at the house number',
   extractShipTo('| Shipping Address: Customer A 1 Test St apt 3f Springfield, MN 55001 US |'),
   { name: 'Customer A', address: '1 Test St apt 3f Springfield, MN 55001' });

console.log('\n── Things that are NOT a ship-to ──');
eq('"Shipping $0.00" total line',  extractShipTo('Subtotal\n$59.98\nShipping\n$0.00\nTotal\n$65.09'), null);
eq('heading with no street/zip',   extractShipTo('Ship to\nTest Buyer\nStore pickup'), null);
eq('heading, no address, footer with a street', extractShipTo('Shipping Address\nTest Buyer\n[My Account](https://x)\n333 Continental Blvd\nEl Segundo, CA 90245'), null);
eq('heading, no address, then footer', extractShipTo('Shipping Address\nTest Buyer\n[My Account](https://x)\nMattel, Inc. 333 Continental Blvd.,\nEl Segundo, CA 90245, USA'), null);
eq('only a store footer',          extractShipTo('Mattel, Inc. 333 Continental Blvd.,\nEl Segundo, CA 90245, USA'), null);
eq('empty',                        extractShipTo(''), null);

(async () => {
  console.log('\n── Parser returns it ──');
  const pt = await parseOrderEmail({ text: TARGET, subject: "Thanks for shopping with us! Here's your order #:912000000000099.", from: 'orders@oe1.target.com' });
  eq('Target: shippingAddress', pt && pt.shippingAddress, '0100 Maple Avenue North Apt 7d, Springfield, MN 55001');
  eq('Target: shippingName',    pt && pt.shippingName, 'Test Buyer');
  const html = '<html><body><p>Order #CHP0000099</p><h3>Shipping Address</h3><p>Test Buyer Market<br>42 Example Blvd, unit 109<br>Springfield, Minnesota 55003<br>United States</p></body></html>';
  const pm = await parseOrderEmail({ html, text: '', subject: 'Your Mattel Creations Order #CHP0000099 has shipped', from: 'orders@mattel.com' });
  eq('Mattel HTML: address found', pm && pm.shippingAddress, '42 Example Blvd, unit 109, Springfield, Minnesota 55003');

  console.log(`\n${'─'.repeat(60)}`);
  console.log(`${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
