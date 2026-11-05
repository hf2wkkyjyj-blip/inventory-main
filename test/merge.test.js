'use strict';
// Duplicate-order merging. Reproduces the rows seen in production: the email
// scraper's row (priced items, total, tracking) plus the bot API's duplicate
// (buyer name only, unpriced item, no total).

process.removeAllListeners('warning');
const { DatabaseSync } = require('node:sqlite');
const M = require('../orderMerge');

let passed = 0, failed = 0;
const eq = (n, a, e) => {
  if (a === e) { passed++; console.log(`  ✅ ${n}`); }
  else { failed++; console.log(`  ❌ ${n} — got ${JSON.stringify(a)}, expected ${JSON.stringify(e)}`); }
};

// Tiny in-memory table implementing just the SQL orderMerge.js issues.
function makeDb(rows) {
  const table = rows.map(r => ({ ...r }));
  return {
    table,
    prepare(sql) {
      const s = sql.replace(/\s+/g, ' ').trim();
      return {
        all(p = []) {
          if (!/bot_orders/i.test(s)) return [];
          if (/GROUP BY order_number HAVING/i.test(s)) {
            const c = {};
            table.filter(r => r.order_number && String(r.order_number).trim())
                 .forEach(r => { c[r.order_number] = (c[r.order_number] || 0) + 1; });
            return Object.entries(c).filter(([, n]) => n > 1).map(([order_number]) => ({ order_number }));
          }
          if (/WHERE order_number=\?/i.test(s)) {
            return table.filter(r => r.order_number === p[0]).sort((a, b) => a.id - b.id);
          }
          return [];
        },
        run(p = []) {
          if (!/bot_orders/i.test(s)) return;      // check-ins, issues, sales: not modelled here
          if (/^UPDATE/i.test(s)) {
            const id = p[p.length - 1];
            const cols = s.match(/SET (.+) WHERE/i)[1].split(',').map(c => c.split('=')[0].trim());
            const row = table.find(r => r.id === id);
            cols.forEach((c, i) => { row[c] = p[i]; });
          } else if (/^DELETE/i.test(s)) {
            for (const id of p) { const i = table.findIndex(r => r.id === id); if (i >= 0) table.splice(i, 1); }
          }
        },
      };
    },
  };
}

const silent = () => {};

console.log('\n── The real duplicates from the screenshot ──');
{
  const db = makeDb([
    // Email scraper's row: the good one.
    { id: 10, order_number: '902000000000024', retailer: 'Target', category: 'Pokemon', status: 'Delivered',
      items: '["2x Pokemon Trading Card Game: 30th Celebration Booster Bundle @ $29.99"]',
      order_total: 65.09, tax_amount: 5.11, ship_cost: 0, tracking: '1ZAA11110000000003',
      shipping_name: null, shipping_address: null, account_email: null },
    // Bot API's duplicate: buyer only.
    { id: 11, order_number: '902000000000024', retailer: 'Target', category: 'Pokemon', status: 'Delivered',
      items: '["Pokemon TCG: 30th Celebration Booster Bundle"]',
      order_total: 0, tax_amount: 0, ship_cost: 0, tracking: null,
      shipping_name: 'Sam', shipping_address: '4200 Example Blvd', account_email: 'sam@example.com' },
  ]);

  const r = M.mergeDuplicateOrders(db, silent);
  eq('one order merged', r.merged, 1);
  eq('one duplicate removed', r.removed, 1);
  eq('single row remains', db.table.length, 1);

  const row = db.table[0];
  eq('kept the scraper row', row.id, 10);
  eq('kept priced items', /@ \$29\.99/.test(row.items), true);
  eq('kept real total', row.order_total, 65.09);
  eq('kept tracking', row.tracking, '1ZAA11110000000003');
  eq('gained buyer from bot row', row.shipping_name, 'Sam');
  eq('gained address from bot row', row.shipping_address, '4200 Example Blvd');
  eq('gained account from bot row', row.account_email, 'sam@example.com');
}

