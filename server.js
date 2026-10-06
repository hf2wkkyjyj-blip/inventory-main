require('dotenv').config();
const express = require('express');
const { Database } = require('node-sqlite3-wasm');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const cheerio = require('cheerio');
const puppeteer = require('puppeteer-core');

// Local modules. Declared up here because startup code further down calls
// them — a `const` used before its declaration line throws, and inside a
// try/catch that failure would be silent.
const { decomposeItem, parseItemName, splitItemParts, itemKey, shortenName } = require('./itemNames');
const { computeItemGroups, orderLineCosts } = require('./itemView');
const SkuCatalog = require('./skuCatalog');
const { computePackages } = require('./packageView');
const { splitBoxFee, orderSignature } = require('./feeSplit');
const { buildAddressBook, addressKey, parseAddress } = require('./addresses');
const { loadPartners, annotatePartners } = require('./partners');

// Jigged address variations → the one real place they deliver to (addresses.js).
// The book is built from every address on file so labels are stable whatever
// filter a request uses. The raw text stays in the database (it's what's on the
// box label); views get main_address, and the grouped views use it outright.
function addressBook() {
  let raws = [];
  try { raws = db.prepare("SELECT shipping_address FROM bot_orders WHERE shipping_address IS NOT NULL AND shipping_address<>''").all().map(r => r.shipping_address); } catch (_) {}
  return buildAddressBook(raws);
}
// Who lives at each main address (the house owner), keyed like the address
// book so every jig variation of the address finds them. Stored in the
// database only — never in code, which goes to GitHub.
function loadOwners() {
  const m = new Map();
  try { db.prepare('SELECT * FROM bot_address_owners').all().forEach(r => m.set(r.addr_key, r)); } catch (_) {}
  return m;
}
function withMainAddress(orders, { replace = false } = {}) {
  const book = addressBook();
  const owners = loadOwners();
  orders = annotatePartners(orders, loadPartners(db));     // whose order (partners.js)
  return orders.map(o => {
    const main  = book.main(o.shipping_address);
    const k     = o.shipping_address ? addressKey(o.shipping_address) : null;
    const owner = (k && owners.get(k) && owners.get(k).owner) || null;
    return replace ? { ...o, shipping_address: main, jig_address: o.shipping_address || null, main_address: main, owner }
                   : { ...o, main_address: main, owner };
  });
}
const OrderMerge = require('./orderMerge');
const { recategorizeOrders } = require('./category');
const Retailers = require('./retailers');

// Find Chrome/Chromium on Mac
const CHROME_PATHS = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Applications/Arc.app/Contents/MacOS/Arc',
];
function findChrome() {
  for (const p of CHROME_PATHS) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

const app = express();
const PORT = process.env.PORT || 4000;
const JWT_SECRET = process.env.JWT_SECRET || 'inventory-site-secret';
const ADMIN_PASSWORD    = process.env.ADMIN_PASSWORD    || 'admin123';
const EMPLOYEE_PASSWORD = process.env.EMPLOYEE_PASSWORD || '';
// Auto-detect persistent volume: use DATA_DIR env var, or fallback to /data if it exists
const DATA_DIR = process.env.DATA_DIR || (fs.existsSync('/data') ? '/data' : null);
console.log(`📂 DATA_DIR: ${DATA_DIR || 'none (using app folder)'}`);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Uploads folder for product images
const uploadsDir = DATA_DIR
  ? path.join(DATA_DIR, 'uploads')
  : path.join(__dirname, 'public', 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
// When uploads are outside /public, serve them explicitly
if (DATA_DIR) {
  app.use('/uploads', express.static(uploadsDir));
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, Date.now() + '-' + Math.round(Math.random() * 1e6) + ext);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('Images only'));
  }
});

// ─── DATABASE ────────────────────────────────────────────────────────────────
const dbPath = DATA_DIR
  ? path.join(DATA_DIR, 'inventory.db')
  : path.join(__dirname, 'inventory.db');
console.log(`🗄️  DB path: ${dbPath}`);
try {
  const lock = dbPath + '.lock';
  if (fs.existsSync(lock)) fs.rmSync(lock, { recursive: true, force: true });
} catch(e) {}

const db = new Database(dbPath);

db.exec(`
  CREATE TABLE IF NOT EXISTS products (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL,
    category    TEXT NOT NULL DEFAULT 'Other',
    subcategory TEXT,
    description TEXT,
    price       REAL,
    price_unit  TEXT DEFAULT 'each',
    sku         TEXT,
    source      TEXT DEFAULT 'Other',
    stock       TEXT DEFAULT 'in_stock',
    images      TEXT DEFAULT '[]',
    featured    INTEGER DEFAULT 0,
    sort_order  INTEGER DEFAULT 0,
    quantity    INTEGER DEFAULT 0,
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at  DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT
  );
`);

// Migrations
try { db.exec('ALTER TABLE products ADD COLUMN quantity INTEGER DEFAULT 0'); } catch(e) {}
try { db.exec('ALTER TABLE products ADD COLUMN source_url TEXT'); } catch(e) {}
try { db.exec('ALTER TABLE products ADD COLUMN cost_price REAL'); } catch(e) {}
try { db.exec('ALTER TABLE products ADD COLUMN coverage_sqft REAL'); } catch(e) {}
try { db.exec('ALTER TABLE products ADD COLUMN member_id INTEGER'); } catch(e) {}
try { db.exec('ALTER TABLE products ADD COLUMN member_qty INTEGER DEFAULT 0'); } catch(e) {}
try { db.exec('ALTER TABLE sales ADD COLUMN payment_method TEXT'); } catch(e) {}
try { db.exec('ALTER TABLE sales ADD COLUMN member_id INTEGER'); } catch(e) {}
try { db.exec('ALTER TABLE sales ADD COLUMN member_qty_sold INTEGER DEFAULT 0'); } catch(e) {}
try { db.exec('ALTER TABLE restocks ADD COLUMN member_id INTEGER'); } catch(e) {}
try { db.exec('ALTER TABLE restocks ADD COLUMN member_qty INTEGER DEFAULT 0'); } catch(e) {}
try { db.exec('CREATE TABLE IF NOT EXISTS member_payments (id INTEGER PRIMARY KEY AUTOINCREMENT, member_id INTEGER NOT NULL, amount REAL NOT NULL, notes TEXT, paid_at DATETIME DEFAULT CURRENT_TIMESTAMP)'); } catch(e) {}
try { db.exec('CREATE TABLE IF NOT EXISTS bot_orders (id INTEGER PRIMARY KEY AUTOINCREMENT, email_id TEXT UNIQUE, subject TEXT, from_email TEXT, category TEXT DEFAULT \'Other\', retailer TEXT, order_number TEXT, account_email TEXT, order_date TEXT, delivered_date TEXT, shipping_name TEXT, shipping_address TEXT, status TEXT DEFAULT \'Confirmed\', items TEXT DEFAULT \'[]\', order_total REAL DEFAULT 0, refunded_amount REAL DEFAULT 0, notes TEXT, raw_snippet TEXT, received_at DATETIME, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)'); } catch(e) {}
// Migrations for bot_orders if table already existed
try { db.exec("ALTER TABLE bot_orders ADD COLUMN category TEXT DEFAULT 'Other'"); } catch(e) {}
try { db.exec("ALTER TABLE bot_orders ADD COLUMN retailer TEXT"); } catch(e) {}
try { db.exec("ALTER TABLE bot_orders ADD COLUMN account_email TEXT"); } catch(e) {}
try { db.exec("ALTER TABLE bot_orders ADD COLUMN order_date TEXT"); } catch(e) {}
try { db.exec("ALTER TABLE bot_orders ADD COLUMN delivered_date TEXT"); } catch(e) {}
try { db.exec("ALTER TABLE bot_orders ADD COLUMN shipping_name TEXT"); } catch(e) {}
try { db.exec("ALTER TABLE bot_orders ADD COLUMN shipping_address TEXT"); } catch(e) {}
try { db.exec("ALTER TABLE bot_orders ADD COLUMN order_total REAL DEFAULT 0"); } catch(e) {}
try { db.exec("ALTER TABLE bot_orders ADD COLUMN refunded_amount REAL DEFAULT 0"); } catch(e) {}
try { db.exec("ALTER TABLE bot_orders ADD COLUMN notes TEXT"); } catch(e) {}
try { db.exec("ALTER TABLE bot_orders ADD COLUMN tracking_status TEXT"); } catch(e) {}
try { db.exec("ALTER TABLE bot_orders ADD COLUMN expected_date TEXT"); } catch(e) {}
try { db.exec("ALTER TABLE bot_orders ADD COLUMN tax_amount REAL DEFAULT 0"); } catch(e) {}
try { db.exec("ALTER TABLE bot_orders ADD COLUMN ship_cost REAL DEFAULT 0"); } catch(e) {}
try { db.exec("ALTER TABLE bot_orders ADD COLUMN finder_fee REAL DEFAULT 0"); } catch(e) {}
// When the order last changed status. Needed to answer "what was delivered
// today?" — order_date is when it was placed, which is a different question.
try { db.exec("ALTER TABLE bot_orders ADD COLUMN status_changed_at DATETIME"); } catch(e) {}
// Who last set the status: 'manual' (you — ✎ or bulk), 'carrier' (tracking
// check), 'email', or NULL (older rows). Repair Statuses rebuilds from emails
// and must not undo a status the emails never knew about.
try { db.exec("ALTER TABLE bot_orders ADD COLUMN status_source TEXT"); } catch(e) {}
// Backfill so existing rows aren't invisible to date filters.
try { db.exec("UPDATE bot_orders SET status_changed_at=COALESCE(delivered_date, received_at, order_date) WHERE status_changed_at IS NULL"); } catch(e) {}
try { db.exec("CREATE TABLE IF NOT EXISTS bot_sku_prices (sku TEXT PRIMARY KEY, buyer_fee REAL DEFAULT 0, sale_price REAL DEFAULT 0)"); } catch(e) {}
// Individual sales of bot-bought products — you rarely sell a whole lot at once.
// sku_key matches the item view's skuKey ("#p<id>" for a linked product, else the
// store title). unit_price is per unit; fees is the total for this sale.
// Pick-up check-ins: you picked the box up and opened it. One row per order.
try { db.exec(`CREATE TABLE IF NOT EXISTS bot_checkins (
  order_id INTEGER PRIMARY KEY, checked_at TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`); } catch(e) {}
// What was wrong in a box: missing / wrong item / damaged, and the refund claim.
// status: open → claim_filed → refunded | denied_keep | denied_writeoff
try { db.exec(`CREATE TABLE IF NOT EXISTS bot_issues (
  id INTEGER PRIMARY KEY AUTOINCREMENT, order_id INTEGER NOT NULL, item_key TEXT NOT NULL, item_name TEXT,
  qty INTEGER NOT NULL, kind TEXT NOT NULL, got_item TEXT, note TEXT, status TEXT DEFAULT 'open',
  refund_amount REAL DEFAULT 0, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, resolved_at TEXT)`); } catch(e) {}

// Partners: orders bought for someone else on their card. Profile matched by
// account email or the name on the order (partners.js). Database only.
try { db.exec(`CREATE TABLE IF NOT EXISTS bot_partners (
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, emails TEXT, names TEXT, note TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`); } catch(e) {}
try { db.exec(`CREATE TABLE IF NOT EXISTS bot_partner_payouts (
  id INTEGER PRIMARY KEY AUTOINCREMENT, partner_id INTEGER NOT NULL, amount REAL NOT NULL, paid_at TEXT, note TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`); } catch(e) {}
// One list per retailer: his account emails + the names on his orders there.
// An order is his only at that retailer, with his email (and name, if listed).
try { db.exec(`CREATE TABLE IF NOT EXISTS bot_partner_profiles (
  id INTEGER PRIMARY KEY AUTOINCREMENT, partner_id INTEGER NOT NULL, retailer TEXT NOT NULL, emails TEXT, names TEXT)`); } catch(e) {}
// ✎ "whose order": NULL = match automatically, 0 = mine, else a partner id.
try { db.exec("ALTER TABLE bot_orders ADD COLUMN partner_override INTEGER"); } catch(e) {}

// House owners: the person whose house a main address is. One row per place.
try { db.exec(`CREATE TABLE IF NOT EXISTS bot_address_owners (
  addr_key TEXT PRIMARY KEY, owner TEXT NOT NULL, address TEXT, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP)`); } catch(e) {}

// Stock-count corrections: counted N on the shelf, the site expected M → qty = N − M.
// unit_cost is the landed cost at the time, so a shortage is a known loss.
try { db.exec(`CREATE TABLE IF NOT EXISTS bot_adjustments (
  id INTEGER PRIMARY KEY AUTOINCREMENT, sku_key TEXT NOT NULL, product_name TEXT, qty INTEGER NOT NULL,
  unit_cost REAL DEFAULT 0, reason TEXT DEFAULT 'count', note TEXT, counted_at TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`); } catch(e) {}

try { db.exec(`CREATE TABLE IF NOT EXISTS bot_sales (
  id INTEGER PRIMARY KEY AUTOINCREMENT, sku_key TEXT NOT NULL, product_name TEXT,
  qty INTEGER NOT NULL, unit_price REAL NOT NULL, fees REAL DEFAULT 0, channel TEXT,
  sold_at TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`); } catch(e) {}
try { db.exec("UPDATE bot_orders SET status='Confirmed' WHERE status='ordered'"); } catch(e) {}
try { db.exec("UPDATE bot_orders SET status='Shipped' WHERE status='shipped'"); } catch(e) {}
try { db.exec("UPDATE bot_orders SET status='Delivered' WHERE status='delivered' OR status='out_for_delivery'"); } catch(e) {}
// Remove junk orders created by bad order-number parsing ("Your", "Summary", CSS values like "16px")
// A real order number always has 3+ consecutive digits somewhere in it.
// We detect "no 3-digit run" by checking that replacing all digits leaves the string as long as original minus <3 chars.
try {
  const junk = db.prepare(
    `SELECT id, order_number FROM bot_orders WHERE order_number IS NOT NULL`
  ).all();
  const toDelete = junk.filter(r => !/\d{3,}/.test(r.order_number)).map(r => r.id);
  if (toDelete.length) {
    db.prepare(`DELETE FROM bot_orders WHERE id IN (${toDelete.map(()=>'?').join(',')})`)
      .run(toDelete);
    console.log(`🧹 Removed ${toDelete.length} junk order(s) with invalid order numbers:`,
      junk.filter(r=>toDelete.includes(r.id)).map(r=>r.order_number));
  }
} catch(e) { console.error('Cleanup error:', e.message); }
try { db.exec("UPDATE bot_orders SET status='Cancelled' WHERE status='cancelled'"); } catch(e) {}
try { db.exec("ALTER TABLE bot_orders ADD COLUMN tracking TEXT"); } catch(e) {}
try { db.exec("UPDATE bot_orders SET status='Unship' WHERE status='Delayed' OR status='delayed'"); } catch(e) {}
// Fix Pokemon/Mattel orders stuck as Unship — they were waiting to ship, not delayed
try { db.exec("UPDATE bot_orders SET status='Confirmed' WHERE status='Unship' AND retailer IN ('Pokemon Center','Mattel','Pokémon Center')"); } catch(e) {}
// Hand-written September fixes. These used to OVERWRITE on every start, which
// kept undoing tracking fixed with ✎ (see legacyFixes.js). Now fill-only.
try { require('./legacyFixes').applyLegacyFixes(db); } catch (e) { console.error('⚠️  legacy fixes failed:', e.message); }

