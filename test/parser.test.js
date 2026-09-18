'use strict';
// Run with:  node test/parser.test.js
// No test framework needed — plain assertions so it runs anywhere.

const fs   = require('fs');
const path = require('path');
const { parseOrderEmail, findOrderNumberInText } = require('../parser');

let passed = 0, failed = 0;
const failures = [];

function check(name, cond, detail) {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else      { failed++; failures.push(name); console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}

function eq(name, actual, expected) {
  check(name, actual === expected, `got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
}

const fixture = f => fs.readFileSync(path.join(__dirname, 'fixtures', f), 'utf8');

// Rough text version, mirroring what mailparser hands us as the text body.
const toText = html => html
  .replace(/<br\s*\/?>/gi, '\n')
  .replace(/<\/(tr|div|p|td|table)>/gi, '\n')
  .replace(/<[^>]+>/g, ' ')
  .replace(/&eacute;/g, 'é').replace(/&amp;/g, '&').replace(/&ndash;/g, '–')
  .replace(/[ \t]+/g, ' ')
  .replace(/\n\s*\n+/g, '\n')
  .trim();

(async () => {

  // ── 1. Target: the email that produced "Mastercard *5562" and "Based on 55445" ──
  console.log('\n── Target confirmation (the $43.39-appears-3-times case) ──');
  {
    const html = fixture('target-confirmation.html');
    const r = await parseOrderEmail({ html, text: toText(html), subject: 'Thanks for your order', from: 'orders@target.com' });

    eq('order number', r.orderNumber, '902003676318858');
    eq('exactly one item', r.items.length, 1);

    const names = r.items.map(i => i.name);
    check('no "Mastercard" item',   !names.some(n => /mastercard/i.test(n)),   names.join(' | '));
    check('no "Based on" item',     !names.some(n => /^based on/i.test(n)),    names.join(' | '));
    check('no marketing-copy item', !names.some(n => /sit back|get to work/i.test(n)), names.join(' | '));
    check('no upsell items',        !names.some(n => /booster bundle|plush/i.test(n)), names.join(' | '));

    if (r.items[0]) {
      eq('item name',  r.items[0].name,      'Pokémon 30th Anniversary Poster Collection');
      eq('item qty',   r.items[0].qty,       2);
      eq('unit price', r.items[0].unitPrice, 19.99);
      eq('line total', r.items[0].lineTotal, 39.98);
    }

    eq('subtotal', r.subtotal, 39.98);
    eq('tax',      r.tax,      3.41);
    eq('shipping', r.shipping, 0);
    eq('total',    r.total,    43.39);
  }

  // ── 2. Pokemon Center: split product title ──────────────────────────────────
  console.log('\n── Pokemon Center confirmation (split "Pokemon TCG:" title) ──');
  {
    const html = fixture('pkc-confirmation.html');
    const r = await parseOrderEmail({ html, text: toText(html), subject: 'Order Confirmation', from: 'orders@pokemoncenter.com' });

    eq('order number', r.orderNumber, 'P0040756156');

    const names = r.items.map(i => i.name);
    check('no bare "Pokemon TCG:" name', !names.some(n => /^pokemon tcg:?$/i.test(n.trim())), names.join(' | '));
    check('found 2 items', r.items.length === 2, `got ${r.items.length}: ${names.join(' | ')}`);
    check('names include the full product text',
      names.some(n => /30th Celebration Booster Bundle/i.test(n)), names.join(' | '));

    eq('tax',      r.tax,      10.63);
    eq('subtotal', r.subtotal, 154.58);
    eq('total',    r.total,    165.21);
  }

  // ── 3. JSON-LD from a retailer with no custom extractor ─────────────────────
  console.log("\n── Sam's Club via JSON-LD (no retailer-specific code) ──");
  {
    const html = fixture('jsonld-samsclub.html');
    const r = await parseOrderEmail({ html, text: toText(html), subject: 'Your order was delivered', from: 'no-reply@samsclub.com' });

    eq('source layer',    r.source,         'jsonld');
    eq('order number',    r.orderNumber,    'TC9915585140381162319628');
    eq('retailer',        r.retailer,       "Sam's Club");
    eq('status mapped',   r.status,         'Delivered');
    eq('order date',      r.orderDate,      '2026-07-22');
    eq('item count',      r.items.length,   1);
    eq('item name',       r.items[0]?.name, 'LEGO Pokémon Eevee Building Set');
    eq('qty',             r.items[0]?.qty,  96);
    eq('unit price',      r.items[0]?.unitPrice, 29.98);
    eq('sku',             r.items[0]?.sku,  '990497327');
    eq('total',           r.total,          3068.03);
    eq('tracking',        r.trackingNumber, '1Z999AA10123456784');
    eq('carrier',         r.carrier,        'UPS');
    eq('expected date',   r.expectedDate,   '2026-07-29');
    eq('ship name',       r.shippingName,   'Sang Nguyen');
    check('address captured', /Brooklyn Park/.test(r.shippingAddress || ''), r.shippingAddress);
    check('high confidence',  r.confidence >= 0.9, String(r.confidence));
  }

  // ── 3b. Totals only present as flat text (the "tax=? ship=?" case) ─────────
  // Items are in a clean table so the DOM layer finds them, but the summary is a
  // flowing paragraph with no label/value structure to pair up.
  console.log('\n── Flat-text order summary (tax/ship must still be found) ──');
  {
    const html = `<html><body>
      <p>Order #112-9988776-5544332</p>
      <table><tr>
        <td>Mega Evolution Booster Bundle</td><td>Qty: 2</td><td>$32.55</td>
      </tr></table>
      <p>Subtotal: $65.10 &nbsp; Shipping: $5.99 &nbsp; Estimated tax: $4.72 &nbsp; Order Total: $75.81</p>
    </body></html>`;
    const r = await parseOrderEmail({ html, text: toText(html), subject: 'Your order has shipped', from: 'ship@somestore.com' });

    eq('item found',  r.items.length, 1);
    eq('subtotal',    r.subtotal,     65.10);
    eq('tax',         r.tax,          4.72);
    eq('shipping',    r.shipping,     5.99);
    eq('total',       r.total,        75.81);
  }

  // ── 3c. Free shipping expressed as a word ──────────────────────────────────
  console.log('\n── "Shipping: Free" must store 0, not null ──');
  {
    const html = `<html><body>
      <p>Order Number: ABC-55512</p>
      <table><tr><td>Poster Collection</td><td>Qty: 1</td><td>$19.99</td></tr></table>
      <p>Subtotal $19.99 | Shipping: Free | Tax $1.37 | Total $21.36</p>
    </body></html>`;
    const r = await parseOrderEmail({ html, text: toText(html), subject: 'Order confirmation', from: 'x@store.com' });
    eq('shipping is 0 not null', r.shipping, 0);
    eq('tax',   r.tax,   1.37);
    eq('total', r.total, 21.36);
  }

  // ── 3d. Shipping notice: total is derived, and must be flagged as such ──────
  // These emails list what shipped but carry no tax/shipping/total lines. Summing
  // the item rows produces a number that looks like a total but is missing tax —
  // it must never overwrite the real total captured at confirmation time.
  console.log('\n── Shipping notice (derived total must be flagged) ──');
  {
    const html = `<html><body>
      <p>Your order #902003677072140 has shipped</p>
      <p>Tracking: 1ZWY06570304019606</p>
      <table>
        <tr><td>Pokemon TCG Scarlet &amp; Violet Bundle</td><td>Qty: 1</td><td>$219.99</td></tr>
        <tr><td>Pokemon TCG 30th Anniversary Pack</td><td>Qty: 1</td><td>$39.99</td></tr>
      </table>
    </body></html>`;
    const r = await parseOrderEmail({ html, text: toText(html), subject: 'Your order has shipped', from: 'ship@target.com' });

    eq('2 items', r.items.length, 2);
    eq('total is the line sum', r.total, 259.98);
    check('total flagged derived',    r.derived && r.derived.total === true,    JSON.stringify(r.derived));
    check('subtotal flagged derived', r.derived && r.derived.subtotal === true, JSON.stringify(r.derived));
    eq('tax genuinely absent', r.tax, null);
  }

  // ── 3e. Confirmation with a stated total is NOT derived ─────────────────────
  console.log('\n── Stated total must not be flagged derived ──');
  {
    const html = fixture('target-confirmation.html');
    const r = await parseOrderEmail({ html, text: toText(html), subject: 'Thanks for your order', from: 'orders@target.com' });
    check('total not derived', r.derived && r.derived.total === false, JSON.stringify(r.derived));
  }

  // ── 3f. Order numbers without a colon (Mattel-style) ───────────────────────
  console.log('\n── Order number formats ──');
  {
    const cases = [
      ['Order Number CHP10033780',     'CHP10033780'],
      ['Order Number: P0040756156',    'P0040756156'],
      ['Order #902003676318858',       '902003676318858'],
      ['Order No. 25293',              '25293'],
      ['Confirmation # ABC-99812',     'ABC-99812'],
    ];
    for (const [input, expected] of cases) {
      eq(`"${input}"`, findOrderNumberInText(input), expected);
    }
  }

  // ── 4. Guard: a pure marketing email must not become an order ───────────────
  console.log('\n── Marketing email (must produce nothing) ──');
  {
    const html = `<html><body>
      <h1>30% off everything this weekend!</h1>
      <p>Shop now and save. Prices from $9.99.</p>
      <p>You might also like: Pokemon Booster Box $99.99</p>
    </body></html>`;
    const r = await parseOrderEmail({ html, text: toText(html), subject: 'Weekend sale', from: 'deals@target.com' });
    check('no order number', !r || !r.orderNumber, r && r.orderNumber);
  }

  console.log(`\n${'─'.repeat(60)}`);
  console.log(`${passed} passed, ${failed} failed`);
  if (failed) { console.log('\nFailed:'); failures.forEach(f => console.log(`  • ${f}`)); }
  process.exit(failed ? 1 : 0);
})();
