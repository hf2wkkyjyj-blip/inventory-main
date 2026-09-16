// ─── EMAIL SCRAPER ───────────────────────────────────────────────────────────
// Reads UNSEEN emails only, marks them read after processing so they're
// never double-processed. No carrier website calls — status comes from
// retailer emails: Shipped → OFD → Delivered.

const Imap             = require('node-imap');
const { simpleParser } = require('mailparser');

// ── Retailer detection ────────────────────────────────────────────────────────

const RETAILERS = [
  { match: ['pokemoncenter.com','narvar.com'],        retailer: 'Pokemon Center', category: 'Pokemon'   },
  { match: ['bearwalker.com','bear-walker.com'],      retailer: 'Bear Walker',   category: 'One Piece'  },
  { match: ['shopifyemail.com','myshopify.com'],      retailer: 'Shopify Store', category: 'Other'      },
  { match: ['target.com'],                            retailer: 'Target',        category: 'Other'      },
  { match: ['walmart.com'],                           retailer: 'Walmart',       category: 'Other'      },
  { match: ['gamestop.com'],                          retailer: 'GameStop',      category: 'Other'      },
  { match: ['bestbuy.com'],                           retailer: 'Best Buy',      category: 'Other'      },
  { match: ['amazon.com','amazon-hq.com'],            retailer: 'Amazon',        category: 'Other'      },
];

function getRetailerInfo(fromEmail) {
  const f = (fromEmail || '').toLowerCase();
  for (const r of RETAILERS) {
    if (r.match.some(m => f.includes(m))) return r;
  }
  return null;
}

// ── Extraction helpers ────────────────────────────────────────────────────────

function findTracking(text) {
  if (!text) return null;
  const patterns = [
    /\b(1Z[A-Z0-9]{16})\b/,         // UPS
    /\b(876\d{9})\b/,                // Narvar / Pokemon Center
    /\b(9[24]\d{18,22})\b/,          // USPS
    /\b(96\d{20})\b/,                // FedEx ground
    /\b(61\d{18})\b/,                // FedEx SmartPost
  ];
  for (const p of patterns) {
    const m = text.match(p);
    if (m) return m[1];
  }
  return null;
}