db.exec(`
  CREATE TABLE IF NOT EXISTS members (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL,
    phone      TEXT,
    notes      TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS sales (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id     INTEGER,
    product_name   TEXT NOT NULL,
    quantity_sold  INTEGER NOT NULL DEFAULT 1,
    sale_price     REAL NOT NULL,
    cost_price     REAL NOT NULL DEFAULT 0,
    profit         REAL,
    payment_method TEXT,
    notes          TEXT,
    sold_at        DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS restocks (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id     INTEGER NOT NULL,
    product_name   TEXT NOT NULL,
    quantity_added INTEGER NOT NULL,
    cost_per_unit  REAL,
    notes          TEXT,
    restocked_at   DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS expenses (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    category       TEXT NOT NULL DEFAULT 'Other',
    amount         REAL NOT NULL,
    payment_method TEXT DEFAULT 'Cash',
    notes          TEXT,
    expense_date   DATE DEFAULT (date('now'))
  );
`);

// ── Baseline bot_orders import ───────────────────────────────────────────────
// Holds orders from retailers the email scraper cannot read (Mattel Creations,
// Sam's Club, Costco, Bear Walker) plus history older than the scan window.
// Losing this file means losing those orders permanently, so it stays in the repo.
//
// This runs on EVERY deploy and is safe to do so, because it is idempotent:
//   • an order already present (matched on order_number) is skipped, so it can
//     never duplicate rows the email scraper created for the same order;
//   • an order in scraper_blocked_orders is skipped, so anything deliberately
//     deleted stays deleted.
// An earlier version used a run-once flag instead. That was wrong: after a
// Wipe & Rescan the flag was still set, so the baseline never came back and
// ~100 Pokemon Center and Mattel orders silently vanished.
function importBaselineOrders(db, { force = false } = {}) {
  const importFile = path.join(__dirname, 'bot_orders_import.json');
  if (!fs.existsSync(importFile)) return { imported: 0, skipped: 0, blocked: 0, missing: true };

  let blocked = [];
  try {
    const raw = db.prepare("SELECT value FROM settings WHERE key='scraper_blocked_orders'").get();
    blocked = raw ? JSON.parse(raw.value) : [];
  } catch (_) {}
  const blockedSet = new Set(force ? [] : blocked);

  const existing = new Set(
    db.prepare('SELECT order_number FROM bot_orders WHERE order_number IS NOT NULL')
      .all().map(r => String(r.order_number))
  );

  const orders = (JSON.parse(fs.readFileSync(importFile, 'utf8')).orders) || [];
  let imported = 0, skipped = 0, blockedCount = 0;

  for (const o of orders) {
    const num = o.order_number ? String(o.order_number) : null;
    if (num && existing.has(num))    { skipped++;      continue; }
    if (num && blockedSet.has(num))  { blockedCount++; continue; }
    try {
      db.prepare(`INSERT INTO bot_orders
        (email_id,subject,from_email,category,retailer,order_number,account_email,order_date,delivered_date,shipping_name,shipping_address,status,items,order_total,refunded_amount,notes,raw_snippet,received_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run([o.email_id||null,o.subject||null,o.from_email||null,o.category||'Other',o.retailer||null,num,o.account_email||null,o.order_date||null,o.delivered_date||null,o.shipping_name||null,o.shipping_address||null,o.status||'Confirmed',JSON.stringify(o.items||[]),o.order_total||0,o.refunded_amount||0,o.notes||null,o.raw_snippet||null,o.received_at||null]);
      if (num) existing.add(num);
      imported++;
    } catch (e) { /* one bad row must not abort the rest */ }
  }

  console.log(`📦 Baseline import: ${imported} added, ${skipped} already present, ${blockedCount} blocked (${orders.length} in file)`);
  return { imported, skipped, blocked: blockedCount, total: orders.length };
}

try { importBaselineOrders(db); }
catch (e) { console.error('⚠️  baseline import failed:', e.message); }

// Collapse duplicate rows left behind by the bot API (see orderMerge.js).
// Idempotent: once merged, later startups find nothing to do.
try { OrderMerge.mergeDuplicateOrders(db); }
catch (e) { console.error('⚠️  duplicate merge failed:', e.message); }
OrderMerge.reconcileDelivered(db);

try { SkuCatalog.ensureSkuTables(db); }
catch (e) { console.error('⚠️  sku catalog setup failed:', e.message); }

// Fix orders filed under the wrong category by the old whole-email keyword
// scan (see category.js). Only orders with items are touched; idempotent.
try {
  const retailerDefault = r => (Retailers.BUILT_IN.find(p => p.name === r) || {}).category || 'Other';
  recategorizeOrders(db, retailerDefault);
} catch (e) { console.error('⚠️  recategorize failed:', e.message); }

// Seed default settings
const defaultSettings = {
  business_name: 'Your Business Name',
  business_phone: '(555) 123-4567',
  business_email: 'contact@yourbusiness.com',
  business_address: '123 Main St, Your City, State',
  business_hours: 'Mon–Fri 8am–6pm, Sat 9am–4pm',
  hero_tagline: 'Quality flooring, vanities & tools for your home projects.',
  service_area: 'Serving the local area',
};
Object.entries(defaultSettings).forEach(([key, value]) => {
  const exists = db.prepare('SELECT key FROM settings WHERE key=?').get([key]);
  if (!exists) db.prepare('INSERT INTO settings (key,value) VALUES (?,?)').run([key, value]);
});

// Seed sample products if empty
const count = db.prepare('SELECT COUNT(*) as n FROM products').get().n;
if (count === 0) {
  const samples = [
    { name: 'Pergo TimberCraft Luxury Vinyl Plank', category: 'Flooring', subcategory: 'Vinyl Plank', description: 'Waterproof luxury vinyl with realistic wood look. Great for kitchens and bathrooms.', price: 2.99, price_unit: 'sq ft', sku: 'FLR-001', source: 'Home Depot', stock: 'in_stock', featured: 1 },
    { name: 'TrafficMASTER Groutable Vinyl Tile', category: 'Flooring', subcategory: 'Vinyl Tile', description: '12x12 peel and stick vinyl tile. Easy DIY installation.', price: 1.49, price_unit: 'sq ft', sku: 'FLR-002', source: 'Home Depot', stock: 'in_stock', featured: 0 },
    { name: 'LifeProof Rigid Core Vinyl Plank', category: 'Flooring', subcategory: 'Vinyl Plank', description: '100% waterproof rigid core flooring. Scratch and dent resistant.', price: 3.49, price_unit: 'sq ft', sku: 'FLR-003', source: "Lowe's", stock: 'in_stock', featured: 1 },
    { name: 'Ceramic Floor Tile 12x12', category: 'Flooring', subcategory: 'Tile', description: 'Classic ceramic floor tile, suitable for indoor/outdoor use.', price: 0.89, price_unit: 'sq ft', sku: 'FLR-004', source: 'Home Depot', stock: 'in_stock', featured: 0 },
    { name: 'Allen + Roth 30" Bathroom Vanity', category: 'Vanity', subcategory: 'Vanity Cabinet', description: '30-inch single sink vanity with soft-close doors. White finish.', price: 379.00, price_unit: 'each', sku: 'VAN-001', source: "Lowe's", stock: 'in_stock', featured: 1 },
    { name: 'Style Selections 36" Vanity with Top', category: 'Vanity', subcategory: 'Vanity Cabinet', description: 'Single-sink vanity combo with cultured marble top. Gray finish.', price: 449.00, price_unit: 'each', sku: 'VAN-002', source: "Lowe's", stock: 'low_stock', featured: 0 },
    { name: 'Glacier Bay 24" Medicine Cabinet', category: 'Vanity', subcategory: 'Medicine Cabinet', description: 'Surface mount medicine cabinet with mirror. Adjustable shelves.', price: 89.00, price_unit: 'each', sku: 'VAN-003', source: 'Home Depot', stock: 'in_stock', featured: 0 },
    { name: 'DEWALT 20V MAX Cordless Drill', category: 'Tools', subcategory: 'Power Tools', description: '20V MAX lithium ion cordless drill/driver with 2 batteries included.', price: 149.00, price_unit: 'each', sku: 'TLS-001', source: 'Home Depot', stock: 'in_stock', featured: 1 },
    { name: 'RIDGID 7-1/4" Circular Saw', category: 'Tools', subcategory: 'Power Tools', description: '15-amp circular saw with laser guide. Ideal for flooring installs.', price: 129.00, price_unit: 'each', sku: 'TLS-002', source: 'Home Depot', stock: 'in_stock', featured: 0 },
    { name: 'Stanley 65-Piece Hand Tool Set', category: 'Tools', subcategory: 'Hand Tools', description: 'Complete home tool set in blow-molded case. Great starter kit.', price: 59.00, price_unit: 'each', sku: 'TLS-003', source: "Lowe's", stock: 'in_stock', featured: 0 },
  ];
  samples.forEach(p => {
    db.prepare(`INSERT INTO products (name,category,subcategory,description,price,price_unit,sku,source,stock,featured) VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .run([p.name, p.category, p.subcategory||null, p.description||null, p.price||null, p.price_unit||'each', p.sku||null, p.source||'Other', p.stock||'in_stock', p.featured||0]);
  });
}

// ─── AUTH MIDDLEWARE ──────────────────────────────────────────────────────────
function auth(req, res, next) {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  try { req.admin = jwt.verify(token, JWT_SECRET); next(); }
  catch(e) { res.status(401).json({ error: 'Invalid token' }); }
}

function getSettingValue(key, fallback = null) {
  try {
    const row = db.prepare('SELECT value FROM settings WHERE key=?').get([key]);
    return row ? row.value : fallback;
  } catch (_) { return fallback; }
}

function adminOnly(req, res, next) {
  // Support legacy tokens (admin:true) and new role-based tokens
  if (req.admin && (req.admin.admin === true || req.admin.role === 'admin')) return next();
  res.status(403).json({ error: 'Admin access required' });
}

// ─── PUBLIC ROUTES ────────────────────────────────────────────────────────────
app.get('/api/products', (req, res) => {
  const { category, search, stock, featured, includeOOS } = req.query;
  let sql = 'SELECT p.*, m.name as member_name FROM products p LEFT JOIN members m ON p.member_id=m.id WHERE 1=1';
  const params = [];
  if (category && category !== 'All') { sql += ' AND p.category=?'; params.push(category); }
  if (search) { sql += ' AND (p.name LIKE ? OR p.description LIKE ? OR p.subcategory LIKE ?)'; params.push(`%${search}%`, `%${search}%`, `%${search}%`); }
  if (stock) { sql += ' AND p.stock=?'; params.push(stock); }
  if (featured === '1') { sql += ' AND p.featured=1'; }

  // Hide sold-out products from the storefront. The admin passes includeOOS=1 so
  // it can still see and manage them, and an explicit stock= filter is honoured
  // so "show me only out of stock" keeps working in the admin.
  // Controlled by the hide_out_of_stock setting (default on).
  const hideOOS = getSettingValue('hide_out_of_stock', '1') === '1';
  if (hideOOS && includeOOS !== '1' && !stock) {
    sql += " AND (p.stock IS NULL OR p.stock != 'out_stock')";
  }

  sql += ' ORDER BY p.featured DESC, p.sort_order ASC, p.created_at DESC';
  res.json(db.prepare(sql).all(params));
});

app.get('/api/products/:id', (req, res) => {
  const p = db.prepare('SELECT * FROM products WHERE id=?').get([req.params.id]);
  if (!p) return res.status(404).json({ error: 'Not found' });
  res.json(p);
});

app.get('/api/settings', (req, res) => {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const obj = {};
  rows.forEach(r => { if (r.key !== 'employee_password') obj[r.key] = r.value; });
  res.json(obj);
});

app.get('/api/categories', (req, res) => {
  const cats = db.prepare("SELECT DISTINCT category FROM products ORDER BY category").all().map(r => r.category);
  res.json(['All', ...cats]);
});

// ─── ADMIN AUTH ───────────────────────────────────────────────────────────────
app.post('/api/admin/login', (req, res) => {
  const { password } = req.body;
  if (!password) return res.status(400).json({ error: 'Password required' });
  let role = null;
  if (password === ADMIN_PASSWORD) role = 'admin';
  else {
    const empPwRow = db.prepare("SELECT value FROM settings WHERE key='employee_password'").get();
    const empPw = (empPwRow && empPwRow.value) || EMPLOYEE_PASSWORD;
    if (empPw && password === empPw) role = 'employee';
  }
  if (!role) return res.status(401).json({ error: 'Wrong password' });
  const token = jwt.sign({ role }, JWT_SECRET, { expiresIn: '24h' });
  res.json({ token, role });
});

// ─── ADMIN PRODUCT ROUTES ─────────────────────────────────────────────────────
app.post('/api/admin/products', auth, (req, res) => {
  const { name, category, subcategory, description, price, price_unit, sku, source, stock, images, featured, sort_order, quantity, source_url, cost_price, coverage_sqft, member_id } = req.body;
  if (!name) return res.status(400).json({ error: 'Name required' });
  const n = v => (v === undefined || v === '') ? null : v;
  const { member_qty } = req.body;
  const result = db.prepare(`INSERT INTO products (name,category,subcategory,description,price,price_unit,sku,source,stock,images,featured,sort_order,quantity,source_url,cost_price,coverage_sqft,member_id,member_qty) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run([name, category||'Other', n(subcategory), n(description), n(price), price_unit||'each', n(sku), source||'Other', stock||'in_stock', JSON.stringify(images||[]), featured?1:0, sort_order||0, parseInt(quantity)||0, n(source_url), n(cost_price), n(coverage_sqft), n(member_id), parseInt(member_qty)||0]);
  res.json({ id: result.lastInsertRowid });
});

app.put('/api/admin/products/:id', auth, (req, res) => {
  const { name, category, subcategory, description, price, price_unit, sku, source, stock, images, featured, sort_order, quantity, source_url, cost_price, coverage_sqft, member_id, member_qty } = req.body;
  if (!name) return res.status(400).json({ error: 'Name required' });
  const n = v => (v === undefined || v === '') ? null : v;
  db.prepare(`UPDATE products SET name=?,category=?,subcategory=?,description=?,price=?,price_unit=?,sku=?,source=?,stock=?,images=?,featured=?,sort_order=?,quantity=?,source_url=?,cost_price=?,coverage_sqft=?,member_id=?,member_qty=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`)
    .run([name, category||'Other', n(subcategory), n(description), n(price), price_unit||'each', n(sku), source||'Other', stock||'in_stock', JSON.stringify(images||[]), featured?1:0, sort_order||0, parseInt(quantity)||0, n(source_url), n(cost_price), n(coverage_sqft), n(member_id), parseInt(member_qty)||0, req.params.id]);
  res.json({ success: true });
});

app.delete('/api/admin/products/:id', auth, (req, res) => {
  db.prepare('DELETE FROM products WHERE id=?').run([req.params.id]);
  res.json({ success: true });
});

app.post('/api/admin/upload', auth, upload.single('image'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  res.json({ url: '/uploads/' + req.file.filename });
});

app.put('/api/admin/settings', auth, (req, res) => {
  Object.entries(req.body).forEach(([key, value]) => {
    db.prepare('INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)').run([key, String(value)]);
  });
  res.json({ success: true });
});

// ─── BOOKMARKLET IMPORT (receives data from user's real browser) ──────────────
let pendingImport = null;

// Preflight for Private Network Access (Chrome 94+ requirement)
app.options('/api/import-from-page', (req, res) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Private-Network', 'true');
  res.header('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  res.sendStatus(204);
});

app.post('/api/import-from-page', (req, res) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Private-Network', 'true');
  pendingImport = { ...req.body, _ts: Date.now() };
  res.json({ ok: true });
});

app.get('/api/admin/pending-import', auth, (req, res) => {
  if (pendingImport && Date.now() - pendingImport._ts < 120000) {
    const data = pendingImport;
    pendingImport = null;
    return res.json(data);
  }
  res.json(null);
});

// ─── PRODUCT IMPORTER ────────────────────────────────────────────────────────
function parseProductHtml(html, source) {
  const $ = cheerio.load(html);
  const product = { source };

  // JSON-LD structured data (most reliable)
  $('script[type="application/ld+json"]').each((_, el) => {
    if (product.name) return;
    try {
      const data = JSON.parse($(el).text().trim());
      const items = Array.isArray(data) ? data : (data['@graph'] || [data]);
      for (const item of items) {
        if (item['@type'] !== 'Product') continue;
        product.name = (item.name || '').replace(/\s+/g, ' ').trim();
        if (item.description) product.description = item.description.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
        const offer = item.offers ? (Array.isArray(item.offers) ? item.offers[0] : item.offers) : null;
        if (offer && offer.price) product.price = parseFloat(offer.price);
        if (item.image) {
          const imgs = Array.isArray(item.image) ? item.image : [item.image];
          product.images = imgs.filter(i => typeof i === 'string').slice(0, 6);
        }
      }
    } catch (e) {}
  });

  // Open Graph fallbacks
  if (!product.name) product.name = ($('meta[property="og:title"]').attr('content') || $('h1').first().text() || '').replace(/\s+/g, ' ').trim();
  if (!product.description) product.description = ($('meta[property="og:description"]').attr('content') || $('meta[name="description"]').attr('content') || '').replace(/\s+/g, ' ').trim();
  if (!product.images || !product.images.length) {
    const og = $('meta[property="og:image"]').attr('content');
    if (og) product.images = [og];
  }

  // Price fallback from page text
  if (!product.price) {
    const priceText = $('[class*="price"],[class*="Price"],[data-testid*="price"]').first().text().trim();
    const match = priceText.match(/\$?([\d,]+\.?\d{0,2})/);
    if (match) product.price = parseFloat(match[1].replace(',', ''));
  }

  // Category from breadcrumbs
  const crumbs = [];
  $('[class*="breadcrumb"] a, nav[aria-label*="read"] a, [aria-label*="breadcrumb"] a').each((_, el) => {
    const t = $(el).text().trim();
    if (t && t.toLowerCase() !== 'home') crumbs.push(t);
  });
  if (crumbs.length) {
    const bc = crumbs.join(' ').toLowerCase();
    if (/floor|tile|hardwood|laminate|vinyl plank|carpet/.test(bc)) product.category = 'Flooring';
    else if (/vanit|bath|medicine cabinet|sink/.test(bc)) product.category = 'Vanity';
    else if (/tool|drill|saw|hardware|fastener/.test(bc)) product.category = 'Tools';
    else product.category = 'Other';
  }

  return product;
}

app.post('/api/admin/fetch-product', auth, async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'URL required' });

  let source = 'Other';
  if (url.includes('homedepot.com')) source = 'Home Depot';
  else if (url.includes('lowes.com')) source = "Lowe's";

  const chromePath = findChrome();
  if (!chromePath) {
    return res.status(500).json({ error: 'Google Chrome not found. Please install Chrome and try again.' });
  }

  let browser;
  try {
    browser = await puppeteer.launch({
      executablePath: chromePath,
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-blink-features=AutomationControlled'],
    });
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');
    await page.evaluateOnNewDocument(() => { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }); });
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 25000 });
    // Wait for product title to appear in DOM
    await page.waitForSelector('h1', { timeout: 8000 }).catch(() => {});
    await new Promise(r => setTimeout(r, 1500));

    // Extract directly from live rendered DOM
    const product = await page.evaluate((source) => {
      const d = { source };

      // JSON-LD structured data
      for (const el of document.querySelectorAll('script[type="application/ld+json"]')) {
        if (d.name) break;
        try {
          const json = JSON.parse(el.textContent);
          const items = Array.isArray(json) ? json : (json['@graph'] || [json]);
          for (const item of items) {
            if (item['@type'] !== 'Product') continue;
            d.name = (item.name || '').replace(/\s+/g, ' ').trim();
            if (item.description) d.description = item.description.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
            const offer = item.offers ? (Array.isArray(item.offers) ? item.offers[0] : item.offers) : null;
            if (offer && offer.price) d.price = parseFloat(offer.price);
            if (item.image) {
              const imgs = Array.isArray(item.image) ? item.image : [item.image];
              d.images = imgs.filter(i => typeof i === 'string').slice(0, 6);
            }
          }
        } catch(e) {}
      }

      // H1 title fallback
      if (!d.name) {
        const h1 = document.querySelector('h1[class*="title"], h1[class*="product"], h1[class*="name"], h1');
        if (h1) d.name = h1.textContent.replace(/\s+/g, ' ').trim();
      }

      // OG meta fallbacks
      if (!d.name) {
        const og = document.querySelector('meta[property="og:title"]');
        if (og) d.name = og.content.split('|')[0].trim();
      }
      if (!d.description) {
        const og = document.querySelector('meta[property="og:description"]') || document.querySelector('meta[name="description"]');
        if (og) d.description = og.content;
      }
      if (!d.images || !d.images.length) {
        const og = document.querySelector('meta[property="og:image"]');
        if (og) d.images = [og.content];
      }

      // Price fallback from visible DOM
      if (!d.price) {
        const sel = '[class*="price__value"],[class*="Price__value"],[data-testid*="price"],[class*="pip-price"],[class*="ProductPrice"],[itemprop="price"]';
        const el = document.querySelector(sel);
        if (el) {
          const m = (el.getAttribute('content') || el.textContent).match(/([\d,]+\.?\d{0,2})/);
          if (m) d.price = parseFloat(m[1].replace(',', ''));
        }
      }

      // Images from gallery if still missing
      if (!d.images || !d.images.length) {
        const imgs = [...document.querySelectorAll('[class*="gallery"] img,[class*="media"] img,[class*="carousel"] img,[class*="MediaGallery"] img')]
          .map(i => i.src || i.getAttribute('data-src'))
          .filter(s => s && s.startsWith('http') && !s.includes('placeholder') && !s.includes('data:'))
          .slice(0, 6);
        if (imgs.length) d.images = imgs;
      }

      // Category from breadcrumbs
      const crumbs = [...document.querySelectorAll('[class*="breadcrumb"] a,[aria-label*="breadcrumb"] a,nav[aria-label*="read"] a')]
        .map(a => a.textContent.trim()).filter(t => t && !/^home$/i.test(t));
      if (crumbs.length) {
        const bc = crumbs.join(' ').toLowerCase();
        if (/floor|tile|hardwood|laminate|vinyl plank|carpet/.test(bc)) d.category = 'Flooring';
        else if (/vanit|bath|medicine cabinet|sink/.test(bc)) d.category = 'Vanity';
        else if (/tool|drill|saw|hardware|fastener/.test(bc)) d.category = 'Tools';
        else d.category = 'Other';
      }

      return d;
    }, source);

    if (!product.name) return res.status(422).json({ error: 'Could not extract product info from this page.' });
    res.json(product);
  } catch (e) {
    res.status(500).json({ error: 'Import failed: ' + e.message });
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
});

// ─── SALES ───────────────────────────────────────────────────────────────────
// Aggregate by product (for top-seller badge and per-SKU stats)
app.get('/api/admin/sales/by-product', auth, (req, res) => {
  const rows = db.prepare(`
    SELECT product_id,
      COALESCE(SUM(quantity_sold),0)           as units_sold,
      COALESCE(SUM(sale_price*quantity_sold),0) as revenue,
      COALESCE(SUM(cost_price*quantity_sold),0) as cogs,
      COALESCE(SUM(profit),0)                  as profit,
      COUNT(*)                                  as transactions
    FROM sales WHERE product_id IS NOT NULL GROUP BY product_id
  `).all();
  const map = {};
  rows.forEach(r => { map[r.product_id] = r; });
  res.json(map);
});

// Per-product mini P&L + full history
app.get('/api/admin/products/:id/pl', auth, (req, res) => {
  const pid = req.params.id;
  const sales    = db.prepare('SELECT * FROM sales WHERE product_id=? ORDER BY sold_at DESC').all([pid]);
  const restocks = db.prepare('SELECT * FROM restocks WHERE product_id=? ORDER BY restocked_at DESC').all([pid]);
  const summary  = db.prepare(`
    SELECT COALESCE(SUM(quantity_sold),0)            as units_sold,
           COALESCE(SUM(sale_price*quantity_sold),0)  as revenue,
           COALESCE(SUM(cost_price*quantity_sold),0)  as cogs,
           COALESCE(SUM(profit),0)                    as gross_profit,
           COUNT(*)                                    as transactions
    FROM sales WHERE product_id=?
  `).get([pid]);
  const prod = db.prepare('SELECT quantity, cost_price FROM products WHERE id=?').get([pid]);
  const inventory_value = prod ? (prod.quantity||0)*(prod.cost_price||0) : 0;
  const margin_pct = summary.total_cost > 0 ? (summary.gross_profit / summary.total_cost * 100) : 0;
  res.json({ sales, restocks, summary: { ...summary, inventory_value, margin_pct } });
});

// All sales
app.get('/api/admin/sales', auth, (req, res) => {
  const { product_id } = req.query;
  if (product_id) {
    res.json(db.prepare('SELECT * FROM sales WHERE product_id=? ORDER BY sold_at DESC').all([product_id]));
  } else {
    res.json(db.prepare('SELECT * FROM sales ORDER BY sold_at DESC').all());
  }
});

// Record a sale — auto-reduces stock, returns sold_out flag
app.post('/api/admin/sales', auth, adminOnly, (req, res) => {
  const { product_id, product_name, quantity_sold, sale_price, cost_price, notes, payment_method, sold_at } = req.body;
  if (!product_name || !quantity_sold || sale_price == null) return res.status(400).json({ error: 'Missing required fields' });
  const qty = parseInt(quantity_sold) || 1;
  const sp  = parseFloat(sale_price)  || 0;
  const cp  = parseFloat(cost_price)  || 0;
  const profit = (sp - cp) * qty;
  // Determine owner-first depletion: sell owner units first, member units last
  let member_id = null;
  let member_qty_sold = 0;
  if (product_id) {
    const prod = db.prepare('SELECT member_id, member_qty, quantity FROM products WHERE id=?').get([product_id]);
    if (prod && prod.member_id) {
      member_id = prod.member_id;
      const totalQty = prod.quantity || 0;
      const memberQty = prod.member_qty || 0;
      const ownerQty = Math.max(0, totalQty - memberQty);
      // Deplete owner units first, then member units
      const ownerSold = Math.min(qty, ownerQty);
      member_qty_sold = Math.max(0, qty - ownerSold);
    }
  }
  const vals = [product_id||null, product_name, qty, sp, cp, profit, notes||null, payment_method||null, member_id, member_qty_sold];
  let result;
  if (sold_at) {
    result = db.prepare('INSERT INTO sales (product_id,product_name,quantity_sold,sale_price,cost_price,profit,notes,payment_method,member_id,member_qty_sold,sold_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)').run([...vals, sold_at]);
  } else {
    result = db.prepare('INSERT INTO sales (product_id,product_name,quantity_sold,sale_price,cost_price,profit,notes,payment_method,member_id,member_qty_sold) VALUES (?,?,?,?,?,?,?,?,?,?)').run(vals);
  }
  let sold_out = false;
  if (product_id) {
    const prod = db.prepare('SELECT quantity, member_qty FROM products WHERE id=?').get([product_id]);
    if (prod) {
      const newQty = Math.max(0, (prod.quantity||0) - qty);
      const newMemberQty = Math.max(0, (prod.member_qty||0) - member_qty_sold);
      const newStock = newQty === 0 ? 'out_stock' : newQty <= 5 ? 'low_stock' : 'in_stock';
      db.prepare('UPDATE products SET quantity=?,member_qty=?,stock=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run([newQty, newMemberQty, newStock, product_id]);
      sold_out = newQty === 0;
    }
  }
  res.json({ id: result.lastInsertRowid, sold_out });
});

app.put('/api/admin/sales/:id', auth, adminOnly, (req, res) => {
  const { sale_price, payment_method, notes } = req.body;
  const sale = db.prepare('SELECT * FROM sales WHERE id=?').get([req.params.id]);
  if (!sale) return res.status(404).json({ error: 'Not found' });
  const newPrice = parseFloat(sale_price) || sale.sale_price;
  const profit = newPrice - (sale.cost_price || 0) * sale.quantity_sold;
  db.prepare('UPDATE sales SET sale_price=?, profit=?, payment_method=?, notes=? WHERE id=?')
    .run([newPrice, profit, payment_method || sale.payment_method, notes ?? sale.notes, req.params.id]);
  res.json({ success: true });
});

app.delete('/api/admin/sales/:id', auth, adminOnly, (req, res) => {
  const sale = db.prepare('SELECT * FROM sales WHERE id=?').get([req.params.id]);
  if (!sale) return res.status(404).json({ error: 'Sale not found' });
  if (sale.product_id) {
    const prod = db.prepare('SELECT quantity, member_qty FROM products WHERE id=?').get([sale.product_id]);
    if (prod) {
      const newQty = (prod.quantity || 0) + (sale.quantity_sold || 0);
      const newMemberQty = Math.min(newQty, (prod.member_qty || 0) + (sale.member_qty_sold || 0));
      const newStock = newQty === 0 ? 'out_stock' : newQty <= 5 ? 'low_stock' : 'in_stock';
      db.prepare('UPDATE products SET quantity=?,member_qty=?,stock=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run([newQty, newMemberQty, newStock, sale.product_id]);
    }
  }
  db.prepare('DELETE FROM sales WHERE id=?').run([req.params.id]);
  res.json({ success: true });
});

// ─── RESTOCKS ────────────────────────────────────────────────────────────────
app.get('/api/admin/restocks/:productId', auth, (req, res) => {
  res.json(db.prepare('SELECT * FROM restocks WHERE product_id=? ORDER BY restocked_at DESC').all([req.params.productId]));
});

app.post('/api/admin/restocks', auth, (req, res) => {
  const { product_id, product_name, quantity_added, cost_per_unit, notes, restocked_at, member_id, member_qty } = req.body;
  if (!product_id || !quantity_added) return res.status(400).json({ error: 'Missing fields' });
  const qty = parseInt(quantity_added) || 0;
  const cpu = parseFloat(cost_per_unit) || null;
  const mId = member_id ? parseInt(member_id) : null;
  const mQty = Math.min(parseInt(member_qty)||0, qty); // member qty can't exceed total
  const vals = [product_id, product_name||'', qty, cpu, notes||null, mId, mQty];
  let result;
  if (restocked_at) {
    result = db.prepare('INSERT INTO restocks (product_id,product_name,quantity_added,cost_per_unit,notes,member_id,member_qty,restocked_at) VALUES (?,?,?,?,?,?,?,?)').run([...vals, restocked_at]);
  } else {
    result = db.prepare('INSERT INTO restocks (product_id,product_name,quantity_added,cost_per_unit,notes,member_id,member_qty) VALUES (?,?,?,?,?,?,?)').run(vals);
  }
  const prod = db.prepare('SELECT quantity, cost_price, member_id, member_qty FROM products WHERE id=?').get([product_id]);
  if (prod) {
    const oldQty = prod.quantity || 0;
    const newQty = oldQty + qty;
    const newMemberQty = (prod.member_qty || 0) + mQty;
    const newStock = newQty > 5 ? 'in_stock' : newQty > 0 ? 'low_stock' : 'out_stock';
    // If product has no member yet and this restock has one, set it
    const newMemberId = prod.member_id || mId || null;
    if (cpu) {
      const avgCost = (oldQty > 0 && prod.cost_price)
        ? ((oldQty * prod.cost_price) + (qty * cpu)) / newQty
        : cpu;
      db.prepare('UPDATE products SET quantity=?,member_qty=?,member_id=?,stock=?,cost_price=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run([newQty, newMemberQty, newMemberId, newStock, avgCost, product_id]);
    } else {
      db.prepare('UPDATE products SET quantity=?,member_qty=?,member_id=?,stock=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run([newQty, newMemberQty, newMemberId, newStock, product_id]);
    }
  }
  res.json({ id: result.lastInsertRowid });
});

// ─── EXPENSES ────────────────────────────────────────────────────────────────
app.get('/api/admin/expenses', auth, (req, res) => {
  const { from, to } = req.query;
  let sql = 'SELECT * FROM expenses WHERE 1=1';
  const params = [];
  if (from) { sql += ' AND expense_date >= ?'; params.push(from); }
  if (to)   { sql += ' AND expense_date <= ?'; params.push(to); }
  sql += ' ORDER BY expense_date DESC, id DESC';
  res.json(db.prepare(sql).all(params));
});

app.post('/api/admin/expenses', auth, (req, res) => {
  const { category, amount, payment_method, notes, expense_date } = req.body;
  if (!amount) return res.status(400).json({ error: 'Amount required' });
  const vals = [category||'Other', parseFloat(amount)||0, payment_method||'Cash', notes||null];
  let result;
  if (expense_date) {
    result = db.prepare('INSERT INTO expenses (category,amount,payment_method,notes,expense_date) VALUES (?,?,?,?,?)').run([...vals, expense_date]);
  } else {
    result = db.prepare('INSERT INTO expenses (category,amount,payment_method,notes) VALUES (?,?,?,?)').run(vals);
  }
  res.json({ id: result.lastInsertRowid });
});

app.delete('/api/admin/expenses/:id', auth, (req, res) => {
  db.prepare('DELETE FROM expenses WHERE id=?').run([req.params.id]);
  res.json({ success: true });
});

// ─── P&L ─────────────────────────────────────────────────────────────────────
app.get('/api/admin/pl', auth, (req, res) => {
  const { from, to } = req.query;
  const sf = [], sp = [], ef = [], ep = [];
  if (from) { sf.push('date(sold_at)>=?'); sp.push(from); ef.push('expense_date>=?'); ep.push(from); }
  if (to)   { sf.push('date(sold_at)<=?'); sp.push(to);   ef.push('expense_date<=?'); ep.push(to); }
  const sw = sf.length ? 'WHERE '+sf.join(' AND ') : '';
  const ew = ef.length ? 'WHERE '+ef.join(' AND ') : '';
  // Split COGS: mine vs member-funded using member_qty_sold for accuracy
  const s         = db.prepare(`SELECT COALESCE(SUM(sale_price*quantity_sold),0) as revenue, COALESCE(SUM(cost_price*quantity_sold),0) as total_cogs, COALESCE(SUM(profit),0) as gross_profit, COUNT(*) as transactions FROM sales ${sw}`).get(sp);
  const s_split   = db.prepare(`SELECT COALESCE(SUM(cost_price*COALESCE(member_qty_sold,0)),0) as member_cogs FROM sales ${sw}`).get(sp);
  const member_cogs = s_split.member_cogs;
  const my_cogs   = s.total_cogs - member_cogs;
  const my_gross_profit = s.revenue - my_cogs;
  const e         = db.prepare(`SELECT COALESCE(SUM(amount),0) as total FROM expenses ${ew}`).get(ep);
  const eCat      = db.prepare(`SELECT category, COALESCE(SUM(amount),0) as total FROM expenses ${ew} GROUP BY category ORDER BY total DESC`).all(ep);
  // Inventory: my cost vs member cost (based on member_qty)
  const inv       = db.prepare('SELECT COALESCE(SUM((quantity-COALESCE(member_qty,0))*COALESCE(cost_price,0)),0) as value FROM products WHERE quantity>0').get();
  const inv_all   = db.prepare('SELECT COALESCE(SUM(quantity*COALESCE(cost_price,0)),0) as value FROM products WHERE quantity>0').get();
  const allTimeMyCogs = db.prepare('SELECT COALESCE(SUM(cost_price*(quantity_sold-COALESCE(member_qty_sold,0))),0) as total FROM sales').get();
  const total_invested = allTimeMyCogs.total + inv.value;
  const top       = db.prepare(`SELECT product_name, SUM(quantity_sold) as units, SUM(sale_price*quantity_sold) as revenue, SUM(profit) as profit FROM sales ${sw} GROUP BY product_id,product_name ORDER BY revenue DESC LIMIT 5`).all(sp);
  // Build WHERE clause using s.* prefix for the JOIN query
  const rsf = [];
  if (from) rsf.push(`date(s.sold_at)>=?`);
  if (to)   rsf.push(`date(s.sold_at)<=?`);
  const rsw = rsf.length ? 'WHERE ' + rsf.join(' AND ') : '';
  const recentSales = db.prepare(`SELECT s.id, s.product_name, s.quantity_sold, s.sale_price, s.profit, s.payment_method, s.notes, s.sold_at, s.member_id, m.name as member_name FROM sales s LEFT JOIN members m ON s.member_id=m.id ${rsw} ORDER BY s.sold_at DESC LIMIT 200`).all(sp);
  res.json({ revenue: s.revenue, cogs: my_cogs, member_cogs, gross_profit: my_gross_profit, transactions: s.transactions, total_expenses: e.total, net_profit: my_gross_profit - e.total, inventory_value: inv.value, inventory_value_all: inv_all.value, total_invested, expense_breakdown: eCat, top_products: top, recent_sales: recentSales });
});

// ─── MEMBERS ─────────────────────────────────────────────────────────────────
app.get('/api/admin/members', auth, (req, res) => {
  const members = db.prepare('SELECT * FROM members ORDER BY name').all();
  // For each member, attach stats
  const result = members.map(m => {
    // Stock value = member's portion of current inventory (member_qty * cost_price)
    const stock   = db.prepare('SELECT COALESCE(SUM(COALESCE(member_qty,0)*COALESCE(cost_price,0)),0) as value, COUNT(*) as products FROM products WHERE member_id=? AND quantity>0').get([m.id]);
    const allProd = db.prepare('SELECT COUNT(*) as total FROM products WHERE member_id=?').get([m.id]);
    // Sold cost = cost of member's units that were sold (member_qty_sold * cost_price)
    const sold    = db.prepare('SELECT COALESCE(SUM(cost_price*COALESCE(member_qty_sold,0)),0) as total_cost, COALESCE(SUM(sale_price*COALESCE(member_qty_sold,0)),0) as total_revenue FROM sales WHERE member_id=?').get([m.id]);
    const total_fronted = sold.total_cost + stock.value;
    const owed_back     = sold.total_cost; // cost of member's sold units — you received revenue, they need cost back
    const paid          = db.prepare('SELECT COALESCE(SUM(amount),0) as total FROM member_payments WHERE member_id=?').get([m.id]);
    const total_paid    = paid.total;
    const net_owed      = Math.max(0, owed_back - total_paid);
    return { ...m, stock_value: stock.value, active_products: stock.products, total_products: allProd.total, total_fronted, sold_cost: sold.total_cost, sold_revenue: sold.total_revenue, owed_back, total_paid, net_owed };
  });
  res.json(result);
});

app.get('/api/admin/members/:id/products', auth, (req, res) => {
  const products = db.prepare('SELECT id,name,quantity,member_qty,cost_price,price,stock FROM products WHERE member_id=? ORDER BY name').all([req.params.id]);
  res.json(products);
});

app.post('/api/admin/members', auth, adminOnly, (req, res) => {
  const { name, phone, notes } = req.body;
  if (!name) return res.status(400).json({ error: 'Name required' });
  const r = db.prepare('INSERT INTO members (name,phone,notes) VALUES (?,?,?)').run([name, phone||null, notes||null]);
  res.json({ id: r.lastInsertRowid });
});

app.put('/api/admin/members/:id', auth, adminOnly, (req, res) => {
  const { name, phone, notes } = req.body;
  if (!name) return res.status(400).json({ error: 'Name required' });
  db.prepare('UPDATE members SET name=?,phone=?,notes=? WHERE id=?').run([name, phone||null, notes||null, req.params.id]);
  res.json({ success: true });
});

app.delete('/api/admin/members/:id', auth, adminOnly, (req, res) => {
  // Unlink their products before deleting
  db.prepare('UPDATE products SET member_id=NULL WHERE member_id=?').run([req.params.id]);
  db.prepare('DELETE FROM members WHERE id=?').run([req.params.id]);
  res.json({ success: true });
});

// ─── MEMBER PAYMENTS ─────────────────────────────────────────────────────────
app.get('/api/admin/members/:id/payments', auth, adminOnly, (req, res) => {
  res.json(db.prepare('SELECT * FROM member_payments WHERE member_id=? ORDER BY paid_at DESC').all([req.params.id]));
});

app.post('/api/admin/members/:id/payments', auth, adminOnly, (req, res) => {
  const { amount, notes } = req.body;
  if (!amount) return res.status(400).json({ error: 'Amount required' });
  const r = db.prepare('INSERT INTO member_payments (member_id,amount,notes) VALUES (?,?,?)').run([req.params.id, parseFloat(amount)||0, notes||null]);
  res.json({ id: r.lastInsertRowid });
});

app.delete('/api/admin/member-payments/:id', auth, adminOnly, (req, res) => {
  db.prepare('DELETE FROM member_payments WHERE id=?').run([req.params.id]);
  res.json({ success: true });
});

// ─── BOT ORDERS ──────────────────────────────────────────────────────────────
const BOT_API_KEY = process.env.BOT_API_KEY || 'bot-ss-2026';

// GET pending orders so the bot can check for status updates
app.get('/api/bot/orders', (req, res) => {
  const key = req.headers['x-bot-key'];
  if (key !== BOT_API_KEY) return res.status(401).json({ error: 'Unauthorized' });
  const pending = db.prepare("SELECT id,order_number,retailer,status,order_date FROM bot_orders WHERE status NOT IN ('Delivered','Cancelled','Refunded') ORDER BY order_date DESC").all();
  res.json(pending);
});

// Update a single order status via bot key
app.patch('/api/bot/orders/:id', (req, res) => {
  const key = req.headers['x-bot-key'];
  if (key !== BOT_API_KEY) return res.status(401).json({ error: 'Unauthorized' });
  const { status, delivered_date, notes, tracking } = req.body;
  db.prepare('UPDATE bot_orders SET status=COALESCE(?,status), delivered_date=COALESCE(?,delivered_date), notes=COALESCE(?,notes), tracking=COALESCE(?,tracking) WHERE id=?')
    .run([status||null, delivered_date||null, notes||null, tracking||null, req.params.id]);
  res.json({ success: true });
});

app.post('/api/bot/orders', (req, res) => {
  const key = req.headers['x-bot-key'];
  if (key !== BOT_API_KEY) return res.status(401).json({ error: 'Unauthorized' });
  const orders = req.body.orders || [];
  let inserted = 0, merged = 0;
  for (const o of orders) {
    try {
      // If the email scraper already has this order, fill in what the bot
      // knows (buyer, account, address) instead of inserting a second row.
      // INSERT OR IGNORE never prevented this: order_number isn't unique.
      const existing = OrderMerge.findExisting(db, o.order_number, o.retailer);
      if (existing) {
        OrderMerge.fillExisting(db, existing, {
          ...o,
          items: o.items && o.items.length ? JSON.stringify(o.items) : null,
        });
        merged++;
        continue;
      }
      db.prepare(`INSERT INTO bot_orders
        (email_id,subject,from_email,category,retailer,order_number,account_email,order_date,delivered_date,shipping_name,shipping_address,status,items,order_total,refunded_amount,notes,raw_snippet,received_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run([o.email_id||null,o.subject||null,o.from_email||null,o.category||'Other',o.retailer||null,o.order_number||null,o.account_email||null,o.order_date||null,o.delivered_date||null,o.shipping_name||null,o.shipping_address||null,o.status||'Confirmed',JSON.stringify(o.items||[]),o.order_total||0,o.refunded_amount||0,o.notes||null,o.raw_snippet||null,o.received_at||null]);
      inserted++;
    } catch(e) {}
  }
  res.json({ inserted, merged });
});

// ── Item view endpoint: expand orders → per-item rows, merge by SKU+cost ───────
// Category filter shared by the product and package views. "All" = every
// category. "Other" also takes orders with no category, since the tabs count
// those as Other — otherwise the tab said 7 and the list showed fewer.
function botCategoryWhere(category) {
  if (category === 'All')   return ['1=1', []];
  if (category === 'Other') return ["(category='Other' OR category IS NULL OR category='')", []];
  return ['category=?', [category]];
}

// ── Pick-up check-ins and claims ─────────────────────────────────────────────
// Stock counts units you've picked up and checked, not what the carrier says.
function loadStock() {
  const checkedIn = new Map();
  let issues = [];
  try { db.prepare('SELECT order_id, checked_at FROM bot_checkins').all().forEach(r => checkedIn.set(r.order_id, r.checked_at)); } catch (_) {}
  try { issues = db.prepare('SELECT * FROM bot_issues').all(); } catch (_) {}
  let adjustments = [];
  try { adjustments = db.prepare('SELECT * FROM bot_adjustments').all(); } catch (_) {}
  return { checkedIn, issues, adjustments };
}

const ISSUE_KINDS    = new Set(['missing', 'wrong', 'damaged']);
const ISSUE_STATUSES = new Set(['open', 'claim_filed', 'refunded', 'denied_keep', 'denied_writeoff']);
const ISSUE_OPEN     = new Set(['open', 'claim_filed']);

// Landed cost of one unit of this issue's item (same math as the product view).
function issueUnitCost(issue, order) {
  if (!order) return 0;
  const line = orderLineCosts(order).find(l => itemKey(l.rawName) === issue.item_key);
  return line ? line.unitTotal : 0;
}

// All products with their current stock, across every category and status —
// what the In stock view and a stock count work from.
function currentStockGroups() {
  const orders = db.prepare("SELECT * FROM bot_orders WHERE status NOT IN ('Cancelled','Refunded')").all();
  let pricingRows = [], salesRows = [];
  try { pricingRows = db.prepare('SELECT * FROM bot_sku_prices').all(); } catch (_) {}
  try { salesRows = db.prepare('SELECT * FROM bot_sales').all(); } catch (_) {}
  return computeItemGroups(withMainAddress(orders, { replace: true }), pricingRows, SkuCatalog.loadCatalog(db), salesRows, loadStock());
}

// Save a stock count. The expected number is worked out HERE, not trusted from
// the page (a sale may have been recorded since the page loaded). Only
// differences are stored; a count that matches changes nothing.
app.post('/api/admin/bot-stock-count', auth, adminOnly, (req, res) => {
  const { counts, date, note } = req.body || {};
  const day = date || new Date().toISOString().slice(0, 10);
  if (!Array.isArray(counts) || !counts.length) return res.status(400).json({ error: 'counts required' });
  if (!isIsoDate(day)) return res.status(400).json({ error: 'date must be YYYY-MM-DD' });
  for (const c of counts) {
    const n = Number(c && c.counted);
    if (!c || !c.sku_key || !Number.isInteger(n) || n < 0) return res.status(400).json({ error: 'Each count needs a product and a whole number of 0 or more' });
  }
  const groups = currentStockGroups();
  const out = [];
  for (const c of counts) {
    const g = groups.find(x => x.skuKey === c.sku_key);
    if (!g) return res.status(404).json({ error: `Unknown product ${c.sku_key}` });
    const diff = Number(c.counted) - g.unitsLeft;
    if (!diff) { out.push({ sku_key: g.skuKey, name: g.name, expected: g.unitsLeft, counted: Number(c.counted), diff: 0 }); continue; }
    db.prepare(`INSERT INTO bot_adjustments (sku_key, product_name, qty, unit_cost, reason, note, counted_at)
                VALUES (?,?,?,?, 'count', ?, ?)`).run([g.skuKey, g.name, diff, g.perUnitTotal, (note || '').trim() || null, day]);
    out.push({ sku_key: g.skuKey, name: g.name, expected: g.unitsLeft, counted: Number(c.counted), diff });
  }
  res.json({ saved: out.filter(x => x.diff).length, results: out });
});

app.get('/api/admin/bot-stock-count', auth, adminOnly, (req, res) => {
  let rows = [];
  try { rows = db.prepare('SELECT * FROM bot_adjustments ORDER BY counted_at DESC, id DESC LIMIT 200').all(); } catch (_) {}
  res.json(rows);
});

// Undo one correction (typed a count wrong).
app.delete('/api/admin/bot-stock-count/:id', auth, adminOnly, (req, res) => {
  db.prepare('DELETE FROM bot_adjustments WHERE id=?').run([Number(req.params.id)]);
  res.json({ ok: true });
});

// ── Partners ────────────────────────────────────────────────────────────────
// Save a partner (create, or update with id) with his per-retailer lists:
// profiles: [{ retailer, emails, names }] — emails / names comma or line
// separated. Each list needs a retailer and at least one email. Tabs (spend,
// stock, sales, owed) come with /bot-money.
app.post('/api/admin/bot-partners', auth, adminOnly, (req, res) => {
  const b = req.body || {};
  const name = String(b.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Name required' });
  const clean = s => String(s || '').split(/[,;\n]/).map(x => x.trim()).filter(Boolean).join(', ');
  const profiles = (Array.isArray(b.profiles) ? b.profiles : [])
    .map(p => ({ retailer: String(p.retailer || '').trim(), emails: clean(p.emails), names: clean(p.names) }))
    .filter(p => p.retailer || p.emails || p.names);
  if (!profiles.length) return res.status(400).json({ error: 'Add at least one retailer with his account emails' });
  if (profiles.some(p => !p.retailer)) return res.status(400).json({ error: 'Pick the retailer for each list' });
  if (profiles.some(p => !p.emails))   return res.status(400).json({ error: 'Each retailer needs at least one of his account emails' });
  let id = Number(b.id) || 0;
  if (id) db.prepare("UPDATE bot_partners SET name=?, note=?, emails='', names='' WHERE id=?").run([name, String(b.note || ''), id]);
  else    id = Number(db.prepare("INSERT INTO bot_partners (name, emails, names, note) VALUES (?,'','',?)").run([name, String(b.note || '')]).lastInsertRowid);
  db.prepare('DELETE FROM bot_partner_profiles WHERE partner_id=?').run([id]);
  for (const p of profiles) {
    db.prepare('INSERT INTO bot_partner_profiles (partner_id, retailer, emails, names) VALUES (?,?,?,?)').run([id, p.retailer, p.emails, p.names]);
  }
  res.json({ id });
});
app.delete('/api/admin/bot-partners/:id', auth, adminOnly, (req, res) => {
  const id = Number(req.params.id);
  db.prepare('DELETE FROM bot_partners WHERE id=?').run([id]);
  db.prepare('DELETE FROM bot_partner_profiles WHERE partner_id=?').run([id]);
  db.prepare('UPDATE bot_orders SET partner_override=NULL WHERE partner_override=?').run([id]);
  res.json({ ok: true });
});
app.post('/api/admin/bot-partners/:id/payouts', auth, adminOnly, (req, res) => {
  const amount = Number((req.body || {}).amount);
  const day = (req.body || {}).paid_at || new Date().toISOString().slice(0, 10);
  if (!Number.isFinite(amount) || amount <= 0) return res.status(400).json({ error: 'Amount must be more than 0' });
  if (!isIsoDate(day)) return res.status(400).json({ error: 'Date must be YYYY-MM-DD' });
  db.prepare('INSERT INTO bot_partner_payouts (partner_id, amount, paid_at, note) VALUES (?,?,?,?)')
    .run([Number(req.params.id), Math.round(amount * 100) / 100, day, String((req.body || {}).note || '').trim() || null]);
  res.json({ ok: true });
});
app.delete('/api/admin/bot-partner-payouts/:id', auth, adminOnly, (req, res) => {
  db.prepare('DELETE FROM bot_partner_payouts WHERE id=?').run([Number(req.params.id)]);
  res.json({ ok: true });
});
// Whose order: null = match automatically, 0 = mine, or a partner id.
app.put('/api/admin/bot-orders/:id/owner', auth, adminOnly, (req, res) => {
  const v = (req.body || {}).partner_id;
  const val = v === null || v === undefined || v === '' ? null : Number(v);
  if (val !== null && !Number.isInteger(val)) return res.status(400).json({ error: 'bad partner' });
  db.prepare('UPDATE bot_orders SET partner_override=? WHERE id=?').run([val, Number(req.params.id)]);
  res.json({ ok: true });
});

// ── House owners ────────────────────────────────────────────────────────────
// List (with how many orders go to each place), bulk import (pasted from a
// sheet: name + address), and set/clear one.
app.get('/api/admin/bot-address-owners', auth, adminOnly, (req, res) => {
  const counts = new Map();
  try {
    db.prepare("SELECT shipping_address FROM bot_orders WHERE shipping_address IS NOT NULL AND shipping_address<>''").all()
      .forEach(r => { const k = addressKey(r.shipping_address); if (k) counts.set(k, (counts.get(k) || 0) + 1); });
  } catch (_) {}
  const book = addressBook();
  let rows = [];
  try { rows = db.prepare('SELECT * FROM bot_address_owners ORDER BY owner').all(); } catch (_) {}
  res.json(rows.map(r => ({ ...r, main_address: book.main(r.address) || r.address, orders: counts.get(r.addr_key) || 0 })));
});

function saveOwner(owner, address) {
  const k = addressKey(address);
  if (!k) return false;
  const name = String(owner || '').trim();
  if (!name) { db.prepare('DELETE FROM bot_address_owners WHERE addr_key=?').run([k]); return true; }
  db.prepare(`INSERT INTO bot_address_owners (addr_key, owner, address, updated_at) VALUES (?,?,?,CURRENT_TIMESTAMP)
              ON CONFLICT(addr_key) DO UPDATE SET owner=excluded.owner, address=excluded.address, updated_at=CURRENT_TIMESTAMP`)
    .run([k, name.slice(0, 80), String(address).trim().slice(0, 200)]);
  return true;
}

// rows: [{ owner, address }]  (address = street, city, state zip — any order the page joined)
app.post('/api/admin/bot-address-owners', auth, adminOnly, (req, res) => {
  const rows = Array.isArray(req.body && req.body.rows) ? req.body.rows : [];
  if (!rows.length) return res.status(400).json({ error: 'rows required' });
  const skipped = [];
  let saved = 0;
  for (const r of rows) {
    if (!r || !String(r.owner || '').trim() || !parseAddress(r.address)) { skipped.push(r && r.address || ''); continue; }
    if (saveOwner(r.owner, r.address)) saved++; else skipped.push(r.address);
  }
  res.json({ saved, skipped });
});

// One address: set the owner, or clear it with an empty name.
app.put('/api/admin/bot-address-owners', auth, adminOnly, (req, res) => {
  const { address, owner } = req.body || {};
  if (!address || !addressKey(address)) return res.status(400).json({ error: 'A street address is required' });
  saveOwner(owner, address);
  res.json({ ok: true });
});

// Picked up (and opened) these orders. `issues` lists anything not as ordered.
app.post('/api/admin/bot-checkin', auth, adminOnly, (req, res) => {
  const { orderIds, date, issues } = req.body || {};
  const ids = [...new Set((Array.isArray(orderIds) ? orderIds : []).map(Number).filter(n => Number.isInteger(n) && n > 0))];
  const day = date || new Date().toISOString().slice(0, 10);
  if (!ids.length)       return res.status(400).json({ error: 'orderIds required' });
  if (!isIsoDate(day))   return res.status(400).json({ error: 'date must be YYYY-MM-DD' });
  const list = Array.isArray(issues) ? issues : [];

  const orders = new Map();
  for (const id of ids) {
    const o = db.prepare('SELECT * FROM bot_orders WHERE id=?').get([id]);
    if (!o) return res.status(404).json({ error: `No order ${id}` });
    orders.set(id, o);
  }
  // Validate every issue before writing anything.
  const clean = [];
  for (const is of list) {
    const oid = Number(is && is.order_id), qty = Number(is && is.qty);
    if (!orders.has(oid))                   return res.status(400).json({ error: 'Issue for an order not in this check-in' });
    if (!ISSUE_KINDS.has(is.kind))          return res.status(400).json({ error: 'Issue kind must be missing, wrong or damaged' });
    if (!Number.isInteger(qty) || qty < 1)  return res.status(400).json({ error: 'Issue quantity must be a whole number' });
    const line = orderLineCosts(orders.get(oid)).filter(l => itemKey(l.rawName) === is.item_key);
    const have = line.reduce((s2, l) => s2 + l.qty, 0);
    if (!have)                              return res.status(400).json({ error: 'That item is not in this order' });
    if (qty > have)                         return res.status(400).json({ error: `Only ${have} of that item in the order` });
    clean.push({ oid, qty, kind: is.kind, item_key: is.item_key, item_name: is.item_name || line[0].rawName,
                 got_item: (is.got_item || '').trim() || null, note: (is.note || '').trim() || null });
  }
  for (const id of ids) {
    db.prepare('INSERT OR REPLACE INTO bot_checkins (order_id, checked_at) VALUES (?,?)').run([id, day]);
    // Checking a box in again replaces its still-open issues (a correction).
    db.prepare("DELETE FROM bot_issues WHERE order_id=? AND status='open'").run([id]);
  }
  for (const c of clean) {
    db.prepare(`INSERT INTO bot_issues (order_id, item_key, item_name, qty, kind, got_item, note, status)
                VALUES (?,?,?,?,?,?,?,'open')`).run([c.oid, c.item_key, c.item_name, c.qty, c.kind, c.got_item, c.note]);
  }
  res.json({ checkedIn: ids.length, issues: clean.length });
});

// Undo a check-in (picked the wrong box). Not once a claim has moved on.
app.delete('/api/admin/bot-checkin/:orderId', auth, adminOnly, (req, res) => {
  const id = Number(req.params.orderId);
  const moved = db.prepare("SELECT COUNT(*) n FROM bot_issues WHERE order_id=? AND status<>'open'").get([id]);
  if (moved && moved.n) return res.status(409).json({ error: 'This box has a claim in progress — resolve it in Claims first' });
  db.prepare('DELETE FROM bot_issues WHERE order_id=?').run([id]);
  db.prepare('DELETE FROM bot_checkins WHERE order_id=?').run([id]);
  res.json({ ok: true });
});

app.get('/api/admin/bot-issues', auth, adminOnly, (req, res) => {
  let rows = [];
  try { rows = db.prepare('SELECT * FROM bot_issues ORDER BY id DESC').all(); } catch (_) {}
  const catalog = SkuCatalog.loadCatalog(db);
  const out = rows.map(is => {
    const o = db.prepare('SELECT * FROM bot_orders WHERE id=?').get([is.order_id]);
    const unit = issueUnitCost(is, o);
    const pid = catalog.aliases.get(itemKey(is.item_name || ''));
    return {
      ...is,
      product: pid && catalog.products.has(pid) ? catalog.products.get(pid).name : shortenName(is.item_name || ''),
      order_number: o ? o.order_number : null, retailer: o ? o.retailer : null, tracking: o ? o.tracking : null,
      unit_cost: Math.round(unit * 100) / 100, value: Math.round(unit * is.qty * 100) / 100,
    };
  });
  // Open first, then newest.
  out.sort((a, b) => (ISSUE_OPEN.has(b.status) - ISSUE_OPEN.has(a.status)) || b.id - a.id);
  res.json(out);
});

// Move a claim along. A refund is recorded on the order (refunded_amount), so
// SPENT goes down by it; changing or undoing it adjusts by the difference.
app.patch('/api/admin/bot-issues/:id', auth, adminOnly, (req, res) => {
  const is = db.prepare('SELECT * FROM bot_issues WHERE id=?').get([Number(req.params.id)]);
  if (!is) return res.status(404).json({ error: 'No such issue' });
  const b = req.body || {};
  const status = b.status || is.status;
  if (!ISSUE_STATUSES.has(status)) return res.status(400).json({ error: 'Bad status' });
  if (status === 'denied_keep' && is.kind === 'missing') return res.status(400).json({ error: 'Nothing to keep — the item never came' });
  let refund = status === 'refunded' ? Number(b.refund_amount ?? is.refund_amount) : 0;
  if (!Number.isFinite(refund) || refund < 0) return res.status(400).json({ error: 'Refund must be a number' });
  refund = Math.round(refund * 100) / 100;
  const delta = Math.round((refund - (Number(is.refund_amount) || 0)) * 100) / 100;
  if (delta) db.prepare('UPDATE bot_orders SET refunded_amount=ROUND(COALESCE(refunded_amount,0)+?,2) WHERE id=?').run([delta, is.order_id]);
  db.prepare('UPDATE bot_issues SET status=?, refund_amount=?, note=COALESCE(?,note), resolved_at=? WHERE id=?')
    .run([status, refund, b.note ?? null, ISSUE_OPEN.has(status) ? null : new Date().toISOString().slice(0, 10), is.id]);
  res.json({ ok: true, refundDelta: delta });
});

// ── Package view: one row per tracking number (see packageView.js) ──────────
app.get('/api/admin/bot-packages', auth, adminOnly, (req, res) => {
  const { category, retailer, status } = req.query;
  if (!category) return res.status(400).json({ error: 'category required' });
  const [where, params] = botCategoryWhere(category);
  let sql = 'SELECT * FROM bot_orders WHERE ' + where;
  if (retailer) { sql += ' AND retailer=?'; params.push(retailer); }
  if (status)   { sql += ' AND status=?';   params.push(status); }
  else          { sql += " AND status NOT IN ('Cancelled','Refunded')"; }
  const catalog = SkuCatalog.loadCatalog(db);
  const orders = withMainAddress(db.prepare(sql).all(params), { replace: true });
  attachLineCosts(orders, catalog);
  res.json(computePackages(orders, catalog, loadStock()));
});

// What each item in an order really cost per unit: item + its share of tax,
// shipping and the order/box finder fee (same math as the product view), plus
// any extra per-unit fee typed for that product. Shown when an item is clicked.
function attachLineCosts(orders, catalog) {
  let pricing = new Map();
  try { db.prepare('SELECT * FROM bot_sku_prices').all().forEach(r => pricing.set(itemKey(r.sku), r)); } catch (_) {}
  const r2 = n => Math.round(n * 100) / 100;
  for (const o of orders) {
    const lines = orderLineCosts(o);
    const map = {};
    for (const l of lines) {
      const k   = itemKey(l.rawName);
      const pid = catalog.aliases.get(k);
      const pr  = (pid && pricing.get(itemKey('#p' + pid))) || pricing.get(k) || {};
      const extra = Number(pr.buyer_fee) || 0;
      map[k] = {
        item: r2(l.unitItem), tax: r2(l.unitTax), ship: r2(l.unitShip),
        orderFee: r2(l.unitFinder), extraFee: r2(extra),
        total: r2(l.unitTotal + extra), taxEstimated: !!lines.taxEstimated,
      };
    }
    o._lineCosts = map;
  }
}

const BOT_STATUS_SET = new Set(['Confirmed', 'Unship', 'Shipped', 'OFD', 'Delivered', 'Cancelled', 'Refunded']);
const isIsoDate = s => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(new Date(s + 'T12:00:00'));

// Bulk "Mark delivered". Returns every order's previous state so the page can
// offer Undo. Deliberately only accepts Delivered — the one bulk action wanted.
// ── Box fee: one fee for a whole box, split over its items by retail cost ────
// The box = the given orders plus every other live order on the same tracking
// number (a filter may be hiding some of them). dryRun returns the split for
// the preview without saving. Each order's share goes in finder_fee, which the
// item view already spreads over that order's items.
app.post('/api/admin/bot-packages/fee', auth, adminOnly, (req, res) => {
  const { orderIds, fee, dryRun } = req.body || {};
  const ids = [...new Set((Array.isArray(orderIds) ? orderIds : []).map(Number).filter(n => Number.isInteger(n) && n > 0))];
  const amount = Number(fee);
  if (!ids.length)                                return res.status(400).json({ error: 'orderIds required' });
  if (!Number.isFinite(amount) || amount < 0)     return res.status(400).json({ error: 'Fee must be a number' });

  const byId = new Map();
  for (const id of ids) {
    const o = db.prepare('SELECT * FROM bot_orders WHERE id=?').get([id]);
    if (!o) continue;
    byId.set(o.id, o);
    if (o.tracking) {
      db.prepare("SELECT * FROM bot_orders WHERE tracking=? AND status NOT IN ('Cancelled','Refunded')")
        .all([o.tracking]).forEach(x => byId.set(x.id, x));
    }
  }
  const orders = [...byId.values()].sort((a, b) => a.id - b.id);
  if (!orders.length) return res.status(404).json({ error: 'No such orders' });

  const catalog = SkuCatalog.loadCatalog(db);
  const split = splitBoxFee(orders, amount, catalog);
  // Products in this box that already carry a typed per-unit fee — a box fee
  // on top would count the same fee twice if they're one and the same.
  let pricingRows = [];
  try { pricingRows = db.prepare('SELECT * FROM bot_sku_prices').all(); } catch (_) {}
  split.unitFeeProducts = computeItemGroups(orders, pricingRows, catalog)
    .filter(g => g.perUnitFeeTyped > 0).map(g => ({ name: g.name, perUnit: g.perUnitFeeTyped }));
  if (!dryRun) {
    for (const o of split.orders) db.prepare('UPDATE bot_orders SET finder_fee=? WHERE id=?').run([o.fee, o.id]);
  }
  res.json({ ...split, saved: !dryRun });
});

// Orders that look like this one (same store, items and quantities) — so a fee
// typed once can be copied to the rest of the drop.
app.get('/api/admin/bot-orders/:id/similar', auth, adminOnly, (req, res) => {
  const o = db.prepare('SELECT * FROM bot_orders WHERE id=?').get([Number(req.params.id)]);
  if (!o) return res.status(404).json({ error: 'No such order' });
  const sig = orderSignature(o);
  if (!sig) return res.json({ matches: [] });
  const matches = db.prepare("SELECT * FROM bot_orders WHERE id<>? AND retailer IS ? AND status NOT IN ('Cancelled','Refunded')")
    .all([o.id, o.retailer ?? null])
    .filter(x => orderSignature(x) === sig)
    .map(x => ({ id: x.id, order_number: x.order_number, shipping_name: x.shipping_name, order_date: x.order_date,
                 status: x.status, finder_fee: Number(x.finder_fee) || 0 }))
    .sort((a, b) => String(a.order_number || '').localeCompare(String(b.order_number || '')));
  res.json({ matches });
});

// Same fee on each of these orders (one order = one fee, not split between them).
app.post('/api/admin/bot-orders/bulk-fee', auth, adminOnly, (req, res) => {
  const { orderIds, fee } = req.body || {};
  const ids = [...new Set((Array.isArray(orderIds) ? orderIds : []).map(Number).filter(n => Number.isInteger(n) && n > 0))];
  const amount = Number(fee);
  if (!ids.length)                            return res.status(400).json({ error: 'orderIds required' });
  if (!Number.isFinite(amount) || amount < 0) return res.status(400).json({ error: 'Fee must be a number' });
  let updated = 0;
  for (const id of ids) {
    const r = db.prepare('UPDATE bot_orders SET finder_fee=? WHERE id=?').run([Math.round(amount * 100) / 100, id]);
    if (r && r.changes) updated += Number(r.changes);
  }
  res.json({ updated });
});

app.post('/api/admin/bot-orders/bulk-status', auth, adminOnly, (req, res) => {
  const { orderIds, status, delivered_date } = req.body || {};
  const ids = [...new Set((Array.isArray(orderIds) ? orderIds : []).map(Number).filter(n => Number.isInteger(n) && n > 0))];
  if (!ids.length)            return res.status(400).json({ error: 'orderIds required' });
  if (status !== 'Delivered') return res.status(400).json({ error: 'Only Delivered is supported' });
  const date = delivered_date || new Date().toISOString().slice(0, 10);
  if (!isIsoDate(date))       return res.status(400).json({ error: 'delivered_date must be YYYY-MM-DD' });

  const previous = [];
  for (const id of ids) {
    const row = db.prepare('SELECT id, status, tracking_status, delivered_date, expected_date, status_changed_at, status_source FROM bot_orders WHERE id=?').get([id]);
    if (!row) continue;
    previous.push(row);
    db.prepare(`UPDATE bot_orders SET status='Delivered', tracking_status='Delivered',
                delivered_date=?, expected_date=NULL, status_changed_at=?, status_source='manual' WHERE id=?`)
      .run([date, date, id]);
  }
  res.json({ updated: previous.length, delivered_date: date, previous });
});

// Undo: put back exactly what bulk-status returned.
app.post('/api/admin/bot-orders/bulk-restore', auth, adminOnly, (req, res) => {
  const previous = Array.isArray(req.body?.previous) ? req.body.previous : [];
  const orNull = v => (v === undefined || v === '' ? null : v);
  let restored = 0;
  for (const p of previous) {
    const id = Number(p && p.id);
    if (!Number.isInteger(id) || id <= 0 || !BOT_STATUS_SET.has(p.status)) continue;
    db.prepare(`UPDATE bot_orders SET status=?, tracking_status=?, delivered_date=?, expected_date=?, status_changed_at=?, status_source=? WHERE id=?`)
      .run([p.status, orNull(p.tracking_status), orNull(p.delivered_date), orNull(p.expected_date), orNull(p.status_changed_at), orNull(p.status_source), id]);
    restored++;
  }
  res.json({ restored });
});

app.get('/api/admin/bot-items', auth, adminOnly, (req, res) => {
  const { category, retailer, status } = req.query;
  if (!category) return res.status(400).json({ error: 'category required' });

  // Filter BEFORE grouping so the per-unit landed costs below are averaged over
  // exactly the orders being displayed. Filtering after the fact would show a
  // cost blended from stores the user had filtered out.
  const [where, params] = botCategoryWhere(category);
  let sql = 'SELECT * FROM bot_orders WHERE ' + where;
  if (retailer) { sql += ' AND retailer=?'; params.push(retailer); }
  if (status)   { sql += ' AND status=?';   params.push(status); }
  // Cancelled/Refunded carry no inventory, so they're excluded by default — but
  // shown when explicitly selected, otherwise picking them looks broken.
  else          { sql += " AND status NOT IN ('Cancelled','Refunded')"; }

  const orders = db.prepare(sql).all(params);

  let pricingRows = [];
  try { pricingRows = db.prepare('SELECT * FROM bot_sku_prices').all(); } catch(_) {}
  let salesRows = [];
  try { salesRows = db.prepare('SELECT * FROM bot_sales ORDER BY sold_at DESC, id DESC').all(); } catch(_) {}
  res.json(computeItemGroups(withMainAddress(orders, { replace: true }), pricingRows, SkuCatalog.loadCatalog(db), salesRows, loadStock()));
});

// ── Backup: the whole database as one file ──────────────────────────────────
// A consistent snapshot (VACUUM INTO), safe while the site is running. It holds
// customer names and addresses — keep it on your computer, never on GitHub
// (*.db and backups/ are git-ignored).
app.get('/api/admin/backup', auth, adminOnly, (req, res) => {
  const tmp = path.join(require('os').tmpdir(), `inv-backup-${Date.now()}-${process.pid}.db`);
  try {
    db.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`);
    const buf = fs.readFileSync(tmp);
    const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
    res.set({
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': `attachment; filename="inventory-backup-${stamp}.db"`,
      'Cache-Control': 'no-store',
    });
    res.send(buf);
  } catch (e) {
    res.status(500).json({ error: 'Backup failed: ' + e.message });
  } finally {
    try { fs.rmSync(tmp, { force: true }); } catch (_) {}
  }
});

// ── Money totals for the dashboard cards ────────────────────────────────────
// Per order: finder fee paid (box/order fee + typed per-unit fee × its units).
// Per sale: revenue, fees, landed cost of the units sold, profit. The page sums
// whichever fall inside the WHEN range. Cancelled/refunded orders are left out
// (no inventory, no fee).
app.get('/api/admin/bot-money', auth, adminOnly, (req, res) => {
  const partnersList = loadPartners(db);
  const orders = annotatePartners(db.prepare("SELECT * FROM bot_orders WHERE status NOT IN ('Cancelled','Refunded')").all(), partnersList);
  let pricingRows = [], salesRows = [];
  try { pricingRows = db.prepare('SELECT * FROM bot_sku_prices').all(); } catch (_) {}
  try { salesRows = db.prepare('SELECT * FROM bot_sales').all(); } catch (_) {}
  const stock  = loadStock();
  const groups = computeItemGroups(orders, pricingRows, SkuCatalog.loadCatalog(db), salesRows, stock);
  const r2 = n => Math.round(n * 100) / 100;

  const unitFees = new Map();
  for (const g of groups) {
    if (!g.perUnitFeeTyped) continue;
    for (const l of g.orderLines) {
      if (l.id == null) continue;
      unitFees.set(l.id, (unitFees.get(l.id) || 0) + l.qty * g.perUnitFeeTyped);
    }
  }
  const allFees = orders
    .map(o => ({ id: o.id, partner_id: o.partner_id, fee: r2((Number(o.finder_fee) || 0) + (unitFees.get(o.id) || 0)) }))
    .filter(x => x.fee > 0);
  // Your FINDER FEES card: your orders only — a partner's fees are on his tab.
  const orderFees = allFees.filter(x => !x.partner_id).map(({ id, fee }) => ({ id, fee }));

  const seen = new Set();
  const sales = [];
  const partnerSales = [];
  for (const g of groups) {
    for (const s of g.sales) {
      if (s.id != null && seen.has(s.id)) continue;
      if (s.id != null) seen.add(s.id);
      // Only YOUR units of a sale count here; a partner's units go on his tab.
      const parts = s.parts || [{ owner: 0, qty: s.qty, revenue: s.qty * s.unit_price, fees: s.fees, cost: s.cost != null ? s.cost : s.qty * g.perUnitTotal }];
      for (const pt of parts.filter(x => x.owner)) {
        partnerSales.push({ partner_id: pt.owner, id: s.id, product: g.name, sold_at: s.sold_at, ...pt });
      }
      const mine = parts.find(x => !x.owner);
      if (!mine || !mine.qty) continue;
      sales.push({ id: s.id, product: g.name, sku_key: g.skuKey, category: (g.categories || [])[0] || 'Other',
                   sold_at: s.sold_at, qty: mine.qty, unit_price: s.unit_price, channel: s.channel || null,
                   unit_cost: g.perUnitTotal, shared: parts.length > 1,
                   revenue: r2(mine.revenue), fees: r2(mine.fees), cost: r2(mine.cost), profit: r2(mine.revenue - mine.fees - mine.cost) });
    }
  }
  // Claims: open ones (money waiting to come back), refunds, write-offs.
  const claims = { open: 0, openUnits: 0, pending: 0, refunded: 0, writtenOff: 0, toPickUpUnits: 0 };
  const byId = new Map(orders.map(o => [o.id, o]));
  for (const is of stock.issues) {
    const cost = issueUnitCost(is, byId.get(is.order_id)) * is.qty;
    if (ISSUE_OPEN.has(is.status)) { claims.open++; claims.openUnits += is.qty; claims.pending += cost; }
    else if (is.status === 'refunded') claims.refunded += Number(is.refund_amount) || 0;
    else if (is.status === 'denied_writeoff' || (is.status === 'denied_keep' && is.kind === 'missing')) claims.writtenOff += cost;
  }
  claims.toPickUpUnits = groups.reduce((a, g) => a + (g.toPickUp || 0), 0);
  // What's still unsold, at landed cost, and where it is.
  const ownerStock = owner => groups.reduce((a, g) => {
    const x = (g.stockByOwner || {})[owner]; return x ? { units: a.units + x.units, cost: a.cost + x.cost } : a; }, { units: 0, cost: 0 });
  const myStock = ownerStock(0);
  const stockTotals = {
    unitsInHand: groups.reduce((a, g) => a + (g.unitsLeft || 0), 0),      // every unit on your shelf
    inHandCost:  r2(groups.some(g => g.stockByOwner) ? myStock.cost : groups.reduce((a, g) => a + (g.stockAtCost || 0), 0)),  // yours
    partnerUnits: groups.reduce((a, g) => a + Object.entries(g.stockByOwner || {})
      .filter(([k]) => Number(k)).reduce((b, [, x]) => b + x.units, 0), 0),   // on your shelf, but a partner's
    toPickUpCost: r2(groups.reduce((a, g) => a + (g.toPickUpCost || 0), 0)),
    onTheWayCost: r2(groups.reduce((a, g) => a + (g.onTheWayCost || 0), 0)),
    countLoss:   r2(groups.reduce((a, g) => a + (g.countLoss || 0), 0)),
  };
  for (const k of ['pending', 'refunded', 'writtenOff']) claims[k] = r2(claims[k]);

  // ── Each partner's tab ──────────────────────────────────────────────────
  let payouts = [];
  try { payouts = db.prepare('SELECT * FROM bot_partner_payouts ORDER BY paid_at DESC, id DESC').all(); } catch (_) {}
  const partners = partnersList.map(p => {
    const mineOrders = orders.filter(o => o.partner_id === p.id);
    const spent = mineOrders.reduce((a, o) => a + (Number(o.order_total) || 0) - (Number(o.refunded_amount) || 0), 0);
    const fees  = allFees.filter(x => x.partner_id === p.id).reduce((a, x) => a + x.fee, 0);
    const st    = ownerStock(p.id);
    const ps    = partnerSales.filter(x => x.partner_id === p.id);
    const sold  = ps.reduce((a, x) => a + x.qty, 0);
    const salesNet = ps.reduce((a, x) => a + x.revenue - x.fees, 0);
    const paid  = payouts.filter(x => x.partner_id === p.id).reduce((a, x) => a + (Number(x.amount) || 0), 0);
    return {
      id: p.id, name: p.name, note: p.note || '',
      // Old single list (before per-retailer lists) — not used for matching.
      emails: p.emails || '', names: p.names || '',
      profiles: (p.profiles || []).map(x => ({ retailer: x.retailer, emails: x.emails || '', names: x.names || '' })),
      // Near-misses: maybe his — you decide (His / Mine).
      checkList: orders.filter(o => o.partner_check_id === p.id).map(o => ({ id: o.id, order_number: o.order_number,
        retailer: o.retailer, shipping_name: o.shipping_name, account_email: o.account_email, status: o.status,
        total: Number(o.order_total) || 0, why: o.partner_check_why })),
      orders: mineOrders.length, spent: r2(spent), fees: r2(fees), totalIn: r2(spent + fees),
      unitsInStock: st.units, stockCost: r2(st.cost),
      unitsSold: sold, salesNet: r2(salesNet), costOfSold: r2(ps.reduce((a, x) => a + x.cost, 0)),
      paid: r2(paid), owed: r2(salesNet - paid),
      payouts: payouts.filter(x => x.partner_id === p.id),
      orderList: mineOrders.map(o => ({ id: o.id, order_number: o.order_number, retailer: o.retailer, status: o.status,
        order_date: o.order_date, total: Number(o.order_total) || 0, match: o.partner_match })),
      sales: ps,
    };
  });
  // Your SPENT card leaves their orders out: send which orders are theirs.
  const partnerOrderIds = orders.filter(o => o.partner_id).map(o => o.id);
  const retailers = [...new Set(orders.map(o => o.retailer).filter(Boolean))].sort();
  res.json({ orderFees, sales, claims, stock: stockTotals, partners, partnerOrderIds, retailers });
});

// ── Product catalog (see skuCatalog.js) ─────────────────────────────────────
// Links store titles to short product names. Editing here never rewrites order
// data — the item view regroups from these links on its next load.
app.get('/api/admin/sku-products', auth, adminOnly, (req, res) => {
  res.json(SkuCatalog.listProducts(db));
});

// Create / rename / merge a product and link store titles to it, in one call.
app.post('/api/admin/sku-products/save', auth, adminOnly, (req, res) => {
  try {
    const { productId, name, rawNames, mergeIntoId, buyer_fee, sale_price } = req.body || {};
    const id = SkuCatalog.saveProduct(db, {
      productId: productId || null,
      name,
      rawNames: Array.isArray(rawNames) ? rawNames : [],
      mergeIntoId: mergeIntoId || null,
    });
    if (buyer_fee !== undefined || sale_price !== undefined) {
      db.prepare('INSERT OR REPLACE INTO bot_sku_prices (sku, buyer_fee, sale_price) VALUES (?,?,?)')
        .run([SkuCatalog.productSkuKey(id), parseFloat(buyer_fee) || 0, parseFloat(sale_price) || 0]);
    }
    res.json({ productId: id });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Accept the suggested short names for many unlinked rows at once.
app.post('/api/admin/sku-products/accept', auth, adminOnly, (req, res) => {
  try {
    const groups = Array.isArray(req.body?.groups) ? req.body.groups : [];
    let created = 0, linked = 0;
    for (const g of groups) {
      if (!g || !g.name || !Array.isArray(g.rawNames) || !g.rawNames.length) continue;
      const before = SkuCatalog.listProducts(db).length;
      const id = SkuCatalog.createProduct(db, g.name);
      if (SkuCatalog.listProducts(db).length > before) created++;
      linked += SkuCatalog.linkTitles(db, id, g.rawNames);
    }
    res.json({ created, linked });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Unlink one store title — it reappears as its own unlinked row.
app.delete('/api/admin/sku-aliases', auth, adminOnly, (req, res) => {
  const { rawName } = req.body || {};
  if (!rawName) return res.status(400).json({ error: 'rawName required' });
  SkuCatalog.unlinkTitle(db, rawName);
  res.json({ ok: true });
});

// Remove a product. Its orders are untouched; their titles become unlinked.
app.delete('/api/admin/sku-products/:id', auth, adminOnly, (req, res) => {
  SkuCatalog.deleteProduct(db, Number(req.params.id));
  res.json({ ok: true });
});

// ── Sales of bot products (recorded in parts) ───────────────────────────────
app.post('/api/admin/bot-sales', auth, adminOnly, (req, res) => {
  const b = req.body || {};
  const qty   = Number(b.qty);
  const price = Number(b.unit_price);
  const fees  = b.fees === undefined || b.fees === '' ? 0 : Number(b.fees);
  const date  = b.sold_at || new Date().toISOString().slice(0, 10);
  if (!b.sku_key || typeof b.sku_key !== 'string')      return res.status(400).json({ error: 'sku_key required' });
  if (!Number.isInteger(qty) || qty < 1)                return res.status(400).json({ error: 'Quantity must be a whole number of at least 1' });
  if (!Number.isFinite(price) || price < 0)             return res.status(400).json({ error: 'Price must be a number' });
  if (!Number.isFinite(fees) || fees < 0)               return res.status(400).json({ error: 'Fees must be a number' });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date))                 return res.status(400).json({ error: 'Date must be YYYY-MM-DD' });
  const r = db.prepare(`INSERT INTO bot_sales (sku_key, product_name, qty, unit_price, fees, channel, sold_at)
                        VALUES (?,?,?,?,?,?,?)`)
    .run([b.sku_key, b.product_name || null, qty, Math.round(price * 100) / 100, Math.round(fees * 100) / 100,
          (b.channel || '').trim() || null, date]);
  res.json({ id: r && r.lastInsertRowid != null ? Number(r.lastInsertRowid) : null });
});

app.delete('/api/admin/bot-sales/:id', auth, adminOnly, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'bad id' });
  db.prepare('DELETE FROM bot_sales WHERE id=?').run([id]);
  res.json({ ok: true });
});

// Save per-SKU pricing (buyer_fee + sale_price)
app.patch('/api/admin/bot-items/sku', auth, adminOnly, (req, res) => {
  const { sku, buyer_fee, sale_price } = req.body;
  if (!sku) return res.status(400).json({ error: 'sku required' });
  db.prepare('INSERT OR REPLACE INTO bot_sku_prices (sku,buyer_fee,sale_price) VALUES (?,?,?)')
    .run([sku, buyer_fee||0, sale_price||0]);
  res.json({ success: true });
});

// Rename item name across all orders (fixes typos like "LEGOPOKEMONEEVEE" → "LEGO Pokemon Eevee")
app.patch('/api/admin/bot-items/rename', auth, adminOnly, (req, res) => {
  const { oldName, newName } = req.body;
  if (!oldName || !newName) return res.status(400).json({ error: 'oldName and newName required' });
  const orders = db.prepare('SELECT id, items FROM bot_orders').all();
  let updated = 0;
  for (const o of orders) {
    let arr; try { arr = JSON.parse(o.items||'[]'); } catch(_) { continue; }
    let changed = false;
    const newArr = arr.map(raw => {
      // Each element may have multiple " | " parts
      const parts = String(raw||'').split(/\s*\|\s*/);
      const newParts = parts.map(p => {
        // Match on the bare name, then rebuild keeping the quantity prefix and
        // any price/SKU suffix intact.
        const d = decomposeItem(p);
        if (itemKey(d.name) === itemKey(oldName)) {
          changed = true;
          return d.qtyPrefix + newName + d.suffix;
        }
        return p;
      });
      return newParts.join(' | ');
    });
    if (changed) {
      db.prepare('UPDATE bot_orders SET items=? WHERE id=?').run([JSON.stringify(newArr), o.id]);
      updated++;
    }
  }
  // Move sku_prices entry to new name
  try {
    const existing = db.prepare('SELECT * FROM bot_sku_prices WHERE lower(sku)=lower(?)').get([oldName]);
    if (existing) {
      db.prepare('INSERT OR REPLACE INTO bot_sku_prices (sku,buyer_fee,sale_price) VALUES (?,?,?)').run([newName, existing.buyer_fee, existing.sale_price]);
      db.prepare('DELETE FROM bot_sku_prices WHERE lower(sku)=lower(?) AND sku!=?').run([oldName, newName]);
    }
  } catch(_) {}
  res.json({ updated });
});

// Delete all orders that contain a specific item name; adds order#s to blocklist
app.delete('/api/admin/bot-items/by-name', auth, adminOnly, (req, res) => {
  // A product row can represent several store titles (see skuCatalog.js), so
  // accept the full list. A single `name` is still accepted for compatibility.
  const { name, names } = req.body || {};
  const targets = new Set([...(Array.isArray(names) ? names : []), ...(name ? [name] : [])].map(itemKey).filter(Boolean));
  if (!targets.size) return res.status(400).json({ error: 'name or names required' });
  const orders = db.prepare('SELECT id, order_number, items FROM bot_orders').all();
  const toDelete = [];
  for (const o of orders) {
    let arr; try { arr = JSON.parse(o.items||'[]'); } catch(_) { arr = []; }
    const titles = arr.flatMap(splitItemParts).map(parseItemName);
    if (titles.some(n => targets.has(itemKey(n)))) toDelete.push(o);
  }
  // Add to blocklist
  try {
    const raw = db.prepare("SELECT value FROM settings WHERE key='scraper_blocked_orders'").get();
    const blocked = raw ? JSON.parse(raw.value) : [];
    for (const o of toDelete) if (o.order_number && !blocked.includes(o.order_number)) blocked.push(o.order_number);
    db.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES ('scraper_blocked_orders',?)").run([JSON.stringify(blocked)]);
  } catch(_) {}
  if (toDelete.length) {
    const ids = toDelete.map(o=>o.id);
    db.prepare(`DELETE FROM bot_orders WHERE id IN (${ids.map(()=>'?').join(',')})`).run(ids);
  }
  res.json({ deleted: toDelete.length });
});

app.get('/api/admin/bot-orders', auth, adminOnly, (req, res) => {
  const orders = db.prepare('SELECT * FROM bot_orders ORDER BY order_date DESC, received_at DESC, created_at DESC LIMIT 500').all();
  res.json(withMainAddress(orders));
});

// Manual refresh: fires immediately, runs tracking check in background
app.post('/api/admin/bot-orders/refresh-tracking', auth, adminOnly, (req, res) => {
  res.json({ started: true }); // return right away so browser doesn't hang
  autoUpdateTracking().catch(e => console.error('refresh-tracking error:', e));
});

// Progress poll — client calls this every 700ms to show live counter
app.get('/api/admin/bot-orders/refresh-status', auth, adminOnly, (req, res) => {
  res.json(_refreshProgress);
});

app.post('/api/admin/bot-orders', auth, adminOnly, (req, res) => {
  const { category, retailer, order_number, account_email, order_date, shipping_name, shipping_address, status, items, order_total, notes } = req.body;
  // Refuse a manual duplicate rather than silently creating a second row.
  const dup = OrderMerge.findExisting(db, order_number, retailer);
  if (dup) return res.status(409).json({ error: `Order #${order_number} already exists`, id: dup.id });
  const r = db.prepare(`INSERT INTO bot_orders (category,retailer,order_number,account_email,order_date,shipping_name,shipping_address,status,items,order_total,notes,received_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)`)
    .run([category||'Other',retailer||null,order_number||null,account_email||null,order_date||null,shipping_name||null,shipping_address||null,status||'Confirmed',JSON.stringify(items||[]),parseFloat(order_total)||0,notes||null]);
  res.json({ id: r.lastInsertRowid });
});

app.patch('/api/admin/bot-orders/:id', auth, adminOnly, (req, res) => {
  const o = req.body;
  db.prepare(`UPDATE bot_orders SET
    category=COALESCE(?,category), retailer=COALESCE(?,retailer), order_number=COALESCE(?,order_number),
    account_email=COALESCE(?,account_email), order_date=COALESCE(?,order_date), delivered_date=COALESCE(?,delivered_date),
    shipping_name=COALESCE(?,shipping_name), shipping_address=COALESCE(?,shipping_address),
    status=COALESCE(?,status), items=COALESCE(?,items), order_total=COALESCE(?,order_total),
    refunded_amount=COALESCE(?,refunded_amount), notes=COALESCE(?,notes), tracking=COALESCE(?,tracking),
    tracking_status=COALESCE(?,tracking_status), expected_date=COALESCE(?,expected_date),
    tax_amount=COALESCE(?,tax_amount), ship_cost=COALESCE(?,ship_cost), finder_fee=COALESCE(?,finder_fee)
    WHERE id=?`)
    .run([o.category||null,o.retailer||null,o.order_number||null,o.account_email||null,o.order_date||null,o.delivered_date||null,o.shipping_name||null,o.shipping_address||null,o.status||null,o.items?JSON.stringify(o.items):null,o.order_total!=null?o.order_total:null,o.refunded_amount!=null?o.refunded_amount:null,o.notes||null,o.tracking||null,o.tracking_status||null,o.expected_date||null,o.tax_amount!=null?o.tax_amount:null,o.ship_cost!=null?o.ship_cost:null,o.finder_fee!=null?o.finder_fee:null,req.params.id]);
  // A status you set by hand survives Repair Statuses (see status_source).
  if (o.status) db.prepare("UPDATE bot_orders SET status_source='manual' WHERE id=?").run([req.params.id]);
  res.json({ success: true });
});

app.delete('/api/admin/bot-orders/:id', auth, adminOnly, (req, res) => {
  // Before deleting, remember this order_number so the scraper doesn't recreate it
  const row = db.prepare('SELECT order_number FROM bot_orders WHERE id=?').get([req.params.id]);
  if (row && row.order_number) {
    try {
      const raw = db.prepare("SELECT value FROM settings WHERE key='scraper_blocked_orders'").get();
      const blocked = raw ? JSON.parse(raw.value) : [];
      if (!blocked.includes(row.order_number)) {
        blocked.push(row.order_number);
        db.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES ('scraper_blocked_orders',?)").run([JSON.stringify(blocked)]);
      }
    } catch(_) {}
  }
  db.prepare('DELETE FROM bot_orders WHERE id=?').run([req.params.id]);
  res.json({ success: true });
});

// ─── ORDER TRACKER (admin-only, not in /public) ──────────────────────────────
// Requires a valid admin JWT passed as ?token=<jwt> in the URL.
// The token is verified server-side before the file is sent, so the page is
// never reachable without credentials. The link is only surfaced inside
// admin.html (itself behind a login wall).
app.get('/admin/orders', (req, res) => {
  const token = req.query.token || (req.headers.authorization || '').replace('Bearer ', '');
  if (!token) return res.status(401).send('<h2>401 – Not authorised</h2>');
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    if (decoded.role !== 'admin') return res.status(403).send('<h2>403 – Admin only</h2>');
    res.sendFile(path.join(__dirname, 'order_tracker.html'));
  } catch(e) {
    res.status(401).send('<h2>401 – Invalid or expired token</h2>');
  }
});

// ─── EMAIL SCRAPER ───────────────────────────────────────────────────────────
const { runEmailScraper, scrapeByOrderNumber, resetEmailScraper, reparseStoredEmails } = require('./emailScraper');
const { healFromSavedEmails } = require('./selfHeal');

// A scan, then: if orders read by older code still have gaps (shipped with no
// tracking, no address), re-read the saved emails once (selfHeal.js).
async function scanAndHeal() {
  const n = await runEmailScraper(db);
  try {
    await healFromSavedEmails(db, d => reparseStoredEmails(d), { after: d => OrderMerge.reconcileDelivered(d) });
  } catch (e) { console.error('self-heal failed:', e.message); }
  return n;
}

// Manual trigger — Scan Emails button in UI calls this
let _scrapeProgress = { running: false, updated: 0 };
app.post('/api/admin/scrape-emails', auth, adminOnly, (req, res) => {
  if (_scrapeProgress.running) return res.json({ started: false, already: true });
  _scrapeProgress = { running: true, updated: 0 };
  res.json({ started: true });
  scanAndHeal()
    .then(n => { _scrapeProgress = { running: false, updated: n }; })
    .catch(e => { console.error('scrape-emails error:', e); _scrapeProgress = { running: false, updated: 0 }; });
});
// Re-download old emails from the inbox (default 180 days). Fill-only: fills
// what older reads didn't save (the account email an order went to), never
// overwrites, and statuses only move forward. No orders are deleted.
app.post('/api/admin/scrape-emails/refetch', auth, adminOnly, (req, res) => {
  if (_scrapeProgress.running) return res.json({ started: false, already: true });
  const days = Math.min(730, Math.max(7, parseInt((req.body || {}).days) || 180));
  resetEmailScraper(db, { wipeOrders: false, days });
  _scrapeProgress = { running: true, updated: 0 };
  res.json({ started: true, days });
  scanAndHeal()
    .then(n => { _scrapeProgress = { running: false, updated: n }; })
    .catch(e => { console.error('refetch error:', e); _scrapeProgress = { running: false, updated: 0 }; });
});
app.get('/api/admin/scrape-emails/status', auth, adminOnly, (req, res) => {
  res.json(_scrapeProgress);
});
app.post('/api/admin/scrape-emails/reset', auth, adminOnly, (req, res) => {
  const wipeOrders = req.body?.wipe === true;
  const days = parseInt(req.body?.days) || 180;
  resetEmailScraper(db, { wipeOrders, days });
  // A wipe clears the table, so put the baseline back immediately. Retailers the
  // scraper can't read (Mattel, Sam's Club, Costco, Bear Walker) exist ONLY here —
  // without this they are gone for good.
  let baseline = null;
  if (wipeOrders) baseline = importBaselineOrders(db, { force: true });
  res.json({ reset: true, wipeOrders, days, baseline });
});

// Restore the baseline orders without touching anything else.
app.post('/api/admin/orders/restore-baseline', auth, adminOnly, (req, res) => {
  try {
    res.json(importBaselineOrders(db, { force: req.body?.force === true }));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Re-run the parser over archived emails — no Gmail/IMAP round trip.
// Use this after a parser change: it re-extracts every order in seconds.
app.post('/api/admin/scrape-emails/reparse', auth, adminOnly, async (req, res) => {
  try {
    if (req.body?.wipe === true) {
      db.prepare('DELETE FROM bot_orders').run();
      db.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES ('scraper_blocked_orders','[]')").run();
    }
    const result = await reparseStoredEmails(db, { rebuildStatus: req.body?.rebuildStatus === true });
    result.reconciled = OrderMerge.reconcileDelivered(db);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Scan a specific order number — searches all Gmail history for it
app.post('/api/admin/scrape-emails/order', auth, adminOnly, async (req, res) => {
  const { order_number } = req.body;
  if (!order_number) return res.status(400).json({ error: 'order_number required' });
  const result = await scrapeByOrderNumber(db, order_number);
  res.json(result);
});

// Auto-run: 5 min after server start, then every 2 hours
setTimeout(() => scanAndHeal(), 5 * 60 * 1000);
setInterval(() => scanAndHeal(), 2 * 60 * 60 * 1000);

// ─── AUTO TRACKING UPDATE ────────────────────────────────────────────────────
const https = require('https');
const http  = require('http');

function fetchUrlPost(url, jsonBody, timeoutMs=8000) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(jsonBody);
    const parsed = new URL(url);
    const opts = {
      hostname: parsed.hostname, path: parsed.pathname + parsed.search,
      method: 'POST',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data),
        'Accept': 'application/json', 'Origin': 'https://www.ups.com', 'Referer': 'https://www.ups.com/'
      }
    };
    const req = https.request(opts, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.setTimeout(timeoutMs);
    req.write(data);
    req.end();
  });
}

function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    const req = client.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/json,*/*'
      },
      timeout: 7000
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

function detectCarrier(tracking) {
  if (!tracking) return null;
  if (tracking.startsWith('1Z')) return 'ups';
  if (/^87\d{10}$/.test(tracking)) return 'narvar';   // Pokemon Center / Narvar
  if (/^9[24]\d{20}$/.test(tracking)) return 'usps';
  if (/^(96|7489)/.test(tracking) || /^\d{12}$/.test(tracking)) return 'fedex';
  return null;
}

function parseExpectedDate(text) {
  // Try to pull a date from text like "Sep 16, 2026" or "September 16" or "09/16/2026"
  const patterns = [
    /(?:scheduled|estimated|expected)\s+delivery[^:]*:\s*([A-Za-z]+\.?\s+\d{1,2},?\s+\d{4})/i,
    /(?:scheduled|estimated|expected)\s+delivery[^:]*:\s*([A-Za-z]+\.?\s+\d{1,2})/i,
    /by\s+([A-Za-z]+\.?\s+\d{1,2},?\s+\d{4})/i,
    /(\d{1,2}\/\d{1,2}\/\d{4})/
  ];
  for (const p of patterns) {
    const m = text.match(p);
    if (m) {
      try {
        const d = new Date(m[1]);
        if (!isNaN(d)) return d.toISOString().split('T')[0];
      } catch(e) {}
    }
  }
  return null;
}

async function checkTracking(tracking, carrier) {
  // Returns { newStatus: 'Delivered'|null, trackingStatus: 'Delivered'|'OFD'|'In Transit'|null, expectedDate: 'YYYY-MM-DD'|null }
  const result = { newStatus: null, trackingStatus: null, expectedDate: null };
  try {
    let res, b, bl;
    if (carrier === 'ups') {
      // UPS blocks cloud/server IPs — use the ✓ Del button in the UI to mark manually
      console.log(`   ⏭️  Skipping UPS ${tracking} (blocked from server — use manual ✓ Del button)`);
    } else if (carrier === 'narvar') {
      res = await fetchUrl(`https://pokemoncenter.narvar.com/pokemoncenter/tracking?tracking_numbers=${tracking}&locale=en_US`);
      b = res.body; bl = b.toLowerCase();
      try {
        const json = JSON.parse(b);
        // Narvar response shape: look for status and estimated delivery
        const info = json.tracking_details || json.shipment || json;
        const statusRaw = (info?.tracking_status || info?.status || '').toLowerCase();
        const estDate = info?.estimated_delivery_date || info?.expected_delivery || info?.delivery_date;
        if (statusRaw.includes('delivered') || bl.includes('"delivered"')) {
          result.newStatus = 'Delivered'; result.trackingStatus = 'Delivered';
        } else if (statusRaw.includes('out_for_delivery') || statusRaw.includes('out for delivery') || bl.includes('out_for_delivery')) {
          result.trackingStatus = 'OFD';
        } else if (statusRaw || bl.includes('in_transit') || bl.includes('in transit')) {
          result.trackingStatus = 'In Transit';
        }
        if (estDate) { try { const d = new Date(estDate); if (!isNaN(d)) result.expectedDate = d.toISOString().split('T')[0]; } catch(e){} }
        // Fallback text scan
        if (!result.expectedDate) result.expectedDate = parseExpectedDate(b);
      } catch(e) {
        // Not JSON, fall back to text scan
        if (bl.includes('"delivered"') || (bl.includes('delivered') && !bl.includes('estimated'))) {
          result.newStatus = 'Delivered'; result.trackingStatus = 'Delivered';
        } else if (bl.includes('out for delivery') || bl.includes('out_for_delivery')) {
          result.trackingStatus = 'OFD';
        }
        result.expectedDate = parseExpectedDate(b);
      }
    } else if (carrier === 'usps') {
      res = await fetchUrl(`https://tools.usps.com/go/TrackConfirmAction?tLabels=${tracking}`);
      b = res.body; bl = b.toLowerCase();
      if (bl.includes('delivered')) {
        result.newStatus = 'Delivered'; result.trackingStatus = 'Delivered';
      } else if (bl.includes('out for delivery')) {
        result.trackingStatus = 'OFD';
      } else {
        result.trackingStatus = 'In Transit';
        result.expectedDate = parseExpectedDate(b);
      }
    } else if (carrier === 'fedex') {
      res = await fetchUrl(`https://www.fedex.com/apps/fedextrack/?action=track&trackingnumber=${tracking}`);
      b = res.body; bl = b.toLowerCase();
      if (bl.includes('delivered')) {
        result.newStatus = 'Delivered'; result.trackingStatus = 'Delivered';
      } else if (bl.includes('out for delivery')) {
        result.trackingStatus = 'OFD';
      } else {
        result.trackingStatus = 'In Transit';
        result.expectedDate = parseExpectedDate(b);
      }
    }
  } catch (e) {
    console.log(`  ⚠️  Tracking check failed for ${tracking}: ${e.message}`);
  }
  return result;
}

// Progress state — polled by the client during manual refresh
let _refreshProgress = { running: false, checked: 0, total: 0 };

async function autoUpdateTracking() {
  if (_refreshProgress.running) return; // prevent overlap
  console.log('\n🔄 Auto-tracking check started...');
  try {
    const shipped = db.prepare(
      `SELECT id, order_number, tracking, retailer FROM bot_orders WHERE status='Shipped' AND tracking IS NOT NULL AND tracking != ''`
    ).all([]);
    console.log(`   Checking ${shipped.length} shipped orders`);
    _refreshProgress = { running: true, checked: 0, total: shipped.length };

    let updated = 0;
    const today = new Date().toISOString().split('T')[0];

    for (const order of shipped) {
      const carrier = detectCarrier(order.tracking);
      if (!carrier) { _refreshProgress.checked++; continue; }

      await new Promise(r => setTimeout(r, 800)); // brief pause between requests

      const { newStatus, trackingStatus, expectedDate } = await checkTracking(order.tracking, carrier);
      if (newStatus === 'Delivered') {
        // COALESCE: the carrier tells us it's delivered but not when, so "today"
        // is only a detection-time fallback. Never overwrite a real delivery date
        // already derived from the retailer's own delivery email.
        db.prepare(`UPDATE bot_orders SET status='Delivered', delivered_date=COALESCE(delivered_date,?), tracking_status='Delivered', expected_date=NULL, status_source='carrier' WHERE id=?`).run([today, order.id]);
        console.log(`   ✅ Delivered: #${order.order_number} (${order.tracking})`);
        updated++;
      } else {
        const fields = []; const vals = [];
        if (trackingStatus) { fields.push("tracking_status=?"); vals.push(trackingStatus); }
        if (expectedDate) { fields.push("expected_date=?"); vals.push(expectedDate); }
        if (fields.length) {
          db.prepare(`UPDATE bot_orders SET ${fields.join(',')} WHERE id=?`).run([...vals, order.id]);
          console.log(`   📦 #${order.order_number}: ${trackingStatus||''}${expectedDate?' exp '+expectedDate:''}`);
        }
      }
      _refreshProgress.checked++;
    }

    console.log(`🔄 Auto-tracking done: ${updated} updated to Delivered\n`);
  } catch (e) {
    console.error('Auto-tracking error:', e.message);
  } finally {
    _refreshProgress.running = false;
  }
}

// Run 2 minutes after server start, then every 24 hours
setTimeout(autoUpdateTracking, 2 * 60 * 1000);
setInterval(autoUpdateTracking, 24 * 60 * 60 * 1000);

// ─── START ───────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n✅ Inventory Site v2 running at http://localhost:${PORT}`);
  console.log(`   Admin panel: http://localhost:${PORT}/admin.html`);
  console.log(`   Order tracker: http://localhost:${PORT}/admin/orders?token=<jwt>`);
  console.log(`   Admin password: ${ADMIN_PASSWORD}\n`);
});
