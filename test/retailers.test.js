'use strict';
// Registry tests: sender → retailer identification, per-retailer order-number
// formats (taken from real order history), and the learning loop.

const R = require('../retailers');

let passed = 0, failed = 0;
function eq(name, actual, expected) {
  if (actual === expected) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name} — got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`); }
}
function check(name, cond, detail) {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}

// Minimal settings-table stand-in.
function fakeDb() {
  const s = new Map();
  return {
    _s: s,
    prepare(sql) {
      return {
        get(p = []) {
          const k = (sql.match(/key='([^']+)'/) || [])[1];
          return s.has(k) ? { value: s.get(k) } : undefined;
        },
        run(p = []) {
          const k = (sql.match(/VALUES \('([^']+)'/) || [])[1];
          s.set(k, p[p.length - 1]);
        },
      };
    },
  };
}

console.log('\n── CONFIRMED real senders (supplied by the user) ──');
{
  const confirmed = [
    ['orders@oe.target.com',   'Target',           'Other'],
    ['info@em.pokemon.com',    'Pokemon Center',   'Pokemon'],
    ['orders@mattel.com',      'Mattel Creations', 'Mattel'],
    ['info@bearwalker.com',    'Bear Walker',      'One Piece'],
  ];
  for (const [from, name, category] of confirmed) {
    const p = R.profileFor(from, '', null) || {};
    eq(`${from} → ${name}`, p.name, name);
    eq(`${from} → category ${category}`, p.category, category);
    check(`${from} in search list`, R.knownSenders({ prepare: () => ({ get: () => undefined }) })
      .some(s => R.domainOf(from) === s || R.domainOf(from).endsWith('.' + s)));
  }
}

console.log('\n── Domain matching is boundary-aware, not substring ──');
{
  // A lookalike domain must NOT resolve to the real retailer.
  const spoofs = ['orders@target.com.phishing.net', 'x@notmattel.com', 'y@em.pokemon.com.evil.io'];
  for (const s of spoofs) {
    const p = R.profileFor(s, '', null);
    check(`rejects ${s}`, p === null, p && p.name);
  }
  // Genuine subdomains must still resolve.
  eq('sub.oe.target.com still Target', (R.profileFor('a@sub.oe.target.com', '', null) || {}).name, 'Target');
}

console.log('\n── Sender → retailer ──');
{
  const cases = [
    ['orders@oe.target.com',            'Target'],
    ['noreply@email.target.com',        'Target'],
    ['orders@pokemoncenter.com',        'Pokemon Center'],
    ['hello@creations.mattel.com',      'Mattel Creations'],
    ['no-reply@samsclub.com',           "Sam's Club"],
    ['orders@costco.com',               'Costco'],
    ['support@bearwalker.com',          'Bear Walker'],
    ['auto-confirm@amazon.com',         'Amazon'],
  ];
  for (const [from, expect] of cases) {
    eq(from, (R.profileFor(from, '', null) || {}).name, expect);
  }
  check('unknown sender returns null', R.profileFor('sales@randomshop.io', '', null) === null);
}

console.log('\n── Narvar relay resolves via body ──');
{
  eq('narvar + Target body',  (R.profileFor('ship@narvar.com', 'tracking for your target.com order', null) || {}).name, 'Target');
  eq('narvar + PKC body',     (R.profileFor('ship@narvar.com', 'your Pokemon Center shipment', null) || {}).name, 'Pokemon Center');
  eq('narvar, unknown body',  (R.profileFor('ship@narvar.com', 'your package shipped', null) || {}).name, 'Narvar');
}

console.log('\n── Order-number formats (from real history) ──');
{
  const P = n => R.BUILT_IN.find(p => p.name === n);
  const cases = [
    ['Target',           'Order #902003677072140 placed',      '902003677072140'],
    ['Target',           'order 912003499321226 shipped',      '912003499321226'],
    ['Pokemon Center',   'Order Number: P0040756156',          'P0040756156'],
    ['Pokemon Center',   'your order P0040889108 shipped',     'P0040889108'],
    ['Mattel Creations', 'Order Number CHP10033780',           'CHP10033780'],
    ['Mattel Creations', 'order CHP9993463 confirmed',         'CHP9993463'],
    ["Sam's Club",       'Receipt TC9915585140381162319628',   'TC9915585140381162319628'],
    ["Sam's Club",       'Order 10425483529 delivered',        '10425483529'],
    ['Costco',           'Order 1287328120 has shipped',       '1287328120'],
    ['Bear Walker',      'Order #25293 is on its way',         '25293'],
    ['Bear Walker',      'Thanks! #24662 ships soon',          '24662'],
    ['Bear Walker',      'Order 25164 confirmed',              '25164'],
    ['Amazon',           'Order 112-9988776-5544332',          '112-9988776-5544332'],
  ];
  for (const [retailer, text, expect] of cases) {
    eq(`${retailer}: "${text.slice(0, 34)}…"`, R.orderNumberFor(P(retailer), text), expect);
  }
}

console.log('\n── Short order numbers must not match loose digit runs ──');
{
  const bw = R.BUILT_IN.find(p => p.name === 'Bear Walker');
  // A bare 5-digit run is a zip code, a price or a date — not an order number.
  const noise = [
    'Delivers to Brooklyn Park, MN 55445',
    'Estimated taxes based on 55445',
    'Your package weighs 12345 grams',
  ];
  for (const t of noise) {
    check(`ignores "${t.slice(0, 38)}…"`, R.orderNumberFor(bw, t) === null, R.orderNumberFor(bw, t));
  }
}

console.log('\n── Learning loop ──');
{
  const db = fakeDb();
  const unknown = 'orders@fanaticsdeals.com';

  check('unknown at first', R.profileFor(unknown, '', db) === null);
  check('not in sender list', !R.knownSenders(db).includes('fanaticsdeals.com'));

  const learned = R.learnSender(db, unknown, 'Fanatics');
  check('learned once', learned === true);
  check('now in sender list', R.knownSenders(db).includes('fanaticsdeals.com'));
  eq('now identified', (R.profileFor(unknown, '', db) || {}).name, 'Fanatics');
  check('learning is idempotent', R.learnSender(db, unknown, 'Fanatics') === false);

  // A built-in sender should never be written to the learned store.
  check('built-ins not re-learned', R.learnSender(db, 'orders@oe.target.com', 'Target') === false);
  eq('learned store holds only the new one', Object.keys(R.loadLearned(db)).length, 1);
}

console.log('\n── Search-space sanity ──');
{
  const db = fakeDb();
  const senders = R.knownSenders(db);
  check(`${senders.length} known sender domains`, senders.length >= 25, String(senders.length));
  check('includes mattel', senders.some(s => s.includes('mattel')));
  check('includes samsclub', senders.some(s => s.includes('samsclub')));
  check('no duplicates', new Set(senders).size === senders.length);
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
