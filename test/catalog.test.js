'use strict';
// End-to-end test of the product catalog against a REAL SQLite database
// (node:sqlite), not a hand-written fake — fakes have already hidden bugs here.
//
// Walks the user's actual workflow: see suggested names, confirm them, fix a
// name, merge two products, unlink a stray title — and checks after each step
// that the item view regroups correctly without any order being rewritten.

process.removeAllListeners('warning');           // silence node:sqlite's experimental notice
const { DatabaseSync } = require('node:sqlite');
const Sku = require('../skuCatalog');
const { computeItemGroups } = require('../itemView');

// node-sqlite3-wasm takes params as an array; node:sqlite takes them spread.
function makeDb() {
  const raw = new DatabaseSync(':memory:');
  const db = {
    exec: sql => raw.exec(sql),
    prepare: sql => {
      const st = raw.prepare(sql);
      return {
        all: (p = []) => st.all(...p),
        get: (p = []) => st.get(...p),
        run: (p = []) => st.run(...p),
      };
    },
  };
  db.exec('CREATE TABLE bot_sku_prices (sku TEXT PRIMARY KEY, buyer_fee REAL DEFAULT 0, sale_price REAL DEFAULT 0)');
  Sku.ensureSkuTables(db);
  return db;
}

let passed = 0, failed = 0;
const eq = (n, a, e) => {
  if (a === e) { passed++; console.log(`  ✅ ${n}`); }
  else { failed++; console.log(`  ❌ ${n} — got ${JSON.stringify(a)}, expected ${JSON.stringify(e)}`); }
};

// Real titles from the user's orders — the same product arriving three ways.
const TARGET_TECH = 'Pokémon Trading Card Game: 30th Celebration Tech Sticker Collection (Lucario or Alolan Exeggutor)- Styles May Vary';
const TARGET_OLD  = 'Pokemon 30th Celebration Tech Sticker Collection Trading Cards (Styles May Vary)';
const PKC_LUCARIO = 'Pokemon TCG: 30th Celebration Tech Sticker Collection (Lucario)';
const EX_BOX_NEW  = 'Pokémon 30th Anniversary EX Box 1';
const EX_BOX_OLD  = 'Pokemon 30th Anniversary EX Box 1';

const ORDERS = [
  { id: 1, retailer: 'Target', status: 'Delivered', order_total: 43.39, items: JSON.stringify([`2x ${TARGET_TECH} @ $19.99`]) },
  { id: 2, retailer: 'Target', status: 'Delivered', order_total: 43.39, items: JSON.stringify([`2x ${TARGET_OLD} ($19.99/ea)`]) },
  { id: 3, retailer: 'Pokemon Center', status: 'Delivered', order_total: 21.70, items: JSON.stringify([`1x ${PKC_LUCARIO} (SKU 10-10449-122) @ $19.99`]) },
  { id: 4, retailer: 'Target', status: 'Delivered', order_total: 65.09, items: JSON.stringify([`2x ${EX_BOX_NEW} @ $29.99`]) },
  { id: 5, retailer: 'Target', status: 'Delivered', order_total: 65.09, items: JSON.stringify([`2x ${EX_BOX_OLD} ($29.99/ea)`]) },
];
const ORDERS_SNAPSHOT = JSON.stringify(ORDERS);

const view = db => computeItemGroups(ORDERS, db.prepare('SELECT * FROM bot_sku_prices').all(), Sku.loadCatalog(db));
const row  = (rows, re) => rows.find(r => re.test(r.name));

const db = makeDb();

console.log('\n── 1. Before anything is linked ──');
{
  const rows = view(db);
  const ex = row(rows, /EX Box 1/);
  eq('both EX Box spellings already one row', rows.filter(r => /EX Box 1/.test(r.name)).length, 1);
  eq('EX Box: 4 units',                     ex.qty, 4);
  eq('EX Box: suggested short name',        ex.name, '30th Anniversary EX Box 1');
  eq('EX Box: flagged unconfirmed',         ex.unlinked, true);
  eq('old ($19.99/ea) price format read',   ex.perUnitItem, 29.99);
  eq('tech sticker titles still separate',  rows.filter(r => /Tech Sticker/.test(r.name)).length, 3);
}

console.log('\n── 2. Confirm all suggestions ──');
{
  const unlinked = view(db).filter(r => r.unlinked);
  for (const g of unlinked) {
    const id = Sku.createProduct(db, g.name);
    Sku.linkTitles(db, id, g.rawNames);
  }
  const rows = view(db);
  eq('nothing left unconfirmed', rows.filter(r => r.unlinked).length, 0);
  eq('4 products',              rows.length, 4);
}

