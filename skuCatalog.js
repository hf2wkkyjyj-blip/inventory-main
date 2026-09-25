'use strict';
// ─── PRODUCT (SKU) CATALOG ───────────────────────────────────────────────────
//
// One product can reach you under many titles: Target sells it as
// "Pokémon Trading Card Game: 30th Celebration Tech Sticker Collection (Lucario
// or Alolan Exeggutor)- Styles May Vary", Pokémon Center as "Pokemon TCG: 30th
// Celebration Tech Sticker Collection (Lucario)". No name-matching rule can be
// trusted to know those are the same thing — the user can.
//
//   sku_products   one row per real product, with a short display name
//   sku_aliases    store title (normalised) → product
//
// Order data is NEVER rewritten. Grouping is resolved through the aliases every
// time the item view loads, so editing a product regroups everything at once,
// and a newly scraped order under a known title lands in the right product with
// no action at all.

const { itemKey, parseItemName, shortenName } = require('./itemNames');

// Pricing (buyer fee / sale price) for a linked product is stored under this
// key, so renaming the product doesn't orphan its prices.
const productSkuKey = id => `#p${id}`;

function ensureSkuTables(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS sku_products (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS sku_aliases (
    alias_key  TEXT PRIMARY KEY,
    raw_name   TEXT,
    product_id INTEGER NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
}

function loadCatalog(db) {
  const products = new Map();
  const aliases  = new Map();
  try {
    db.prepare('SELECT id, name FROM sku_products').all().forEach(p => products.set(p.id, p));
    db.prepare('SELECT alias_key, raw_name, product_id FROM sku_aliases').all()
      .forEach(a => { if (products.has(a.product_id)) aliases.set(a.alias_key, a.product_id); });
  } catch (_) { /* tables not created yet */ }
  return { products, aliases };
}

const aliasKeyFor = raw => itemKey(parseItemName(raw));

function findProductByName(db, name) {
  const want = itemKey(name);
  if (!want) return null;
  return db.prepare('SELECT id, name FROM sku_products').all().find(p => itemKey(p.name) === want) || null;
}

// Create a product, or return the existing one with the same name. Reusing by
// name means accepting two different suggestions that shorten to the same
// thing merges them, instead of producing two products called the same.
function createProduct(db, name) {
  const clean = String(name || '').trim();
  if (!clean) throw new Error('Product name required');
  const existing = findProductByName(db, clean);
  if (existing) return existing.id;
  const r = db.prepare('INSERT INTO sku_products (name) VALUES (?)').run([clean]);
  if (r && r.lastInsertRowid != null) return Number(r.lastInsertRowid);
  return findProductByName(db, clean).id;
}

function renameProduct(db, id, name) {
  const clean = String(name || '').trim();
  if (!clean) throw new Error('Product name required');
  // Renaming onto another product's name means "these are the same" — merge.
  const clash = findProductByName(db, clean);
  if (clash && clash.id !== id) { mergeProducts(db, id, clash.id); return clash.id; }
  db.prepare('UPDATE sku_products SET name=? WHERE id=?').run([clean, id]);
  return id;
}

function copyPricingIfMissing(db, fromSkus, toSku) {
  try {
    const have = db.prepare('SELECT 1 FROM bot_sku_prices WHERE sku=?').get([toSku]);
    if (have) return;
    const rows = db.prepare('SELECT * FROM bot_sku_prices').all();
    const wanted = new Set(fromSkus.map(itemKey));
    const src = rows.find(r => wanted.has(itemKey(r.sku)) && (r.buyer_fee || r.sale_price));
    if (src) {
      db.prepare('INSERT OR REPLACE INTO bot_sku_prices (sku, buyer_fee, sale_price) VALUES (?,?,?)')
        .run([toSku, src.buyer_fee || 0, src.sale_price || 0]);
    }
  } catch (_) { /* pricing table optional */ }
}

// Point these store titles at a product (moving them from any other product).
function linkTitles(db, productId, rawNames) {
  const titles = [...new Set((rawNames || []).map(parseItemName).filter(Boolean))];
  for (const t of titles) {
    db.prepare('INSERT OR REPLACE INTO sku_aliases (alias_key, raw_name, product_id) VALUES (?,?,?)')
      .run([aliasKeyFor(t), t, productId]);
  }
  // Prices typed in before the product existed were saved under the title.
  copyPricingIfMissing(db, titles, productSkuKey(productId));
  return titles.length;
}

function unlinkTitle(db, rawName) {
  db.prepare('DELETE FROM sku_aliases WHERE alias_key=?').run([aliasKeyFor(rawName)]);
}

function mergeProducts(db, fromId, intoId) {
  if (fromId === intoId) return intoId;
  db.prepare('UPDATE sku_aliases SET product_id=? WHERE product_id=?').run([intoId, fromId]);
  copyPricingIfMissing(db, [productSkuKey(fromId)], productSkuKey(intoId));
  deleteProduct(db, fromId);
  return intoId;
}

// Removes the product and its links. Orders are untouched — their titles simply
// show up as unlinked again.
function deleteProduct(db, id) {
  db.prepare('DELETE FROM sku_aliases WHERE product_id=?').run([id]);
  db.prepare('DELETE FROM sku_products WHERE id=?').run([id]);
  try { db.prepare('DELETE FROM bot_sku_prices WHERE sku=?').run([productSkuKey(id)]); } catch (_) {}
}

// Single entry point for the edit dialog. Returns the product id that now owns
// the titles.
function saveProduct(db, { productId = null, name, rawNames = [], mergeIntoId = null }) {
  let id;
  if (mergeIntoId) {
    id = Number(mergeIntoId);
    if (productId && Number(productId) !== id) mergeProducts(db, Number(productId), id);
  } else if (productId) {
    id = renameProduct(db, Number(productId), name);
  } else {
    id = createProduct(db, name);
  }
  if (rawNames.length) linkTitles(db, id, rawNames);
  return id;
}

function listProducts(db) {
  const products = db.prepare('SELECT id, name FROM sku_products ORDER BY name').all();
  const aliases  = db.prepare('SELECT raw_name, product_id FROM sku_aliases').all();
  return products.map(p => ({
    ...p,
    titles: aliases.filter(a => a.product_id === p.id).map(a => a.raw_name),
  }));
}

module.exports = {
  ensureSkuTables, loadCatalog, listProducts, saveProduct,
  createProduct, renameProduct, linkTitles, unlinkTitle, mergeProducts, deleteProduct,
  productSkuKey, aliasKeyFor, shortenName,
};
