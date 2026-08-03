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
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
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
try { db.exec('ALTER TABLE sales ADD COLUMN payment_method TEXT'); } catch(e) {}

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

// ─── PUBLIC ROUTES ────────────────────────────────────────────────────────────
app.get('/api/products', (req, res) => {
  const { category, search, stock, featured } = req.query;
  let sql = 'SELECT * FROM products WHERE 1=1';
  const params = [];
  if (category && category !== 'All') { sql += ' AND category=?'; params.push(category); }
  if (search) { sql += ' AND (name LIKE ? OR description LIKE ? OR subcategory LIKE ?)'; params.push(`%${search}%`, `%${search}%`, `%${search}%`); }
  if (stock) { sql += ' AND stock=?'; params.push(stock); }
  if (featured === '1') { sql += ' AND featured=1'; }
  sql += ' ORDER BY featured DESC, sort_order ASC, created_at DESC';
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
  rows.forEach(r => { obj[r.key] = r.value; });
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
  if (password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Wrong password' });
  const token = jwt.sign({ admin: true }, JWT_SECRET, { expiresIn: '24h' });
  res.json({ token });
});

// ─── ADMIN PRODUCT ROUTES ─────────────────────────────────────────────────────
app.post('/api/admin/products', auth, (req, res) => {
  const { name, category, subcategory, description, price, price_unit, sku, source, stock, images, featured, sort_order, quantity, source_url, cost_price } = req.body;
  if (!name) return res.status(400).json({ error: 'Name required' });
  const n = v => (v === undefined || v === '') ? null : v;
  const result = db.prepare(`INSERT INTO products (name,category,subcategory,description,price,price_unit,sku,source,stock,images,featured,sort_order,quantity,source_url,cost_price) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run([name, category||'Other', n(subcategory), n(description), n(price), price_unit||'each', n(sku), source||'Other', stock||'in_stock', JSON.stringify(images||[]), featured?1:0, sort_order||0, parseInt(quantity)||0, n(source_url), n(cost_price)]);
  res.json({ id: result.lastInsertRowid });
});

app.put('/api/admin/products/:id', auth, (req, res) => {
  const { name, category, subcategory, description, price, price_unit, sku, source, stock, images, featured, sort_order, quantity, source_url, cost_price } = req.body;
  if (!name) return res.status(400).json({ error: 'Name required' });
  const n = v => (v === undefined || v === '') ? null : v;
  db.prepare(`UPDATE products SET name=?,category=?,subcategory=?,description=?,price=?,price_unit=?,sku=?,source=?,stock=?,images=?,featured=?,sort_order=?,quantity=?,source_url=?,cost_price=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`)
    .run([name, category||'Other', n(subcategory), n(description), n(price), price_unit||'each', n(sku), source||'Other', stock||'in_stock', JSON.stringify(images||[]), featured?1:0, sort_order||0, parseInt(quantity)||0, n(source_url), n(cost_price), req.params.id]);
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
app.post('/api/admin/sales', auth, (req, res) => {
  const { product_id, product_name, quantity_sold, sale_price, cost_price, notes, payment_method, sold_at } = req.body;
  if (!product_name || !quantity_sold || sale_price == null) return res.status(400).json({ error: 'Missing required fields' });
  const qty = parseInt(quantity_sold) || 1;
  const sp  = parseFloat(sale_price)  || 0;
  const cp  = parseFloat(cost_price)  || 0;
  const profit = (sp - cp) * qty;
  const vals = [product_id||null, product_name, qty, sp, cp, profit, notes||null, payment_method||null];
  let result;
  if (sold_at) {
    result = db.prepare('INSERT INTO sales (product_id,product_name,quantity_sold,sale_price,cost_price,profit,notes,payment_method,sold_at) VALUES (?,?,?,?,?,?,?,?,?)').run([...vals, sold_at]);
  } else {
    result = db.prepare('INSERT INTO sales (product_id,product_name,quantity_sold,sale_price,cost_price,profit,notes,payment_method) VALUES (?,?,?,?,?,?,?,?)').run(vals);
  }
  let sold_out = false;
  if (product_id) {
    const prod = db.prepare('SELECT quantity FROM products WHERE id=?').get([product_id]);
    if (prod) {
      const newQty = Math.max(0, (prod.quantity||0) - qty);
      const newStock = newQty === 0 ? 'out_stock' : newQty <= 5 ? 'low_stock' : 'in_stock';
      db.prepare('UPDATE products SET quantity=?,stock=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run([newQty, newStock, product_id]);
      sold_out = newQty === 0;
    }
  }
  res.json({ id: result.lastInsertRowid, sold_out });
});

app.delete('/api/admin/sales/:id', auth, (req, res) => {
  db.prepare('DELETE FROM sales WHERE id=?').run([req.params.id]);
  res.json({ success: true });
});

// ─── RESTOCKS ────────────────────────────────────────────────────────────────
app.get('/api/admin/restocks/:productId', auth, (req, res) => {
  res.json(db.prepare('SELECT * FROM restocks WHERE product_id=? ORDER BY restocked_at DESC').all([req.params.productId]));
});

app.post('/api/admin/restocks', auth, (req, res) => {
  const { product_id, product_name, quantity_added, cost_per_unit, notes, restocked_at, update_cost } = req.body;
  if (!product_id || !quantity_added) return res.status(400).json({ error: 'Missing fields' });
  const qty = parseInt(quantity_added) || 0;
  const cpu = parseFloat(cost_per_unit) || null;
  const vals = [product_id, product_name||'', qty, cpu, notes||null];
  let result;
  if (restocked_at) {
    result = db.prepare('INSERT INTO restocks (product_id,product_name,quantity_added,cost_per_unit,notes,restocked_at) VALUES (?,?,?,?,?,?)').run([...vals, restocked_at]);
  } else {
    result = db.prepare('INSERT INTO restocks (product_id,product_name,quantity_added,cost_per_unit,notes) VALUES (?,?,?,?,?)').run(vals);
  }
  const prod = db.prepare('SELECT quantity, cost_price FROM products WHERE id=?').get([product_id]);
  if (prod) {
    const oldQty = prod.quantity || 0;
    const newQty = oldQty + qty;
    const newStock = newQty > 5 ? 'in_stock' : newQty > 0 ? 'low_stock' : 'out_stock';
    if (cpu) {
      // Weighted average cost
      const avgCost = (oldQty > 0 && prod.cost_price)
        ? ((oldQty * prod.cost_price) + (qty * cpu)) / newQty
        : cpu;
      db.prepare('UPDATE products SET quantity=?,stock=?,cost_price=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run([newQty, newStock, avgCost, product_id]);
    } else {
      db.prepare('UPDATE products SET quantity=?,stock=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run([newQty, newStock, product_id]);
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
  const s   = db.prepare(`SELECT COALESCE(SUM(sale_price*quantity_sold),0) as revenue, COALESCE(SUM(cost_price*quantity_sold),0) as cogs, COALESCE(SUM(profit),0) as gross_profit, COUNT(*) as transactions FROM sales ${sw}`).get(sp);
  const e   = db.prepare(`SELECT COALESCE(SUM(amount),0) as total FROM expenses ${ew}`).get(ep);
  const eCat= db.prepare(`SELECT category, COALESCE(SUM(amount),0) as total FROM expenses ${ew} GROUP BY category ORDER BY total DESC`).all(ep);
  const inv = db.prepare('SELECT COALESCE(SUM(quantity*COALESCE(cost_price,0)),0) as value FROM products WHERE quantity>0').get();
  const top = db.prepare(`SELECT product_name, SUM(quantity_sold) as units, SUM(sale_price*quantity_sold) as revenue, SUM(profit) as profit FROM sales ${sw} GROUP BY product_id,product_name ORDER BY revenue DESC LIMIT 5`).all(sp);
  res.json({ revenue: s.revenue, cogs: s.cogs, gross_profit: s.gross_profit, transactions: s.transactions, total_expenses: e.total, net_profit: s.gross_profit - e.total, inventory_value: inv.value, expense_breakdown: eCat, top_products: top });
});

// ─── START ───────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n✅ Inventory Site v2 running at http://localhost:${PORT}`);
  console.log(`   Admin panel: http://localhost:${PORT}/admin.html`);
  console.log(`   Admin password: ${ADMIN_PASSWORD}\n`);
});
