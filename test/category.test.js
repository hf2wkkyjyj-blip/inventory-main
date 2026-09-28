'use strict';
// Order category — decided from item names, never from the email body.
//
// Incident: a Topps MLB box and a Ring camera were filed under Pokemon. Neither
// email mentions Pokemon; the old check scanned the whole body, and Target's
// ~40 tracking links contain the letters "tcg" by chance in ~1 email in 10.
// Fixtures below use made-up people; product names are real.

process.removeAllListeners('warning');
const Module = require('module'); const orig = Module._load;
Module._load = function (r, ...a) {
  if (r === 'node-imap')  return function () {};
  if (r === 'mailparser') return { simpleParser: async () => ({}) };
  return orig.apply(this, [r, ...a]);
};
const { DatabaseSync } = require('node:sqlite');
const { decideCategory, categoryOfText, recategorizeOrders } = require('../category');
const { reparseStoredEmails, ensureRawEmailTable } = require('../emailScraper');

let passed = 0, failed = 0;
const eq = (n, a, e) => {
  if (a === e) { passed++; console.log(`  ✅ ${n}`); }
  else { failed++; console.log(`  ❌ ${n} — got ${JSON.stringify(a)}, expected ${JSON.stringify(e)}`); }
};

function makeDb() {
  const raw = new DatabaseSync(':memory:');
  const db = { exec: s => raw.exec(s), prepare: s => { const st = raw.prepare(s);
    const n = p => p === undefined ? [] : Array.isArray(p) ? p : [p];
    return { all: p => st.all(...n(p)), get: p => st.get(...n(p)), run: p => st.run(...n(p)) }; } };
  db.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)');
  db.exec(`CREATE TABLE bot_orders (id INTEGER PRIMARY KEY AUTOINCREMENT, email_id TEXT, category TEXT, retailer TEXT,
    order_number TEXT, tracking TEXT, status TEXT, tracking_status TEXT, expected_date TEXT, order_date TEXT,
    received_at TEXT, delivered_date TEXT, items TEXT, order_total REAL, tax_amount REAL, ship_cost REAL,
    finder_fee REAL, shipping_name TEXT, shipping_address TEXT, status_changed_at TEXT, created_at TEXT)`);
  ensureRawEmailTable(db);
  return db;
}
async function quiet(fn) { const l = console.log; console.log = () => {}; try { return await fn(); } finally { console.log = l; } }

// A Target confirmation shaped like the real Topps email, with tracking links
// that happen to contain "tcg" — the exact trap.
const LINK = 'https://click.oe1.target.com/?qs=ABB7InYiOjEsImQiOjUwMDh9AAoAAAAABPJBTHZTcg9xQ2kLmTCgRnZ';
const targetConfirm = (num, item, price, qty = 2) => ({
  subject: `Thanks for shopping with us! Here's your order #:${num}.`,
  html: `<html><body><p><a href="${LINK}">${LINK}</a></p><p>Order #${num}</p><p>Thanks for your order, Sam!</p>
    <table><tr><td>${item}</td><td>Qty: ${qty}</td><td>$${price} / ea</td></tr></table>
    <table><tr><td>Subtotal (2 items)</td><td>$99.98</td></tr><tr><td>Total</td><td>$108.50</td></tr></table>
    <p>Perfect pairings for your order:</p><p><a href="${LINK}tcgX">${LINK}tcgX</a></p></body></html>`,
  text: `${LINK}\nOrder #${num}\nThanks for your order, Sam!\n${item}\nQty: ${qty}\n$${price} / ea\n${LINK}tcgX`,
});