console.log('\n── Richest row wins even if it was inserted second ──');
{
  const db = makeDb([
    { id: 1, order_number: 'P0099000004', retailer: 'Pokemon Center', status: 'Confirmed',
      items: '["Booster Bundle"]', order_total: 0, tracking: null, shipping_name: 'Sam' },
    { id: 2, order_number: 'P0099000004', retailer: 'Pokemon Center', status: 'Shipped',
      items: '["3x Booster Bundle @ $35.14"]', order_total: 112.84, tracking: '876543210987', shipping_name: null },
  ]);
  M.mergeDuplicateOrders(db, silent);
  eq('kept id 2 (priced, tracked)', db.table[0].id, 2);
  eq('buyer filled in', db.table[0].shipping_name, 'Sam');
}

console.log('\n── Same number, DIFFERENT retailers must not merge ──');
{
  // Short Shopify-style numbers legitimately collide across stores.
  const db = makeDb([
    { id: 1, order_number: '25164', retailer: 'Bear Walker',   items: '["Skateboard @ $129.85"]', order_total: 125.48 },
    { id: 2, order_number: '25164', retailer: 'Shopify Store', items: '["T-shirt @ $20.00"]',    order_total: 22.00 },
  ]);
  const r = M.mergeDuplicateOrders(db, silent);
  eq('skipped, not merged', r.skipped, 1);
  eq('both rows kept', db.table.length, 2);
}

console.log('\n── Idempotent ──');
{
  const db = makeDb([
    { id: 1, order_number: 'X1', retailer: 'Target', order_total: 10, items: '["A @ $10.00"]' },
    { id: 2, order_number: 'X1', retailer: 'Target', order_total: 0,  items: '[]', shipping_name: 'Sam' },
  ]);
  M.mergeDuplicateOrders(db, silent);
  const second = M.mergeDuplicateOrders(db, silent);
  eq('second run finds nothing', second.merged, 0);
  eq('still one row', db.table.length, 1);
}

console.log('\n── Bot API: findExisting + fillExisting ──');
{
  const db = makeDb([
    { id: 5, order_number: '912000000000034', retailer: 'Target', order_total: 65.09,
      items: '["2x Pokemon TCG @ $29.99"]', tracking: '1ZAA11110000000002', shipping_name: null },
  ]);
  const hit = M.findExisting(db, '912000000000034', 'Target');
  eq('finds the scraper row', hit && hit.id, 5);
  eq('matches when bot omits retailer', (M.findExisting(db, '912000000000034', null) || {}).id, 5);
  eq('no match for another store', M.findExisting(db, '912000000000034', 'Walmart'), null);

  const filled = M.fillExisting(db, hit, { shipping_name: 'Sam', order_total: 0, items: '["Pokemon TCG"]' });
  eq('only empty field filled', filled.join(','), 'shipping_name');
  eq('total not clobbered by bot 0', db.table[0].order_total, 65.09);
  eq('priced items not clobbered', /@ \$29\.99/.test(db.table[0].items), true);
}

