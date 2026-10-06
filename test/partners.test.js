'use strict';
// Whose order: per-retailer lists. His only at that retailer, with his email
// (and his name, when the list has names). Near-misses are flagged, not moved.
// ✎ override wins over everything. All data made up.
const { classifyOrder, annotatePartners } = require('../partners');
let passed = 0, failed = 0;
const eq = (n, a, b) => { if (JSON.stringify(a) === JSON.stringify(b)) { passed++; console.log(`  ✅ ${n}`); } else { failed++; console.log(`  ❌ ${n} — got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`); } };

const prof = (retailer, emails, names) => ({ _retailer: retailer, _emails: new Set(emails), _names: new Set(names) });
const P = [
  { id: 1, name: 'Pal', profiles: [
      prof('test mart', ['pal1@example.test', 'pal2@example.test'], ['pal tester', 'sam sample']),
      prof('toy center', ['pal3@example.test'], []) ] },          // no names → email alone
  { id: 2, name: 'Bud', profiles: [ prof('test mart', ['bud@example.test'], ['bud tester']) ] },
];
const who = o => {
  const { owner, check } = classifyOrder(o, P);
  return owner ? `${owner.name}/${owner.match}` : check ? `check:${check.name}:${/no email/.test(check.why) ? 'noemail' : 'name'}` : 'mine';
};
const TM = 'Test Mart', TC = 'Toy Center';

console.log('\n── His only at that retailer, email + name ──');
eq('email + name at that retailer',        who({ retailer: TM, account_email: 'pal2@example.test', shipping_name: 'Sam Sample' }), 'Pal/email+name');
eq('case, spaces, accents',                who({ retailer: ' TEST MÄRT ', account_email: ' PAL1@Example.TEST', shipping_name: 'Pal  Tester' }), 'Pal/email+name');
eq('same email + name, other retailer → mine', who({ retailer: 'Other Shop', account_email: 'pal1@example.test', shipping_name: 'Pal Tester' }), 'mine');
eq('his name, YOUR email → mine (no flag)', who({ retailer: TM, account_email: 'me@example.test', shipping_name: 'Pal Tester' }), 'mine');
eq('list without names: email alone',      who({ retailer: TC, account_email: 'pal3@example.test', shipping_name: 'Anyone' }), 'Pal/email');
eq('other partner\'s list',                who({ retailer: TM, account_email: 'bud@example.test', shipping_name: 'Bud Tester' }), 'Bud/email+name');
eq('no retailer on the order → mine',      who({ account_email: 'pal1@example.test', shipping_name: 'Pal Tester' }), 'mine');

console.log('\n── Near-misses are flagged, not moved ──');
eq('old order: his name, no email saved',  who({ retailer: TM, shipping_name: 'Pal Tester' }), 'check:Pal:noemail');
eq('his email, name not on his list',      who({ retailer: TM, account_email: 'pal1@example.test', shipping_name: 'Someone Else' }), 'check:Pal:name');
eq('his name, no email, other retailer → mine', who({ retailer: 'Other Shop', shipping_name: 'Pal Tester' }), 'mine');
eq('nothing at all → mine',                who({}), 'mine');

console.log('\n── ✎ override ──');
eq('override 0 → mine, no flag',           who({ retailer: TM, account_email: 'pal1@example.test', shipping_name: 'Pal Tester', partner_override: 0 }), 'mine');
eq('override → partner',                   who({ retailer: 'Other Shop', partner_override: 2 }), 'Bud/manual');
eq('override null → automatic',            who({ retailer: TM, account_email: 'pal1@example.test', shipping_name: 'Pal Tester', partner_override: null }), 'Pal/email+name');
eq('override to a removed partner → mine', who({ partner_override: 99 }), 'mine');

const a = annotatePartners([
  { id: 5, retailer: TM, account_email: 'pal1@example.test', shipping_name: 'pal tester' },
  { id: 6, retailer: TM, shipping_name: 'Sam Sample' },
  { id: 7 }], P);
eq('annotate: owner fields',               a.map(o => [o.partner_id, o.partner_match]), [[1, 'email+name'], [null, null], [null, null]]);
eq('annotate: check fields',               a.map(o => o.partner_check_name), [null, 'Pal', null]);

console.log(`\n${'─'.repeat(60)}`);
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