(async () => {
  console.log('\n── Rules ──');
  eq('Topps MLB box → not Pokemon',            decideCategory({ items: ['2x 2026 Topps MLB Bowman Chrome Trading Card Mega Box @ $49.99'], retailerDefault: 'Other' }), 'Other');
  eq('Ring camera → not Pokemon',              decideCategory({ items: ['Ring Spotlight Cam Plus, Battery Smart Security Video Camera, 2 Pack'], retailerDefault: 'Other' }), 'Other');
  eq('Pokémon (accented) item → Pokemon',      decideCategory({ items: ['2x Pokémon 30th Anniversary Poster Collection @ $19.99'] }), 'Pokemon');
  eq('LEGOPOKEMONEEVEE → Pokemon',             decideCategory({ items: ['96x LEGOPOKEMONEEVEE (Item 990497327)'] }), 'Pokemon');
  eq('One Piece card game → One Piece',        decideCategory({ items: ["2x One Piece Card Game: The World's Strongest Warriors"] }), 'One Piece');
  eq('Hot Wheels → Mattel',                    decideCategory({ items: ['2x Hot Wheels RLC Exclusive Ferrari F40 (Item #JJY72)'] }), 'Mattel');
  eq('"TCG" alone is not Pokemon (Lorcana)',   decideCategory({ items: ['Disney Lorcana TCG Booster Box'] }), 'Other');
  eq('"nami" inside a word is not One Piece',  categoryOfText('Dynamic Speaker'), null);
  eq('"chopper" kitchen tool is not One Piece', categoryOfText('Vegetable Chopper'), null);
  eq('PKC plush with no brand word → retailer default', decideCategory({ items: ['Sylveon Plush - 8 In.'], retailerDefault: 'Pokemon' }), 'Pokemon');
  eq('no items: subject is used',              decideCategory({ items: [], subject: 'Your Pokémon Center order shipped', retailerDefault: 'Other' }), 'Pokemon');
  eq('no items, plain subject: retailer default', decideCategory({ items: [], subject: 'Your order has shipped', retailerDefault: 'Other' }), 'Other');

  console.log('\n── Real scraper: Topps email whose links contain "tcg" ──');
  {
    const db = makeDb();
    const e = targetConfirm('102000000000012', '2026 Topps MLB Bowman Chrome Trading Card Mega Box', '49.99');
    const html = e.html;
    db.prepare('INSERT INTO raw_emails (message_id,subject,from_email,email_date,html,text) VALUES (?,?,?,?,?,?)')
      .run(['<topps>', e.subject, 'orders@oe1.target.com', '2026-09-23T07:20:27Z', html, e.text]);
    eq('links really contain "tcg" (the trap is armed)', /tcg/i.test(e.text), true);
    await quiet(() => reparseStoredEmails(db));
    const row = db.prepare("SELECT category, retailer FROM bot_orders WHERE order_number='102000000000012'").get();
    eq('order created', !!row, true);
    eq('filed under Other, not Pokemon', row && row.category, 'Other');
    eq('retailer Target', row && row.retailer, 'Target');
  }

  console.log('\n── Real scraper: a genuine Pokémon order still lands in Pokemon ──');
  {
    const db = makeDb();
    const e = targetConfirm('102000000000011', 'Pokémon Trading Card Game: 30th Celebration Tech Sticker Collection', '19.99');
    db.prepare('INSERT INTO raw_emails (message_id,subject,from_email,email_date,html,text) VALUES (?,?,?,?,?,?)')
      .run(['<poke>', e.subject, 'orders@oe.target.com', '2026-09-16T10:00:00Z', e.html, e.text]);
    await quiet(() => reparseStoredEmails(db));
    eq('Pokemon', db.prepare("SELECT category FROM bot_orders WHERE order_number='102000000000011'").get().category, 'Pokemon');
  }

  console.log('\n── Real scraper: a wrongly-filed order is corrected by its next email ──');
  {
    const db = makeDb();
    db.prepare(`INSERT INTO bot_orders (category, retailer, order_number, status, items)
                VALUES ('Pokemon','Target','102000000000013','Confirmed',?)`)
      .run([JSON.stringify(['2x 2026 Topps MLB Bowman Chrome Trading Card Mega Box @ $49.99'])]);
    const e = targetConfirm('102000000000013', '2026 Topps MLB Bowman Chrome Trading Card Mega Box', '49.99');
    db.prepare('INSERT INTO raw_emails (message_id,subject,from_email,email_date,html,text) VALUES (?,?,?,?,?,?)')
      .run(['<t2>', 'Items from order #102000000000013 are about to ship.', 'orders@oe.target.com', '2026-09-25T19:07:56Z', e.html, e.text]);
    await quiet(() => reparseStoredEmails(db));
    eq('moved out of Pokemon', db.prepare("SELECT category FROM bot_orders WHERE order_number='102000000000013'").get().category, 'Other');
  }

  console.log('\n── Startup repair of existing rows ──');
  {
    const db = makeDb();
    const add = (num, retailer, cat, items) => db.prepare(
      "INSERT INTO bot_orders (category, retailer, order_number, status, items) VALUES (?,?,?,'Shipped',?)")
      .run([cat, retailer, num, items === null ? null : JSON.stringify(items)]);
    add('T1', 'Target',         'Pokemon', ['2x 2026 Topps MLB Bowman Chrome Trading Card Mega Box @ $49.99']);
    add('H1', 'Homedepot',      'Pokemon', ['Ring Spotlight Cam Plus, Battery Smart Security Video Camera, 2 Pack']);
    add('S1', "Sam's Club",     'Pokemon', ['96x LEGOPOKEMONEEVEE (Item 990497327)']);
    add('P1', 'Pokemon Center', 'Pokemon', ['1x Sylveon Plush - 8 In.']);
    add('M1', 'Target',         'Other',   ['2x Pokémon 30th Anniversary EX Box 1 @ $29.99']);
    add('N1', 'Target',         'Pokemon', null);   // no items — nothing to go on, leave it

    const def = r => ({ 'Pokemon Center': 'Pokemon', 'Mattel Creations': 'Mattel', 'Bear Walker': 'One Piece' })[r] || 'Other';
    const r1 = recategorizeOrders(db, def, () => {});
    const cat = n => db.prepare('SELECT category FROM bot_orders WHERE order_number=?').get([n]).category;
    eq('Topps → Other',                 cat('T1'), 'Other');
    eq('Ring → Other',                  cat('H1'), 'Other');
    eq('LEGO Eevee stays Pokemon',      cat('S1'), 'Pokemon');
    eq('PKC plush stays Pokemon',       cat('P1'), 'Pokemon');
    eq('mis-filed Pokémon box → Pokemon', cat('M1'), 'Pokemon');
    eq('order without items untouched', cat('N1'), 'Pokemon');
    eq('3 changed',                     r1.changed, 3);
    eq('second run changes nothing',    recategorizeOrders(db, def, () => {}).changed, 0);
  }

  console.log(`\n${'─'.repeat(60)}`);
  console.log(`${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