console.log('\n── Topps: scraper says "Shopify Store", the bot says "Topps" ──');
{
  const raw = new DatabaseSync(':memory:');
  const a = p => (p === undefined ? [] : Array.isArray(p) ? p : [p]);
  const real = {
    exec: sql => raw.exec(sql),
    prepare: sql => { const st = raw.prepare(sql); return { all: p => st.all(...a(p)), get: p => st.get(...a(p)), run: p => st.run(...a(p)) }; },
  };
  raw.exec(`CREATE TABLE bot_orders (id INTEGER PRIMARY KEY, order_number TEXT, retailer TEXT, category TEXT, status TEXT, items TEXT,
    order_total REAL, tax_amount REAL, ship_cost REAL, finder_fee REAL, tracking TEXT, shipping_name TEXT, shipping_address TEXT, account_email TEXT)`);
  raw.exec('CREATE TABLE bot_checkins (order_id INTEGER PRIMARY KEY, checked_at TEXT)');
  raw.exec('CREATE TABLE bot_issues (id INTEGER PRIMARY KEY, order_id INTEGER, item_key TEXT)');
  raw.exec('CREATE TABLE bot_sales (id INTEGER PRIMARY KEY, order_id INTEGER)');
  const add = (id, no, shop, o = {}) => raw.prepare(`INSERT INTO bot_orders (id, order_number, retailer, status, items, order_total, shipping_name, account_email)
    VALUES (?,?,?,?,?,?,?,?)`).run(id, no, shop, 'Confirmed', o.items || '[]', o.total || 0, o.name || null, o.email || null);

  add(1, 'US-15162323-S', 'Shopify Store', { items: '["2026 Topps Chrome\u00ae Update Series Baseball \u00b7 Jumbo Box @ $79.99"]', total: 86.39, name: '---------------- Sang Nguyen' });
  add(2, 'US-15162323-S', 'Topps',         { name: 'Sang Nguyen', email: 'buyer@example.com' });
  raw.exec("INSERT INTO bot_checkins VALUES (2, '2026-11-04')");                 // you checked in the bot's copy
  raw.exec("INSERT INTO bot_issues (order_id, item_key) VALUES (2, 'box')");
  raw.exec("INSERT INTO bot_sales (order_id) VALUES (2)");
  add(3, '25164', 'Bear Walker',   { total: 125.48 });                           // short Shopify numbers can collide…
  add(4, '25164', 'Shopify Store', { total: 22 });                               // …two different shops: left alone
  add(5, 'US-777-S', 'Topps', {}); add(6, 'US-777-S', 'Walmart', {});            // two real shops: left alone

  eq('clean the dashed name',          M.cleanNames(real, silent), 1);
  eq('name is just the name',          raw.prepare('SELECT shipping_name n FROM bot_orders WHERE id=1').get().n, 'Sang Nguyen');
  eq('clean again: nothing to do',     M.cleanNames(real, silent), 0);

  const r = M.mergeDuplicateOrders(real, silent);
  eq('one order merged',               r.merged, 1);
  eq('two pairs left alone',           r.skipped, 2);
  const all = raw.prepare('SELECT id, retailer FROM bot_orders ORDER BY id').all();
  eq('the copy is gone, others stay',  JSON.stringify(all.map(x => x.id)), '[1,3,4,5,6]');
  eq('shop name beats "Shopify Store"', all[0].retailer, 'Topps');
  eq('kept the priced row',            raw.prepare('SELECT order_total t FROM bot_orders WHERE id=1').get().t, 86.39);
  eq('gained the buyer account',       raw.prepare('SELECT account_email e FROM bot_orders WHERE id=1').get().e, 'buyer@example.com');
  eq('check-in moved to the kept row', JSON.stringify(raw.prepare('SELECT order_id FROM bot_checkins').all().map(x => x.order_id)), '[1]');
  eq('issue moved',                    JSON.stringify(raw.prepare('SELECT order_id FROM bot_issues').all().map(x => x.order_id)), '[1]');
  eq('presale link moved',             JSON.stringify(raw.prepare('SELECT order_id FROM bot_sales').all().map(x => x.order_id)), '[1]');

  console.log('\n── The bot posting the same order again ──');
  raw.exec("DELETE FROM bot_orders"); raw.exec('DELETE FROM bot_checkins');
  add(1, 'US-15162345-S', 'Shopify Store', { total: 86.39 });
  const hit = M.findExisting(real, 'US-15162345-S', 'Topps');
  eq('finds the scraper row under its other label', hit && hit.id, 1);
  M.fillExisting(real, hit, { retailer: 'Topps', shipping_name: 'Sang Nguyen' });
  eq('and names the shop',             raw.prepare('SELECT retailer r FROM bot_orders WHERE id=1').get().r, 'Topps');
  add(2, '25164', 'Bear Walker'); 
  eq('short number, different shop: no match', M.findExisting(real, '25164', 'Shopify Store'), null);
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
