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

// Detect category from email content (for generic retailers like Target that sell everything)
function detectCategoryFromContent(subject, text, defaultCategory) {
  const s = ((subject || '') + ' ' + (text || '')).toLowerCase();
  if (s.includes('pokemon') || s.includes('pikachu') || s.includes('charizard') ||
      s.includes('eevee') || s.includes('mewtwo') || s.includes('bulbasaur') ||
      s.includes('squirtle') || s.includes('charmander') || s.includes('tcg') ||
      s.includes('poke ball') || s.includes('pokeball'))
    return 'Pokemon';
  if (s.includes('one piece') || s.includes('luffy') || s.includes('zoro') ||
      s.includes('nami') || s.includes('sanji') || s.includes('chopper'))
    return 'One Piece';
  if (s.includes('mattel') || s.includes('hot wheel') || s.includes('barbie') ||
      s.includes('fisher-price') || s.includes('fisher price') || s.includes('uno '))
    return 'Mattel';
  return defaultCategory;
}

// ── Extraction helpers ────────────────────────────────────────────────────────

// Strip HTML tags, adding spaces between block elements so words don't run together
function stripHtml(html) {
  if (!html) return '';
  return html
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<\/?(p|div|li|tr|td|th|h[1-6]|section|article|header|footer|span)[^>]*>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#\d+;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

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
  if (!text) return null;
  const f = (fromEmail || '').toLowerCase();

  // Pokemon Center P-format (always starts with P followed by digits)
  if (f.includes('pokemon') || f.includes('narvar')) {
    const m = text.match(/\b(P\d{9,12})\b/);
    if (m) return m[1];
  }

  // Target bare 15-digit or hyphenated format — try this FIRST for target emails
  // because generic "Order" text in Target emails always matches junk words first
  if (f.includes('target.com')) {
    const t = text.match(/\b(\d{3}-\d{7}-\d{7}|\d{15})\b/);
    if (t) return t[1].trim();
  }

  // Generic: scan ALL "Order #..." matches and return first one with 3+ consecutive digits.
  // This skips false positives like "Order Summary" → "Summary", "Your Order" → "Your", CSS "16px".
  const re = /[Oo]rder\s*(?:[#№]|[Nn](?:umber|o\.?)?)?[:\s]+([A-Z0-9][\w\-]{3,24})/g;
  for (const m of text.matchAll(re)) {
    if (/\d{3,}/.test(m[1])) return m[1].trim();
  }

  // Fallback: bare 15-digit or Amazon-style hyphenated number anywhere in text
  const t = text.match(/\b(\d{3}-\d{7}-\d{7}|\d{15})\b/);
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
  if (s.includes('cancel'))  return 'Cancelled';
  if (s.includes('refund'))  return 'Refunded';
  if (s.includes('delivered') && !s.includes('estimated') && !s.includes('expected') && !s.includes('delivery date') && !s.includes('delivery by'))
    return 'Delivered';
  if (s.includes('out for delivery'))
    return 'OFD';
  if (s.includes('shipped')        || s.includes('on its way')       || s.includes('tracking number') ||
      s.includes('in transit')     || s.includes('has been shipped')  || s.includes('your order has left') ||
      s.includes('your package')   || s.includes('order shipped')     || s.includes('is on the way'))
    return 'Shipped';
  if (s.includes('order confirmed')        || s.includes('thank you for your order') ||
      s.includes('order received')         || s.includes('we received your order')   ||
      s.includes('thanks for shopping')    || s.includes('thanks for your order')    ||
      s.includes('is confirmed')           || s.includes('we got your order')        ||
      s.includes("we've got your order")   || s.includes('your order is placed')     ||
      s.includes('order is being prepared')|| s.includes('order #')                  ||
      s.includes('your recent order'))
    return 'Confirmed';
  return null;
}

// ── DB update logic ───────────────────────────────────────────────────────────

const STATUS_RANK = { Confirmed:1, Unship:1, Shipped:2, OFD:3, Delivered:4, Cancelled:5, Refunded:5 };

async function processEmail(parsed, db) {
  const fromEmail  = parsed.from?.value?.[0]?.address || '';
  const subject    = parsed.subject || '';
  const bodyText   = parsed.text    || '';
  const bodyHtml   = parsed.html    || '';
  // Use HTML-stripped text as fallback — Target and many retailers send HTML-only emails
  const strippedHtml = stripHtml(bodyHtml);
  const plainText    = bodyText || strippedHtml;   // best plain text we have
  const fullText     = plainText + ' ' + bodyHtml; // raw HTML included for regex searches

  const retailerInfo = getRetailerInfo(fromEmail);
  if (!retailerInfo) return false;

  const tracking    = findTracking(fullText);
  const orderNumber = findOrderNumber(fullText, fromEmail);
  const rawStatus   = determineStatus(subject, plainText);  // use stripped text, not raw HTML
  const expectedDate= findExpectedDate(plainText);

  if (!orderNumber && !tracking) return false;

  // If we found an order number but couldn't determine status, assume Confirmed
  const resolvedStatus = rawStatus || (orderNumber ? 'Confirmed' : null);

  const dbStatus = resolvedStatus === 'OFD' ? 'Shipped' : resolvedStatus;
  const trackingStatus = resolvedStatus === 'OFD' ? 'OFD' : (resolvedStatus === 'Delivered' ? 'Delivered' : null);

  console.log(`   📧 ${retailerInfo.retailer} | order=${orderNumber||'?'} tracking=${tracking||'?'} status=${resolvedStatus||'?'}${expectedDate?' exp='+expectedDate:''}`);

  // Find existing record
  let existing = null;
  if (orderNumber) existing = db.prepare('SELECT * FROM bot_orders WHERE order_number=?').get([orderNumber]);
  if (!existing && tracking) existing = db.prepare('SELECT * FROM bot_orders WHERE tracking=?').get([tracking]);

  if (existing) {
    const curRank = STATUS_RANK[existing.status]    || 0;
    const newRank = STATUS_RANK[resolvedStatus]     || 0;
    const updates = []; const vals = [];

    if (tracking && !existing.tracking)  { updates.push('tracking=?');        vals.push(tracking); }
    if (expectedDate)                    { updates.push('expected_date=?');    vals.push(expectedDate); }
    if (trackingStatus)                  { updates.push('tracking_status=?');  vals.push(trackingStatus); }
    if (resolvedStatus === 'Delivered') {
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
    // Check blocklist — don't recreate manually-deleted orders
    try {
      const raw = db.prepare("SELECT value FROM settings WHERE key='scraper_blocked_orders'").get();
      const blocked = raw ? JSON.parse(raw.value) : [];
      if (blocked.includes(orderNumber)) {
        console.log(`   🚫 Skipped blocked order #${orderNumber}`);
        return false;
      }
    } catch(_) {}
    // Create new order — detect category from email content for generic retailers
    const { retailer } = retailerInfo;
    const category = detectCategoryFromContent(subject, plainText, retailerInfo.category);
    const emailDate   = parsed.date ? parsed.date.toISOString() : new Date().toISOString();
    const orderDate   = emailDate.split('T')[0];   // YYYY-MM-DD for proper sort
    db.prepare(`INSERT OR IGNORE INTO bot_orders
      (category, retailer, order_number, tracking, status, tracking_status, expected_date, order_date, received_at, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)`)
      .run([category, retailer, orderNumber, tracking||null, dbStatus, trackingStatus||null, expectedDate||null, orderDate, emailDate]);
    console.log(`   ➕ New: ${orderNumber} (${retailer}) — ${rawStatus}${expectedDate?' exp '+expectedDate:''}`);
    return true;
  }
  return false;
}

// ── Settings helpers (uses existing settings table in DB) ────────────────────

function getSetting(db, key, def) {
  try {
    const row = db.prepare('SELECT value FROM settings WHERE key=?').get([key]);
    return row ? row.value : def;
  } catch(_) { return def; }
}
function setSetting(db, key, value) {
  try {
    db.prepare('INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)').run([key, String(value)]);
  } catch(_) {}
}

// ── IMAP fetch — ALL emails since last run, deduplicated by Message-ID ───────
// Does NOT rely on UNSEEN flag, so works even if you've read the email on your phone.

function formatImapDate(d) {
  // IMAP SINCE wants "1-Jan-2026" format
  return d.getDate() + '-' + ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][d.getMonth()] + '-' + d.getFullYear();
}

function fetchNewAndProcess(imap, db) {
  return new Promise((resolve, reject) => {
    // Read-only — we track what's been processed ourselves, don't touch read/unread
    imap.openBox('INBOX', true, (err) => {
      if (err) return reject(err);

      // Load seen Message-IDs from DB
      const seenRaw = getSetting(db, 'email_scraper_seen_ids', '[]');
      let seenIds;
      try { seenIds = new Set(JSON.parse(seenRaw)); } catch(_) { seenIds = new Set(); }

      // Search since last run date (default: 30 days ago on first run)
      const sinceStr  = getSetting(db, 'email_scraper_since', null);
      const sinceDate = sinceStr ? new Date(sinceStr) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      const imapDate  = formatImapDate(sinceDate);

      console.log(`   Searching emails since ${imapDate}…`);

      imap.search([['SINCE', imapDate]], (err, uids) => {
        if (err) return reject(err);
        if (!uids || !uids.length) {
          console.log('   No emails in range.');
          // Advance the since date so next run doesn't re-scan old range
          setSetting(db, 'email_scraper_since', new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString());
          return resolve(0);
        }

        console.log(`   Found ${uids.length} email(s) in range, checking for new ones…`);

        const f    = imap.fetch(uids, { bodies: '' });
        const jobs = [];
        const newIds = [];

        f.on('message', (msg) => {
          let raw = '';
          msg.on('body', stream => stream.on('data', c => raw += c.toString()));
          msg.once('end', () => {
            jobs.push(
              simpleParser(raw).then(async parsed => {
                const msgId = parsed.messageId || null;
                // Skip already-processed emails
                if (msgId && seenIds.has(msgId)) return false;
                const result = await processEmail(parsed, db);
                // Only mark as seen AFTER successful processing (so failed emails get retried next run)
                if (msgId && result !== false) newIds.push(msgId);
                return result;
              }).catch(e => { console.log('   ⚠️  parse error:', e.message); return false; })
            );
          });
        });

        f.once('error', reject);
        f.once('end', () =>
          Promise.all(jobs).then(results => {
            // Persist updated seen-IDs (keep last 3000 to avoid unbounded growth)
            newIds.forEach(id => seenIds.add(id));
            const arr = [...seenIds];
            setSetting(db, 'email_scraper_seen_ids', JSON.stringify(arr.slice(-3000)));
            // Advance since date (keep 2-day buffer so timezone edge cases don't miss anything)
            setSetting(db, 'email_scraper_since', new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString());
            const updated = results.filter(Boolean).length;
            console.log(`   Processed ${newIds.length} new email(s), ${updated} order(s) updated.`);
            resolve(updated);
          })
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
        const updated = await fetchNewAndProcess(imap, db);
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

// ── Reset scraper state — forces full re-scan on next run ────────────────────
function resetEmailScraper(db) {
  setSetting(db, 'email_scraper_seen_ids', '[]');
  setSetting(db, 'email_scraper_since', new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString());
  console.log('📧 Email scraper state reset — next run will re-scan 30 days');
}

module.exports = { runEmailScraper, scrapeByOrderNumber, resetEmailScraper };
