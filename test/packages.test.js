'use strict';
// Package grouping — using the exact shapes from the user's Pokemon Center data.

const { computePackages } = require('../packageView');

let passed = 0, failed = 0;
const eq = (n, a, e) => {
  if (JSON.stringify(a) === JSON.stringify(e)) { passed++; console.log(`  ✅ ${n}`); }
  else { failed++; console.log(`  ❌ ${n} — got ${JSON.stringify(a)}, expected ${JSON.stringify(e)}`); }
};

// One PKC order = one box with four products (from the screenshot).
const box = (id, num, trk, name, addr, extra = {}) => ({
  id, order_number: num, retailer: 'Pokemon Center', status: 'Shipped', tracking: trk,
  shipping_name: name, shipping_address: addr, expected_date: '2026-09-28',
  items: JSON.stringify([
    '2x Pokemon TCG: 30th Celebration Pokemon Center Elite Trainer Box (SKU 10-10447-111)',
    '1x Pokemon TCG: 30th Celebration Knock Out Collection (SKU 10-10667-101)',
    '1x Pokemon TCG: 30th Celebration Tech Sticker Collection (Lucario) (SKU 10-10449-122)',
    '1x Pokemon TCG: 30th Celebration Tech Sticker Collection (Alolan Exeggutor) (SKU 10-10449-121)',
  ]),
  ...extra,
});

console.log('\n── One box = one row ──');
{
  const pk = computePackages([box(1, 'P0038241809', '876893093507', 'Jason Yang', '8410 Yates Ave North Fl 6, Minneapolis, MN 55443')]);
  eq('one package', pk.length, 1);
  eq('tracking', pk[0].tracking, '876893093507');
  eq('4 products inside', pk[0].contents.length, 4);
  eq('5 units total', pk[0].units, 5);
  eq('ETB listed first with qty 2', [pk[0].contents[0].name, pk[0].contents[0].qty], ['30th Celebration PC ETB', 2]);
  eq('ship-to', pk[0].shipTo[0].name, 'Jason Yang');
  eq('not flagged', pk[0].conflict, false);
  eq('order ids carried for bulk actions', pk[0].orderIds, [1]);
}

console.log('\n── 16 boxes → 16 rows (the product view showed 64) ──');
{
  const orders = Array.from({ length: 16 }, (_, i) => box(i + 1, `P00383${i}`, `8769${String(i).padStart(8, '0')}`, `Buyer ${i}`, `${i} Main St, City, MN 55000`));
  const pk = computePackages(orders);
  eq('16 packages', pk.length, 16);
  eq('64 product lines collapsed', pk.reduce((s, p) => s + p.contents.length, 0), 64);
}

console.log('\n── Same tracking, two different addresses → flagged ──');
{
  // Real case from the screenshot: 876928855241 on two orders, two buildings.
  const pk = computePackages([
    box(5, 'P0038311805', '876928855241', 'Jenny Xiong', '8410 Yates Ave N Apt 3f, Minneapolis, MN 55443'),
    box(6, 'P0038320540', '876928855241', 'Kien Lai',    '08805 E Research Center Dr Rm 5, Minneapolis, MN 55428'),
  ]);
  eq('one package row', pk.length, 1);
  eq('flagged as conflict', pk[0].conflict, true);
  eq('both destinations shown', pk[0].shipTo.map(s => s.name).sort(), ['Jenny Xiong', 'Kien Lai']);
  eq('both order ids included', pk[0].orderIds.sort(), [5, 6]);
  eq('contents summed across both orders', pk[0].units, 10);
}

console.log('\n── Same tracking, same address spelled differently → NOT flagged ──');
{
  const pk = computePackages([
    box(7, 'A', '1ZWY06570304019606', 'Sang', '8410 Yates Ave N Rm 4, Minneapolis, MN 55443'),
    box(8, 'B', '1ZWY06570304019606', 'Sang', '8410 Yates Avenue North Room 4, Minneapolis, MN 55443'),
  ]);
  eq('not a conflict', pk[0].conflict, false);
  eq('UPS detected', pk[0].carrierLabel, 'UPS');
}

console.log('\n── Orders without tracking stand alone ──');
{
  const pk = computePackages([
    box(9,  'N1', null, 'A', '1 A St, X, MN 55000'),
    box(10, 'N2', '',   'B', '2 B St, X, MN 55000'),
  ]);
  eq('two separate rows', pk.length, 2);
  eq('no tracking', pk.every(p => p.tracking === null), true);
}

console.log('\n── Status and ordering ──');
{
  const pk = computePackages([
    box(11, 'late',  '876000000001', 'A', '1 A St, X, MN 55000', { expected_date: '2026-10-02' }),
    box(12, 'ofd',   '876000000002', 'B', '2 B St, X, MN 55000', { tracking_status: 'OFD' }),
    box(13, 'soon',  '876000000003', 'C', '3 C St, X, MN 55000', { expected_date: '2026-09-27' }),
    box(14, 'none',  null,           'D', '4 D St, X, MN 55000'),
  ]);
  eq('OFD first, then soonest, no-tracking last', pk.map(p => p.orders[0].order_number), ['ofd', 'soon', 'late', 'none']);
  eq('OFD shown as OFD', pk[0].status, 'OFD');

  const mixed = computePackages([
    box(15, 'x', '876000000009', 'A', '1 A St, X, MN 55000', { status: 'Delivered' }),
    box(16, 'y', '876000000009', 'A', '1 A St, X, MN 55000', { status: 'Shipped' }),
  ]);
  eq('package is as far as its least-advanced order', mixed[0].status, 'Shipped');
  eq('mixed flagged', mixed[0].mixedStatus, true);
}

console.log('\n── Catalog names are used for contents ──');
{
  const catalog = { products: new Map([[7, { id: 7, name: 'PC ETB' }]]),
                    aliases:  new Map([['pokemon tcg: 30th celebration pokemon center elite trainer box', 7]]) };
  const pk = computePackages([box(1, 'P1', '876893093507', 'J', '1 A St, X, MN 55000')], catalog);
  eq('linked product shows its short name', pk[0].contents[0].name, 'PC ETB');
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
