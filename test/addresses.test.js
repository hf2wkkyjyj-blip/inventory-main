'use strict';
// Main-address grouping (addresses.js). All addresses are made up, but copy
// the jig patterns seen in real orders.

const { parseAddress, addressKey, buildAddressBook } = require('../addresses');

let passed = 0, failed = 0;
const eq = (n, a, e) => {
  if (a === e) { passed++; console.log(`  ✅ ${n}`); }
  else { failed++; console.log(`  ❌ ${n} — got ${JSON.stringify(a)}, expected ${JSON.stringify(e)}`); }
};

console.log('\n── Jig variations of one place share a key ──');
const JIGS = [
  '100 Maple Ave N, Springfield, MN 55001',
  '0100 Maple Avenue North Apt 7d, Springfield, MN 55001',
  '0100d Maple Avenue N Floor 5, Springfield, MN 55001',
  '0100y maple ave north unit-4-out, Springfield, MN 55001',
  '100 Maple Ave N Office, Springfield, MN 55001',
  '0100c Maple Avenue N 3-in, Springfield, MN 55001',
  '100 Maple North Ave-qu apt-1-in, Springfield, MN 55001',
  '100 Maple Ave N Unit109, Springfield, MN 55001',
  '100 Maple Ave N, Otherville, MN 55002',          // jig changed city + zip
  '100 Maple Ave N',                                // no city / zip at all
  '(digital product - billing address only) 0100 Maple Ave N floor 3, Springfield, MN 55001',
];
const k0 = addressKey(JIGS[0]);
JIGS.forEach(a => eq(`same place: ${a.slice(0, 48)}`, addressKey(a), k0));

console.log('\n── Different places stay apart ──');
eq('different house number',       addressKey('102 Maple Ave N, Springfield, MN 55001') === k0, false);
eq('different street',             addressKey('100 Birch Ave N, Springfield, MN 55001') === k0, false);
eq('numbered streets differ',      addressKey('200 109th Pl N, X, MN 55001') === addressKey('200 118th Ave N, X, MN 55001'), false);
eq('Dr vs Rd jig = same place',    addressKey('500 E Sample Park Dr Rm 5, X, MN 55003'), addressKey('0500 E Sample Park Rd, Y, MN 55003'));
eq('store name before the street', addressKey("Test Club, 16701 94th Ave N, Test Grove, MN 55004 (return)"), addressKey('16701 94th Ave N, Test Grove, MN 55004'));
eq('nothing to go on → null',      addressKey('Pickup at store'), null);
eq('state name spelled out',       parseAddress('7 Oak St, unit 9, Test Park, Minnesota 55005').state, 'MN');
eq('3-letter street kept',         addressKey('9 Oak St, X, MN 55006') === addressKey('9 Elm St, X, MN 55006'), false);

console.log('\n── Main address label ──');
const book = buildAddressBook([...JIGS, ...JIGS.slice(0, 3), '102 Maple Ave N, Springfield, MN 55001']);
eq('every jig maps to one label',  new Set(JIGS.map(book.main)).size, 1);
eq('clean, common spelling',       book.main(JIGS[3]), '100 Maple Ave N, Springfield, MN 55001');
eq('two places total',             book.groups.length, 2);
eq('group counts variants',        book.groups[0].variants, JIGS.length);
eq('unparseable text kept as-is',  book.main('Pickup at store'), 'Pickup at store');
eq('empty stays empty',            book.main(''), null);
const withType = buildAddressBook(['300 Test Center, X, MN 55007', '300 Test Center, X, MN 55007', '0300 Test Center Dr Apt 2, X, MN 55007']);
eq('prefers a spelling with a street type', withType.main('300 Test Center, X, MN 55007'), '300 Test Center Dr, X, MN 55007');

console.log(`\n${'─'.repeat(60)}`);
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