function findOrderNumber(text, fromEmail) {
  const f = (fromEmail || '').toLowerCase();
  // Pokemon Center P-format
  if (f.includes('pokemon') || f.includes('narvar') || f.includes('shopify')) {
    const m = text.match(/\b(P\d{9,12})\b/);
    if (m) return m[1];
  }
  // Generic: "Order #12345", "Order Number: ABC-123", "Order: 102-123-456", "Order 102-123-456"
  const g = text.match(/[Oo]rder\s*(?:[#№]|[Nn](?:umber|o\.?)?)?[:\s]+([A-Z0-9][\w\-]{3,24})/);
  if (g) return g[1].trim();
  // Also catch Target-style "102-XXXXXXX-XXXXXXX" bare patterns
  const t = text.match(/\b(\d{3}-\d{7}-\d{7})\b/);
  if (t) return t[1].trim();
  return null;
}

// Extract expected/estimated delivery date from email body
function findExpectedDate(text) {
  if (!text) return null;
  const patterns = [
    // "Expected delivery: Tuesday, September 22, 2026"
    /(?:expected|estimated|scheduled|arriving?|delivery\s+by)[:\s]+(?:[A-Za-z]+,?\s+)?([A-Za-z]+\.?\s+\d{1,2},?\s+\d{4})/i,
    // "by Tuesday, Sep 22"
    /\bby\s+(?:[A-Za-z]+,?\s+)?([A-Za-z]+\.?\s+\d{1,2}(?:,?\s+\d{4})?)/i,
    // MM/DD/YYYY or YYYY-MM-DD
    /(?:expected|estimated|delivery)[:\s]+(\d{1,2}\/\d{1,2}\/\d{4})/i,
    /(?:expected|estimated|delivery)[:\s]+(\d{4}-\d{2}-\d{2})/i,
  ];
  for (const p of patterns) {
    const m = text.match(p);
    if (m) {
      try {
        // Try parsing — append current year if missing
        let str = m[1].trim();
        if (!/\d{4}/.test(str)) str += `, ${new Date().getFullYear()}`;
        const d = new Date(str);
        if (!isNaN(d)) return d.toISOString().split('T')[0];
      } catch(_) {}
    }
  }
  return null;
}

// Determine order status from email subject + body
// Returns: 'Confirmed' | 'Shipped' | 'OFD' | 'Delivered' | 'Cancelled' | 'Refunded' | null
function determineStatus(subject, bodyText) {
  const s = ((subject || '') + ' ' + (bodyText || '')).toLowerCase();
  if (s.includes('delivered') && !s.includes('estimated') && !s.includes('expected'))
    return 'Delivered';
  if (s.includes('out for delivery'))
    return 'OFD';
  if (s.includes('shipped') || s.includes('on its way') || s.includes('tracking number') ||
      s.includes('in transit') || s.includes('has been shipped'))
    return 'Shipped';
  if (s.includes('order confirmed') || s.includes('thank you for your order') ||
      s.includes('order received') || s.includes('we received your order'))
    return 'Confirmed';
  if (s.includes('cancel'))  return 'Cancelled';
  if (s.includes('refund'))  return 'Refunded';
  return null;
}

// ── DB update logic ───────────────────────────────────────────────────────────

const STATUS_RANK = { Confirmed:1, Unship:1, Shipped:2, OFD:3, Delivered:4, Cancelled:5, Refunded:5 };

async function processEmail(parsed, db) {
  const fromEmail  = parsed.from?.value?.[0]?.address || '';
  const subject    = parsed.subject || '';
  const bodyText   = parsed.text    || '';
  const bodyHtml   = parsed.html    || '';
  const fullText   = bodyText + ' ' + bodyHtml;

  const retailerInfo = getRetailerInfo(fromEmail);
  if (!retailerInfo) return false;

  const tracking    = findTracking(fullText);
  const orderNumber = findOrderNumber(fullText, fromEmail);
  const rawStatus   = determineStatus(subject, bodyText);
  const expectedDate= findExpectedDate(bodyText);

  if (!orderNumber && !tracking) return false;

  const dbStatus = rawStatus === 'OFD' ? 'Shipped' : rawStatus; // DB status stays Shipped, tracking_status = OFD
  const trackingStatus = rawStatus === 'OFD' ? 'OFD' : (rawStatus === 'Delivered' ? 'Delivered' : null);

  console.log(`   📧 ${retailerInfo.retailer} | order=${orderNumber||'?'} tracking=${tracking||'?'} status=${rawStatus||'?'}${expectedDate?' exp='+expectedDate:''}`);

  // Find existing record
  let existing = null;
  if (orderNumber) existing = db.prepare('SELECT * FROM bot_orders WHERE order_number=?').get([orderNumber]);
  if (!existing && tracking) existing = db.prepare('SELECT * FROM bot_orders WHERE tracking=?').get([tracking]);

  if (existing) {
    const curRank = STATUS_RANK[existing.status] || 0;
    const newRank = STATUS_RANK[rawStatus]        || 0;
    const updates = []; const vals = [];

    if (tracking && !existing.tracking)  { updates.push('tracking=?');        vals.push(tracking); }
    if (expectedDate)                    { updates.push('expected_date=?');    vals.push(expectedDate); }
    if (trackingStatus)                  { updates.push('tracking_status=?');  vals.push(trackingStatus); }
    if (rawStatus === 'Delivered') {
      updates.push('delivered_date=?');  vals.push(new Date().toISOString().split('T')[0]);
      updates.push('expected_date=?');   vals.push(null); // clear expected once delivered
    }
    if (dbStatus && newRank > curRank)   { updates.push('status=?');           vals.push(dbStatus); }

    if (updates.length) {
      db.prepare(`UPDATE bot_orders SET ${updates.join(',')} WHERE id=?`).run([...vals, existing.id]);
      console.log(`   ✅ Updated #${existing.order_number}: ${updates.map((u,i)=>u.split('=')[0]+'='+vals[i]).join(', ')}`);
      return true;
    }
  } else if (orderNumber && dbStatus) {
    // Create new order
    const { retailer, category } = retailerInfo;
    const receivedAt = parsed.date ? parsed.date.toISOString() : new Date().toISOString();
    db.prepare(`INSERT OR IGNORE INTO bot_orders
      (category, retailer, order_number, tracking, status, tracking_status, expected_date, received_at, created_at)
      VALUES (?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)`)
      .run([category, retailer, orderNumber, tracking||null, dbStatus, trackingStatus||null, expectedDate||null, receivedAt]);
    console.log(`   ➕ New: ${orderNumber} (${retailer}) — ${rawStatus}${expectedDate?' exp '+expectedDate:''}`);
    return true;
  }
  return false;
}

// ── IMAP fetch — UNSEEN only, mark read after ─────────────────────────────────

function fetchUnseenAndProcess(imap, db) {
  return new Promise((resolve, reject) => {
    // Read-write so we can mark emails as seen
    imap.openBox('INBOX', false, (err) => {
      if (err) return reject(err);

      // Only UNSEEN emails — never reprocesses the same email twice
      imap.search(['UNSEEN'], (err, uids) => {
        if (err) return reject(err);
        if (!uids || !uids.length) {
          console.log('   No new emails.');
          return resolve(0);
        }

        console.log(`   Found ${uids.length} unread email(s), filtering for orders…`);

        // Fetch with markSeen:true — marks as read so next run skips them
        const f = imap.fetch(uids, { bodies: '', markSeen: true });
        const jobs = [];

        f.on('message', (msg) => {
          let raw = '';
          msg.on('body', stream => stream.on('data', c => raw += c.toString()));
          msg.once('end', () => {
            jobs.push(
              simpleParser(raw)
                .then(parsed => processEmail(parsed, db))
                .catch(e => { console.log('   ⚠️  parse error:', e.message); return false; })
            );
          });
        });

        f.once('error', reject);
        f.once('end', () =>
          Promise.all(jobs).then(results => resolve(results.filter(Boolean).length))
        );
      });
    });
  });
}

// ── Main entry ────────────────────────────────────────────────────────────────

async function runEmailScraper(db) {
  if (!process.env.GMAIL_USER || !process.env.GMAIL_APP_PASSWORD) {
    console.log('⚠️  Email scraper: set GMAIL_USER + GMAIL_APP_PASSWORD in Railway vars');
    return 0;
  }

  console.log('\n📧 Email scraper started…');

  const imap = new Imap({
    user:        process.env.GMAIL_USER,
    password:    process.env.GMAIL_APP_PASSWORD,
    host:        'imap.gmail.com',
    port:        993,
    tls:         true,
    tlsOptions:  { rejectUnauthorized: false },
    connTimeout: 20000,
    authTimeout: 10000,
  });

  return new Promise((resolve) => {
    imap.once('ready', async () => {
      try {
        const updated = await fetchUnseenAndProcess(imap, db);
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

// ── Scan a specific order number — searches ALL Gmail, not just UNSEEN ────────

function fetchByOrderNumber(imap, orderNumber, db) {
  return new Promise((resolve, reject) => {
    imap.openBox('INBOX', true, (err) => {
      if (err) return reject(err);

      // TEXT searches headers + body — catches order number anywhere in the email
      imap.search([['TEXT', orderNumber]], (err, uids) => {
        if (err) return reject(err);
        if (!uids || !uids.length) {
          console.log(`   No emails found for order #${orderNumber}`);
          return resolve({ found: 0, updated: 0 });
        }

        console.log(`   Found ${uids.length} email(s) for order #${orderNumber}`);
        const f = imap.fetch(uids, { bodies: '' }); // read-only, don't mark seen
        const jobs = [];

        f.on('message', (msg) => {
          let raw = '';
          msg.on('body', stream => stream.on('data', c => raw += c.toString()));
          msg.once('end', () => {
            jobs.push(
              simpleParser(raw)
                .then(parsed => processEmail(parsed, db))
                .catch(e => { console.log('   ⚠️  parse error:', e.message); return false; })
            );
          });
        });

        f.once('error', reject);
        f.once('end', () =>
          Promise.all(jobs).then(results => resolve({
            found: uids.length,
            updated: results.filter(Boolean).length
          }))
        );
      });
    });
  });
}

async function scrapeByOrderNumber(db, orderNumber) {
  if (!process.env.GMAIL_USER || !process.env.GMAIL_APP_PASSWORD) return { error: 'GMAIL env vars not set' };
  if (!orderNumber) return { error: 'No order number provided' };

  console.log(`\n📧 Order scan: searching Gmail for #${orderNumber}…`);

  const imap = new Imap({
    user:        process.env.GMAIL_USER,
    password:    process.env.GMAIL_APP_PASSWORD,
    host:        'imap.gmail.com',
    port:        993,
    tls:         true,
    tlsOptions:  { rejectUnauthorized: false },
    connTimeout: 20000,
    authTimeout: 10000,
  });

  return new Promise((resolve) => {
    imap.once('ready', async () => {
      try {
        const result = await fetchByOrderNumber(imap, orderNumber, db);
        console.log(`📧 Order scan done: ${result.found} email(s) found, ${result.updated} update(s)\n`);
        resolve(result);
      } catch(e) {
        console.error('📧 Order scan error:', e.message);
        resolve({ error: e.message });
      } finally {
        try { imap.end(); } catch(_) {}
      }
    });

    imap.once('error', e => {
      console.error('📧 IMAP error:', e.message);
      resolve({ error: e.message });
    });

    imap.connect();
  });
}

module.exports = { runEmailScraper, scrapeByOrderNumber };
