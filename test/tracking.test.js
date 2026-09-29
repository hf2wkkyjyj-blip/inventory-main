'use strict';
// Tracking-number correctness, run through the REAL scraper on a REAL SQLite db.
//
// Incident: two Pokemon Center shipping emails, sent the same second with the
// same subject, were for different orders with different tracking numbers.
// One order ended up holding the OTHER order's number — and because a stored
// tracking number was never replaced, every later rescan kept the wrong one,
// even though that order's own email stated the right number.
//
// Fixtures use PKC's real email wording with made-up people and numbers — no
// customer data belongs in the repo.

process.removeAllListeners('warning');
const Module = require('module'); const orig = Module._load;
Module._load = function (r, ...a) {
  if (r === 'node-imap')  return function () {};
  if (r === 'mailparser') return { simpleParser: async () => ({}) };
  return orig.apply(this, [r, ...a]);
};
const { DatabaseSync } = require('node:sqlite');
const { reparseStoredEmails, ensureRawEmailTable } = require('../emailScraper');

const A = { num: 'P0000000101', trk: '876000000101', name: 'Customer A', addr: '1 Test St apt 3f Springfield, MN 55001' };
const B = { num: 'P0000000202', trk: '876000000202', name: 'Customer B', addr: '2 Sample Ave rm 5 Springfield, MN 55002' };

const shipEmail = (c, trk = c.trk) => [
  'Pokémon Center', 'Hooray! Find out when your order will arrive.',
  `| Hello, ${c.name.split(' ')[1]}! |`,
  `| Your package has shipped! Estimated delivery is 3-6 business days. Tracking Number: ${trk}[](https://click.em.pokemon.com/?qs=ABB7InYiOjEsImQiOjQ5OTl9AAwAAAAAAvQVPx) Sincerely, Pokémon Center |`,
  '| Order Details |',
  `| Order Subtotal: $159.95 Order Number: ${c.num} Fulfillment ID: 24473098 Date Ordered: July 15, 2026 |`,
  '| Shipping Details |', `| Shipping Address: ${c.name} ${c.addr} US |`,
  '| Order Summary |', '| Pokémon TCG: 30th Celebration Knock Out Collection |', '| SKU # : 10-10667-101 Qty : 1 |',
].join('\n');

function makeDb(seed) {
  const raw = new DatabaseSync(':memory:');
  const db = { exec: s => raw.exec(s), prepare: s => { const st = raw.prepare(s);
    const n = p => p === undefined ? [] : Array.isArray(p) ? p : [p];
    return { all: p => st.all(...n(p)), get: p => st.get(...n(p)), run: p => st.run(...n(p)) }; } };
  db.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)');
  db.exec(`CREATE TABLE bot_orders (id INTEGER PRIMARY KEY AUTOINCREMENT, email_id TEXT, category TEXT, retailer TEXT,
    order_number TEXT, tracking TEXT, status TEXT, tracking_status TEXT, expected_date TEXT, order_date TEXT,
    received_at TEXT, delivered_date TEXT, items TEXT, order_total REAL, tax_amount REAL, ship_cost REAL,
    finder_fee REAL, shipping_name TEXT, shipping_address TEXT, status_changed_at TEXT, status_source TEXT, created_at TEXT)`);
  for (const [c, trk] of seed) {
    db.prepare(`INSERT INTO bot_orders (category, retailer, order_number, status, tracking, shipping_name)
                VALUES ('Pokemon','Pokemon Center',?,?,?,?)`).run([c.num, trk ? 'Shipped' : 'Confirmed', trk || null, c.name]);
  }
  ensureRawEmailTable(db);
  return db;
}
function addEmail(db, id, text, date = '2026-09-14T23:21:19Z') {
  const html = '<html><body>' + text.split('\n').map(l => `<p>${l}</p>`).join('') + '</body></html>';
  db.prepare('INSERT INTO raw_emails (message_id, subject, from_email, email_date, html, text) VALUES (?,?,?,?,?,?)')
    .run([id, 'Your Pokémon Center order is on its way!', 'info@em.pokemon.com', date, html, text]);
}
const trackingOf = (db, c) => db.prepare('SELECT tracking FROM bot_orders WHERE order_number=?').get([c.num]).tracking;
async function quiet(fn) { const l = console.log; console.log = () => {}; try { return await fn(); } finally { console.log = l; } }

let passed = 0, failed = 0;
const eq = (n, a, e) => {
  if (a === e) { passed++; console.log(`  ✅ ${n}`); }
  else { failed++; console.log(`  ❌ ${n} — got ${JSON.stringify(a)}, expected ${JSON.stringify(e)}`); }
};

(async () => {
  console.log('\n── Two shipping emails, same second, same subject ──');
  for (const order of [[A, B], [B, A]]) {
    const db = makeDb([[A], [B]]);
    order.forEach((c, i) => addEmail(db, `<m${i}>`, shipEmail(c)));
    await quiet(() => reparseStoredEmails(db));
    const lbl = order.map(c => c.name.slice(-1)).join('→');
    eq(`[${lbl}] A gets its own number`, trackingOf(db, A), A.trk);
    eq(`[${lbl}] B gets its own number`, trackingOf(db, B), B.trk);
  }

  console.log('\n── Ship-to address read from the email ──');
  {
    const db = makeDb([[A], [B]]);
    db.prepare("UPDATE bot_orders SET shipping_address='99 Hand Fixed Rd, Springfield, MN 55009' WHERE order_number=?").run([B.num]);
    addEmail(db, '<a>', shipEmail(A)); addEmail(db, '<b>', shipEmail(B));
    await quiet(() => reparseStoredEmails(db));
    const addr = c => db.prepare('SELECT shipping_address FROM bot_orders WHERE order_number=?').get([c.num]).shipping_address;
    eq('missing address filled from the email', addr(A), A.addr);
    eq('address already on file NOT overwritten', addr(B), '99 Hand Fixed Rd, Springfield, MN 55009');
  }

  console.log("\n── A already holds B's number (the live state) ──");
  for (const order of [[A, B], [B, A]]) {
    const db = makeDb([[A, B.trk], [B, B.trk]]);
    order.forEach((c, i) => addEmail(db, `<m${i}>`, shipEmail(c)));
    await quiet(() => reparseStoredEmails(db));
    const lbl = order.map(c => c.name.slice(-1)).join('→');
    eq(`[${lbl}] A corrected from its own email`, trackingOf(db, A), A.trk);
    eq(`[${lbl}] B keeps its number`,              trackingOf(db, B), B.trk);
  }

  console.log('\n── Split shipment: a second box must NOT overwrite the first ──');
  {
    // Same order, two boxes, two tracking numbers — neither shared with another order.
    const db = makeDb([[A, A.trk]]);
    addEmail(db, '<box2>', shipEmail(A, '876000000999'), '2026-09-16T10:00:00Z');
    await quiet(() => reparseStoredEmails(db));
    eq('first tracking kept', trackingOf(db, A), A.trk);
  }

  console.log("\n── An email for B never touches A ──");
  {
    const db = makeDb([[A, B.trk], [B, B.trk]]);
    addEmail(db, '<onlyB>', shipEmail(B));
    await quiet(() => reparseStoredEmails(db));
    eq("A unchanged without its own email", trackingOf(db, A), B.trk);   // nothing proves the right value yet
    eq('B correct', trackingOf(db, B), B.trk);
  }

  console.log(`\n${'─'.repeat(60)}`);
  console.log(`${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