console.log('\n── 3. Fix a name — everything regroups, no orders touched ──');
{
  const ex = row(view(db), /EX Box 1/);
  Sku.saveProduct(db, { productId: ex.productId, name: 'Sylveon ex Box', rawNames: [] });
  const rows = view(db);
  const renamed = row(rows, /Sylveon/);
  eq('new name shown',            renamed && renamed.name, 'Sylveon ex Box');
  eq('still 4 units',             renamed && renamed.qty, 4);
  eq('same product id',           renamed && renamed.productId, ex.productId);
  eq('order data unchanged',      JSON.stringify(ORDERS), ORDERS_SNAPSHOT);
}

console.log('\n── 4. Merge the three Tech Sticker variants into one SKU ──');
{
  const techs = view(db).filter(r => /Tech Sticker/.test(r.name));
  eq('three rows before merge', techs.length, 3);
  const keep = Sku.saveProduct(db, { productId: techs[0].productId, name: '30th Tech Sticker Collection', rawNames: [] });
  for (const t of techs.slice(1)) {
    Sku.saveProduct(db, { productId: t.productId, name: t.name, rawNames: t.rawNames, mergeIntoId: keep });
  }
  const rows = view(db);
  const merged = rows.filter(r => /Tech Sticker/.test(r.name));
  eq('one row after merge',        merged.length, 1);
  eq('units rolled together (2+2+1)', merged[0].qty, 5);
  eq('3 store titles under it',    merged[0].rawNames.length, 3);
  eq('both retailers listed',      merged[0].retailers.slice().sort().join('|'), 'Pokemon Center|Target');
  eq('merged-away products gone',  Sku.listProducts(db).length, 2);
}

console.log('\n── 5. Unlink a stray title — it splits back out ──');
{
  Sku.unlinkTitle(db, PKC_LUCARIO);
  const rows = view(db);
  const main  = row(rows, /^30th Tech Sticker Collection$/);
  const stray = rows.find(r => r.unlinked);
  eq('main product down to 4 units', main.qty, 4);
  eq('stray is its own row',         stray && /Lucario\)$/.test(stray.name), true);
  eq('stray flagged unconfirmed',    stray && stray.unlinked, true);
}

console.log('\n── 6. Prices follow the product ──');
{
  const sy = row(view(db), /Sylveon/);
  db.prepare('INSERT OR REPLACE INTO bot_sku_prices (sku, buyer_fee, sale_price) VALUES (?,?,?)').run([sy.skuKey, 2, 45]);
  Sku.saveProduct(db, { productId: sy.productId, name: 'Sylveon ex Premium Box', rawNames: [] });
  const again = row(view(db), /Sylveon/);
  eq('sale price survives rename', again.sale_price, 45);
  eq('buyer fee survives rename',  again.buyer_fee, 2);
}

console.log('\n── 7. Prices typed BEFORE linking carry over ──');
{
  const db2 = makeDb();
  db2.prepare('INSERT INTO bot_sku_prices (sku, buyer_fee, sale_price) VALUES (?,?,?)').run([EX_BOX_OLD, 1.5, 40]);
  const ex = row(computeItemGroups(ORDERS, db2.prepare('SELECT * FROM bot_sku_prices').all(), Sku.loadCatalog(db2)), /EX Box 1/);
  eq('found while unlinked', ex.sale_price, 40);
  const id = Sku.createProduct(db2, ex.name);
  Sku.linkTitles(db2, id, ex.rawNames);
  const linked = row(computeItemGroups(ORDERS, db2.prepare('SELECT * FROM bot_sku_prices').all(), Sku.loadCatalog(db2)), /EX Box 1/);
  eq('still found after linking', linked.sale_price, 40);
}

console.log('\n── 8. Accepting a name that already exists links, not duplicates ──');
{
  const db3 = makeDb();
  const a = Sku.createProduct(db3, 'Sylveon ex Box');
  const b = Sku.createProduct(db3, 'sylveon  EX box');   // same, different case/spacing
  eq('same product returned',   a, b);
  eq('only one product exists', Sku.listProducts(db3).length, 1);
}

console.log('\n── 9. Renaming onto an existing name merges ──');
{
  const db4 = makeDb();
  const x = Sku.createProduct(db4, 'Poster Collection');
  Sku.linkTitles(db4, x, ['Pokémon 30th Anniversary Poster Collection']);
  const y = Sku.createProduct(db4, 'Poster Set');
  Sku.linkTitles(db4, y, ['Pokemon 30th Anniversary Poster Collection Set']);
  const out = Sku.saveProduct(db4, { productId: y, name: 'Poster Collection', rawNames: [] });
  eq('merged into existing', out, x);
  eq('one product left',     Sku.listProducts(db4).length, 1);
  eq('holds both titles',    Sku.listProducts(db4)[0].titles.length, 2);
}

console.log('\n── 10. Removing a product never deletes orders ──');
{
  const before = JSON.stringify(ORDERS);
  const p = Sku.listProducts(db)[0];
  Sku.deleteProduct(db, p.id);
  eq('orders untouched', JSON.stringify(ORDERS), before);
  eq('its titles are unconfirmed again', view(db).some(r => r.unlinked), true);
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
