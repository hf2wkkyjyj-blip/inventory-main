'use strict';
// Whose order: matched by account email or name on the order; ✎ override wins.
const { partnerFor, annotatePartners } = require('../partners');
let passed = 0, failed = 0;
const eq = (n, a, b) => { if (JSON.stringify(a) === JSON.stringify(b)) { passed++; console.log(`  ✅ ${n}`); } else { failed++; console.log(`  ❌ ${n} — got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`); } };

const mk = (id, name, emails, names) => ({ id, name, _emails: new Set(emails), _names: new Set(names) });
const P = [mk(1, 'Pal', ['pal@example.test', 'pal2@example.test'], ['pal tester']), mk(2, 'Bud', ['bud@example.test'], [])];
const who = o => { const r = partnerFor(o, P); return r ? `${r.name}/${r.match}` : 'mine'; };

console.log('\n── Matching ──');
eq('by account email',            who({ account_email: 'pal2@example.test' }), 'Pal/email');
eq('email: case and spaces',      who({ account_email: '  PAL@Example.TEST ' }), 'Pal/email');
eq('by name on the order',        who({ shipping_name: 'Pal  Tester' }), 'Pal/name');
eq('email wins over name',        who({ account_email: 'bud@example.test', shipping_name: 'Pal Tester' }), 'Bud/email');
eq('no match → mine',             who({ account_email: 'me@example.test', shipping_name: 'Test Buyer' }), 'mine');
eq('part of a name is no match',  who({ shipping_name: 'Pal' }), 'mine');
eq('empty fields → mine',         who({}), 'mine');

console.log('\n── ✎ override ──');
eq('override = 0 → mine',         who({ account_email: 'pal@example.test', partner_override: 0 }), 'mine');
eq('override = partner id',       who({ shipping_name: 'Test Buyer', partner_override: 2 }), 'Bud/manual');
eq('override null → automatic',   who({ account_email: 'pal@example.test', partner_override: null }), 'Pal/email');
eq('override to removed partner → mine', who({ partner_override: 99 }), 'mine');

const a = annotatePartners([{ id: 5, shipping_name: 'pal tester' }, { id: 6 }], P);
eq('annotate adds fields',        a.map(o => [o.partner_id, o.partner_name, o.partner_match]), [[1, 'Pal', 'name'], [null, null, null]]);

console.log(`\n${'─'.repeat(60)}`);
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
