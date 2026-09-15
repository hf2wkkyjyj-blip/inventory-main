// ─── EMAIL SCRAPER ───────────────────────────────────────────────────────────
// Connects to Gmail via IMAP, finds order/shipping emails, updates bot_orders.
// Requires env vars: GMAIL_USER, GMAIL_APP_PASSWORD
// Setup: Google Account → Security → App Passwords → create one for "Railway"

const Imap        = require('node-imap');
const { simpleParser } = require('mailparser');

// ── Carrier / order detection ─────────────────────────────────────────────────

function findTracking(text) {
  if (!text) return null;
  const checks = [
    /\b(1Z[A-Z0-9]{16})\b/,       // UPS
    /\b(876\d{9})\b/,              // Narvar (Pokemon Center)
    /\b(9[24]\d{18,22})\b/,        // USPS
    /\b(96\d{20})\b/,              // FedEx
  ];
  for (const p of checks) {
    const m = text.match(p);
    if (m) return m[1];
  }
  return null;
}

function findOrderNumber(text, fromEmail) {
  const from = (fromEmail || '').toLowerCase();
  // Pokemon Center uses P-format
  if (from.includes('pokemon') || from.includes('narvar') || from.includes('shopify')) {
    const m = text.match(/\b(P\d{9,12})\b/);
    if (m) return m[1];
  }
  // Bear Walker / generic Shopify
  const generic = text.match(/[Oo]rder\s*[#№]?\s*([A-Z0-9-]{4,20})/);
  if (generic) return generic[1].trim();
  return null;
}

function determineStatus(subject, bodyText) {
  const s = ((subject || '') + ' ' + (bodyText || '')).toLowerCase();
  if (s.includes('delivered'))                                  return 'Delivered';
  if (s.includes('out for delivery'))                           return 'Shipped'; // treat OFD as Shipped
  if (s.includes('shipped') || s.includes('on its way') ||
      s.includes('tracking number') || s.includes('in transit')) return 'Shipped';
  if (s.includes('order confirmed') || s.includes('thank you for your order') ||
      s.includes('order received') || s.includes('order #'))    return 'Confirmed';
  if (s.includes('cancel'))                                     return 'Cancelled';
  if (s.includes('refund'))                                     return 'Refunded';
  return null;
}

function getRetailerInfo(fromEmail) {
  const f = (fromEmail || '').toLowerCase();
  if (f.includes('pokemon') || f.includes('narvar'))  return { retailer: 'Pokemon Center', category: 'Pokemon' };
  if (f.includes('bearwalker') || f.includes('bear-walker')) return { retailer: 'Bear Walker', category: 'One Piece' };
  if (f.includes('target'))    return { retailer: 'Target',    category: 'Other' };
  if (f.includes('walmart'))   return { retailer: 'Walmart',   category: 'Other' };
  if (f.includes('gamestop'))  return { retailer: 'GameStop',  category: 'Other' };
  if (f.includes('bestbuy') || f.includes('best buy')) return { retailer: 'Best Buy', category: 'Other' };
  if (f.includes('amazon'))    return { retailer: 'Amazon',    category: 'Other' };
  if (f.includes('shopify') || f.includes('shopifyemail')) return { retailer: 'Shopify Store', category: 'Other' };
  return null;
}

const STATUS_RANK = { Confirmed:1, Unship:1, Shipped:2, Delivered:3, Cancelled:4, Refunded:4 };

// ── Process a single parsed email ─────────────────────────────────────────────

async function processEmail(parsed, db) {
  const fromEmail = parsed.from?.value?.[0]?.address || '';
  const subject   = parsed.subject || '';
  const bodyText  = parsed.text    || '';
  const bodyHtml  = parsed.html    || '';
  const fullText  = bodyText + ' ' + bodyHtml;

  const retailerInfo = getRetailerInfo(fromEmail);
  if (!retailerInfo) return false;

  const tracking    = findTracking(fullText);
  const orderNumber = findOrderNumber(fullText, fromEmail);
  const status      = determineStatus(subject, bodyText);

  if (!orderNumber && !tracking) return false;

  console.log(`   📧 ${fromEmail} | order=${orderNumber||'?'} tracking=${tracking||'?'} status=${status||'?'}`);

  // Find existing order
  let existing = null;
  if (orderNumber) existing = db.prepare('SELECT * FROM bot_orders WHERE order_number=?').get([orderNumber]);
  if (!existing && tracking) existing = db.prepare('SELECT * FROM bot_orders WHERE tracking=?').get([tracking]);

  if (existing) {
    const curRank = STATUS_RANK[existing.status] || 0;
    const newRank = STATUS_RANK[status]           || 0;
    const updates = []; const vals = [];

    if (tracking && !existing.tracking) { updates.push('tracking=?'); vals.push(tracking); }
    if (status && newRank > curRank)    { updates.push('status=?');   vals.push(status); }
    if (status === 'Delivered') {
      updates.push('delivered_date=?');
      vals.push(new Date().toISOString().split('T')[0]);
    }

    if (updates.length) {
      db.prepare(`UPDATE bot_orders SET ${updates.join(',')} WHERE id=?`).run([...vals, existing.id]);
      console.log(`   ✅ Updated #${existing.order_number}: ${updates.join(', ')}`);
      return true;
    }
  } else if (orderNumber && status) {
    // Insert new order
    const { retailer, category } = retailerInfo;
    const receivedAt = parsed.date ? parsed.date.toISOString() : new Date().toISOString();
    db.prepare(`INSERT OR IGNORE INTO bot_orders
      (category, retailer, order_number, tracking, status, received_at, created_at)
      VALUES (?,?,?,?,?,?,CURRENT_TIMESTAMP)`)
      .run([category, retailer, orderNumber, tracking||null, status, receivedAt]);
    console.log(`   ➕ New order: ${orderNumber} (${retailer}) — ${status}`);
    return true;
  }
  return false;
}

// ── IMAP fetch + parse ────────────────────────────────────────────────────────

function fetchAndProcess(imap, criteria, db) {
  return new Promise((resolve, reject) => {
    imap.openBox('INBOX', true, (err) => {
      if (err) return reject(err);
      imap.search(criteria, (err, uids) => {
        if (err) return reject(err);
        if (!uids || !uids.length) return resolve(0);

        // Only take the most recent 60 to avoid huge fetches
        const batch = uids.slice(-60);
        const f = imap.fetch(batch, { bodies: '' });
        const jobs = [];

        f.on('message', (msg) => {
          let raw = '';
          msg.on('body', stream => stream.on('data', c => raw += c.toString()));
          msg.once('end', () => {
            jobs.push(
              simpleParser(raw)
                .then(parsed => processEmail(parsed, db))
                .catch(e => console.log('   ⚠️  parse error:', e.message))
            );
          });
        });

        f.once('error', reject);
        f.once('end', () => Promise.all(jobs).then(results => resolve(results.filter(Boolean).length)));
      });
    });
  });
}

// ── Main entry point ──────────────────────────────────────────────────────────

async function runEmailScraper(db) {
  if (!process.env.GMAIL_USER || !process.env.GMAIL_APP_PASSWORD) {
    console.log('⚠️  Email scraper: GMAIL_USER / GMAIL_APP_PASSWORD not set — skipping');
    return 0;
  }

  console.log('\n📧 Email scraper started...');

  const imap = new Imap({
    user:       process.env.GMAIL_USER,
    password:   process.env.GMAIL_APP_PASSWORD,
    host:       'imap.gmail.com',
    port:       993,
    tls:        true,
    tlsOptions: { rejectUnauthorized: false },
    connTimeout: 15000,
    authTimeout: 10000,
  });

  return new Promise((resolve) => {
    imap.once('ready', async () => {
      try {
        const since = new Date(Date.now() - 48 * 60 * 60 * 1000); // last 48h

        // Search criteria: known senders OR shipping-related subjects
        const criteria = ['ALL',
          ['SINCE', since],
          ['OR',
            ['OR',
              ['OR', ['FROM', 'pokemoncenter.com'], ['FROM', 'bearwalker.com']],
              ['OR', ['FROM', 'shopifyemail.com'],  ['FROM', 'target.com']]
            ],
            ['OR',
              ['SUBJECT', 'shipped'],
              ['SUBJECT', 'order confirmed']
            ]
          ]
        ];

        const updated = await fetchAndProcess(imap, criteria, db);
        console.log(`📧 Email scraper done: ${updated} order(s) created/updated\n`);
        resolve(updated);
      } catch (e) {
        console.error('📧 Email scraper error:', e.message);
        resolve(0);
      } finally {
        try { imap.end(); } catch(_) {}
      }
    });

    imap.once('error', e => {
      console.error('📧 IMAP error:', e.message);
      resolve(0);
    });

    imap.connect();
  });
}

module.exports = { runEmailScraper };
