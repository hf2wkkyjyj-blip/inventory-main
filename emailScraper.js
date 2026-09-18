// ─── EMAIL SCRAPER ───────────────────────────────────────────────────────────
// Reads UNSEEN emails only, marks them read after processing so they're
// never double-processed. No carrier website calls — status comes from
// retailer emails: Shipped → OFD → Delivered.

const Imap             = require('node-imap');
const { simpleParser } = require('mailparser');

// ── Retailer detection ────────────────────────────────────────────────────────

const RETAILERS = [
  { match: ['pokemoncenter.com'],                     retailer: 'Pokemon Center', category: 'Pokemon'   },
  { match: ['bearwalker.com','bear-walker.com'],      retailer: 'Bear Walker',   category: 'One Piece'  },
  { match: ['shopifyemail.com','myshopify.com'],      retailer: 'Shopify Store', category: 'Other'      },
  { match: ['target.com'],                            retailer: 'Target',        category: 'Other'      },
  { match: ['walmart.com'],                           retailer: 'Walmart',       category: 'Other'      },
  { match: ['gamestop.com'],                          retailer: 'GameStop',      category: 'Other'      },
  { match: ['bestbuy.com'],                           retailer: 'Best Buy',      category: 'Other'      },
  { match: ['amazon.com','amazon-hq.com'],            retailer: 'Amazon',        category: 'Other'      },
  // Narvar is a 3rd-party shipping service used by Target, PKC, and others.
  // Detect the actual retailer from the email body rather than the FROM address.
  { match: ['narvar.com'],                            retailer: 'narvar',        category: 'Other'      },
];

function getRetailerInfo(fromEmail, bodyText) {
  const f = (fromEmail || '').toLowerCase();
  for (const r of RETAILERS) {
    if (!r.match.some(m => f.includes(m))) continue;
    // Narvar: detect actual retailer from body content
    if (r.retailer === 'narvar') {
      const b = (bodyText || '').toLowerCase();
      if (b.includes('target.com') || b.includes('target.') || b.includes('for target'))
        return { retailer: 'Target',        category: 'Other'    };
      if (b.includes('pokemoncenter.com') || b.includes('pokemon center'))
        return { retailer: 'Pokemon Center', category: 'Pokemon'  };
      if (b.includes('walmart.com'))
        return { retailer: 'Walmart',        category: 'Other'    };
      if (b.includes('gamestop.com'))
        return { retailer: 'GameStop',       category: 'Other'    };
      // Unknown Narvar sender — treat as generic but still process
      return { retailer: 'Narvar',           category: 'Other'    };
    }
    return r;
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
  // Only use this for actual pokemoncenter.com emails, NOT narvar (narvar serves Target too)
  if (f.includes('pokemon') && !f.includes('narvar')) {
    const m = text.match(/\b(P\d{9,12})\b/);
    if (m) return m[1];
  }

  // Target order numbers: 15 OR 16 consecutive digits (Target uses both lengths)
  // Also handles narvar.com shipping notifications which embed the Target order number
  if (f.includes('target.com') || f.includes('narvar')) {
    const t = text.match(/\b(\d{3}-\d{7}-\d{7}|\d{15,16})\b/);
    if (t) return t[1].trim();
    // Also try Pokemon Center P-format in case it's a PKC order via Narvar
    const p = text.match(/\b(P\d{9,12})\b/);
    if (p) return p[1];
  }

  // Generic: scan ALL "Order #..." matches and return first one with 3+ consecutive digits.
  // This skips false positives like "Order Summary" → "Summary", "Your Order" → "Your", CSS "16px".
  const re = /[Oo]rder\s*(?:[#№]|[Nn](?:umber|o\.?)?)?[:\s]+([A-Z0-9][\w\-]{3,24})/g;
  for (const m of text.matchAll(re)) {
    if (/\d{3,}/.test(m[1])) return m[1].trim();
  }

  // Fallback: bare 15/16-digit number (Target) or Amazon-style hyphenated number
  const t = text.match(/\b(\d{3}-\d{7}-\d{7}|\d{15,16})\b/);
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
      s.includes('has been placed')        || s.includes('order confirmation')       ||
      s.includes('placed your order')      || s.includes('we have your order')       ||
      s.includes('order is being prepared')|| s.includes('order #')                  ||
      s.includes('your recent order'))
    return 'Confirmed';
  return null;
}

// ── Order detail extraction (items, prices, tax, shipping) ───────────────────

// Like stripHtml but preserves newlines at block-element boundaries.
// Used for item extraction where we need lines, not one big blob.
function htmlToLines(html) {
  if (!html) return '';
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/?(p|div|li|tr|td|th|h[1-6]|section|article|header|footer|table|tbody|thead)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&#\d+;/g, ' ')
    .replace(/[ \t]+/g, ' ')          // collapse horizontal whitespace only
    .replace(/\n[ \t]+/g, '\n')       // trim leading spaces on each line
    .replace(/[ \t]+\n/g, '\n')       // trim trailing spaces on each line
    .replace(/\n{3,}/g, '\n\n')       // at most 2 consecutive blank lines
    .trim();
}

// Parse a dollar amount from a string like "$43.52" or "43.52"
function parseDollar(s) {
  const m = String(s||'').match(/\$?([\d,]+\.?\d*)/);
  return m ? parseFloat(m[1].replace(/,/g,'')) : null;
}

// Extract order financial summary (subtotal, tax, shipping, total) from plain text.
// NOTE: text here is always a single collapsed line (stripHtml output) — no newlines.
function findOrderFinancials(text) {
  if (!text) return {};
  const result = {};
  // subtotal — "Subtotal (2 items) $39.98" or "Order Subtotal $159.95" or "Subtotal: $39.98"
  // [\s:]* handles ": ", " " separators; (?:\([^)]*\))? handles "(2 items)"-style annotations
  const subM = text.match(/(?:subtotal|item(?:s)?\s+total|merchandise\s+total)[\s:]*(?:\([^)]*\))?\s*\$?([\d,]+\.\d{2})/i);
  if (subM) result.subtotal = parseFloat(subM[1].replace(/,/g,''));
  // tax — "Estimated taxes $3.41", "Sales Tax $13.61", "Tax: $X"
  // [\s:]+ requires immediate colon/space separator (prevents spanning to other amounts)
  const taxM = text.match(/(?:estimated\s+)?(?:sales\s+)?tax(?:es)?[\s:]+\$?([\d,]+\.\d{2})/i);
  if (taxM) result.tax = parseFloat(taxM[1].replace(/,/g,''));
  // shipping / delivery:
  //   "Delivery Free" / "Shipping: Free" → shipping = 0
  //   "Shipping: $0.00" / "Retail Delivery Fee $0.50" → capture amount
  // [\s:]+ as separator prevents shipCostM from spanning across "Delivery Free ... $3.41"
  const shipFreeM = text.match(/(?:^|\s)(?:shipping|delivery)[\s:]+free/im);
  const shipCostM = text.match(/(?:retail\s+delivery(?:\s+fee)?|delivery(?:\s+fee)?|shipping)[\s:]+\$?([\d,]+\.\d{2})/i);
  if (shipFreeM && !shipCostM) result.shipping = 0;
  else if (shipCostM) result.shipping = parseFloat(shipCostM[1].replace(/,/g,''));
  // order total — "Order Total $43.39", "Grand Total $X", standalone "Total $43.39"
  // (?<!\w)total negative lookbehind prevents matching "Sub**total**"
  const totM = text.match(/(?:order\s+total|grand\s+total|total\s+charged)[\s:]*\$?([\d,]+\.\d{2})/i)
            || text.match(/(?<!\w)total[\s:]+\$?([\d,]+\.\d{2})/i);
  if (totM) result.total = parseFloat(totM[1].replace(/,/g,''));
  return result;
}

// Extract items from Target order confirmation HTML.
//
// Target email item structure (confirmed from real email):
//   [Product Name]
//   Qty: 2
//   $19.99 / ea
//   Arrives Sep 17, 2026 – Sep 22, 2026
//
// KEY INSIGHT: "Qty:" ONLY appears in actual item rows — never in the header,
// financial summary, payment section, or footer. So we anchor on "Qty:" and
// look one line back for the name and one line forward for the price.
// This is 100% reliable because no other section uses "Qty:".
function extractTargetItems(html) {
  if (!html) return [];

  const seen  = new Set();
  const items = [];

  const text  = htmlToLines(html);
  const lines = text.split(/[\n\r]+/).map(l => l.trim()).filter(Boolean);

  for (let i = 0; i < lines.length; i++) {
    // Anchor: "Qty: N" or "Quantity: N" — only exists in item rows
    const qtyMatch = lines[i].match(/^(?:qty|quantity)[:\s]+(\d+)$/i);
    if (!qtyMatch) continue;
    const qty = parseInt(qtyMatch[1]);
    if (qty < 1 || qty > 999) continue;

    // Item name: the nearest non-trivial line BEFORE the Qty line
    let name = null;
    for (let j = i - 1; j >= Math.max(0, i - 5); j--) {
      const l = lines[j];
      if (l.length < 5) continue;
      // Skip obvious non-name lines
      if (/^\$/.test(l)) continue;                       // price line
      if (/^(?:delivers to|shipping|qty|quantity)/i.test(l)) continue;
      if (/^\d+$/.test(l)) continue;                     // bare number
      if (/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(l)) continue; // date
      // Accept this as the item name
      name = l.replace(/\s{2,}/g, ' ').substring(0, 150);
      break;
    }
    if (!name) continue;

    // Price: "$19.99 / ea" or "$19.99" on the line(s) AFTER the Qty line
    let price = null;
    for (let j = i + 1; j <= Math.min(lines.length - 1, i + 4); j++) {
      const pm = lines[j].match(/^\$?([\d,]+\.\d{2})\s*(?:\/\s*ea)?\s*$/i)
              || lines[j].match(/\$\s*([\d,]+\.\d{2})\s*(?:\/\s*ea)?\s*$/i);
      if (pm) { price = parseFloat(pm[1].replace(/,/g,'')); break; }
    }
    if (!price || price < 0.50 || price > 5000) continue;

    const key = `${name.toLowerCase()}|${price}`;
    if (seen.has(key)) continue;
    seen.add(key);
    items.push({ name, qty, price });
  }

  return items;
}

// Extract items from Pokemon Center / generic order HTML
// PKC confirmation emails use a label:value block format:
//   Product Name (bold)
//   SKU #: 10-10447-111
//   Qty: 2
//   Price: $59.99
// We reuse the same htmlToLines + backward-scan approach as extractTargetItems.
function extractPKCItems(html) {
  if (!html) return [];

  const seen  = new Set();
  const items = [];

  function isProductName(l) {
    if (l.length < 8 || l.length > 250) return false;
    if (/^\$?[\d,]+(\.\d+)?$/.test(l)) return false;
    if (/^(?:qty|quantity|price|subtotal|total|tax|shipping|sku|upc|item\s*#|order|estimated|retail delivery|sales tax|free|sold by|ships from|returns|eligible|rate|write|contact|help|terms|privacy)/i.test(l)) return false;
    if (/^\d{2,}-\d{2,}/.test(l)) return false;   // order number / SKU code like 10-10447-111
    if (/^[A-Z]{1,3}\d{6,}$/.test(l)) return false;
    return true;
  }

  const text  = htmlToLines(html);
  const lines = text.split(/[\n\r]+/).map(l => l.trim()).filter(Boolean);

  for (let i = 0; i < lines.length; i++) {
    // PKC item prices are ALWAYS labeled "Price: $XX.XX" — never a bare dollar amount.
    // This strictly excludes the totals section (Order Subtotal, Sales Tax, etc.)
    const priceMatch = lines[i].match(/^price[:\s]+\$?([\d,]+\.\d{2})\s*$/i);
    if (!priceMatch) continue;
    const price = parseFloat(priceMatch[1].replace(/,/g,''));
    if (price < 0.50 || price > 5000) continue;

    // Look for qty label nearby (within ±4 lines)
    let qty = 1;
    for (let j = Math.max(0, i - 4); j <= Math.min(lines.length - 1, i + 4); j++) {
      if (j === i) continue;
      const qm = lines[j].match(/^(?:qty|quantity)[:\s]*(\d+)$/i) ||
                 lines[j].match(/^(\d+)$/) ||
                 lines[j].match(/\bqty[:\s]+(\d+)\b/i);
      if (qm) { const q = parseInt(qm[1]); if (q >= 1 && q <= 99) { qty = q; break; } }
    }

    // Walk backwards for product name (skips SKU/Qty/Price label lines)
    for (let j = i - 1; j >= Math.max(0, i - 6); j--) {
      const l = lines[j];
      if (!isProductName(l)) continue;
      const key = `${l.toLowerCase()}|${price}`;
      if (seen.has(key)) break;
      seen.add(key);
      items.push({ name: l.replace(/\s{2,}/g, ' ').substring(0, 120), qty, price });
      break;
    }
  }

  return items;
}

// Format extracted items as strings: "3x ETB @ $40.00"
function formatItems(itemObjs) {
  return itemObjs.map(i => {
    const base = i.qty > 1 ? `${i.qty}x ${i.name}` : i.name;
    return i.price ? `${base} @ $${i.price.toFixed(2)}` : base;
  });
}

// ── DB update logic ───────────────────────────────────────────────────────────

const STATUS_RANK = { Confirmed:1, Unship:1, Shipped:2, OFD:3, Delivered:4, Cancelled:5, Refunded:5 };

async function processEmail(parsed, db) {
  const fromEmail  = parsed.from?.value?.[0]?.address || '';
  const subject    = parsed.subject || '';

  // ── Quick subject filter — skip marketing/promo emails before any HTML parsing ──
  // Only process emails whose subject suggests an order transaction.
  // This skips "% off", "new arrivals", "earn points", etc. from retailer domains.
  const subLower = subject.toLowerCase();
  const isOrderSubject =
    subLower.includes('order')    || subLower.includes('ship')      ||
    subLower.includes('deliver')  || subLower.includes('track')     ||
    subLower.includes('confirm')  || subLower.includes('placed')    ||
    subLower.includes('dispatch') || subLower.includes('package')   ||
    subLower.includes('receipt')  || subLower.includes('purchase')  ||
    subLower.includes('cancel')   || subLower.includes('refund')    ||
    subLower.includes('thank')    || subLower.includes('invoice')   ||
    subLower.includes('payment')  || subLower.includes('pickup')    ||
    subLower.includes('ready for') || subLower.includes('on its way');
  if (!isOrderSubject) return false;  // marketing email — skip without further work

  const bodyText   = parsed.text    || '';
  const bodyHtml   = parsed.html    || '';
  // Use HTML-stripped text as fallback — Target and many retailers send HTML-only emails
  const strippedHtml = stripHtml(bodyHtml);
  const plainText    = bodyText || strippedHtml;   // best plain text we have
  const fullText     = plainText + ' ' + bodyHtml; // raw HTML included for regex searches

  const retailerInfo = getRetailerInfo(fromEmail, plainText + ' ' + bodyHtml);
  if (!retailerInfo) return false;

  const tracking    = findTracking(fullText);
  const orderNumber = findOrderNumber(fullText, fromEmail);
  const rawStatus   = determineStatus(subject, plainText);
  const expectedDate= findExpectedDate(plainText);

  if (!orderNumber && !tracking) return false;

  const resolvedStatus = rawStatus || (orderNumber ? 'Confirmed' : null);
  const dbStatus       = resolvedStatus === 'OFD' ? 'Shipped' : resolvedStatus;
  const trackingStatus = resolvedStatus === 'OFD' ? 'OFD' : (resolvedStatus === 'Delivered' ? 'Delivered' : null);

  // ── Extract items + financials from confirmation emails only ─────────────────
  let extractedItems  = [];
  let financials      = {};
  const isConfirmation = resolvedStatus === 'Confirmed';
  if (isConfirmation && bodyHtml) {
    const actualRetailer = retailerInfo.retailer;
    if (actualRetailer === 'Target')         extractedItems = extractTargetItems(bodyHtml);
    else if (actualRetailer === 'Pokemon Center') extractedItems = extractPKCItems(bodyHtml);
    else                                     extractedItems = extractPKCItems(bodyHtml); // generic fallback
    // Run financial extraction on BOTH sources: strippedHtml (always consistent HTML table format)
    // and bodyText (plain-text alternative, if present).  Some emails have a bodyText that formats
    // the summary table differently (dot-padding, missing $, etc.) so neither source alone is reliable.
    const finHtml = findOrderFinancials(strippedHtml);
    const finText = bodyText ? findOrderFinancials(bodyText) : {};
    financials = {
      subtotal: finHtml.subtotal ?? finText.subtotal,
      tax:      finHtml.tax      ?? finText.tax,
      shipping: finHtml.shipping ?? finText.shipping,
      total:    finHtml.total    ?? finText.total,
    };
  }
  const itemStrings  = formatItems(extractedItems);
  const itemsJson    = itemStrings.length ? JSON.stringify(itemStrings) : null;
  const orderTotal   = financials.total    ?? financials.subtotal ?? null;
  const taxAmount    = financials.tax      ?? null;
  const shipCost     = financials.shipping ?? null;

  if (extractedItems.length)
    console.log(`   🛒 ${extractedItems.length} item(s) extracted, total=${orderTotal||'?'} tax=${taxAmount||'?'} ship=${shipCost||'?'}`);

  // ── Find existing record ─────────────────────────────────────────────────────
  let existing = null;
  if (orderNumber) existing = db.prepare('SELECT * FROM bot_orders WHERE order_number=?').get([orderNumber]);
  if (!existing && tracking) existing = db.prepare('SELECT * FROM bot_orders WHERE tracking=?').get([tracking]);

  if (existing) {
    const curRank = STATUS_RANK[existing.status]    || 0;
    const newRank = STATUS_RANK[resolvedStatus]     || 0;
    const updates = []; const vals = [];

    if (tracking && !existing.tracking)                    { updates.push('tracking=?');        vals.push(tracking); }
    if (expectedDate)                                      { updates.push('expected_date=?');    vals.push(expectedDate); }
    if (trackingStatus)                                    { updates.push('tracking_status=?');  vals.push(trackingStatus); }
    if (resolvedStatus === 'Delivered') {
      updates.push('delivered_date=?');  vals.push(new Date().toISOString().split('T')[0]);
      updates.push('expected_date=?');   vals.push(null);
    }
    if (dbStatus && newRank > curRank)                     { updates.push('status=?');           vals.push(dbStatus); }
    // Items/financials: if we extracted fresh items from a confirmation email, ALWAYS overwrite
    // (fixes stale/wrong items from old scraper on rescan). Only use "fill-if-missing" logic
    // when we have no new items to offer (e.g. a shipping notification email).
    if (itemsJson) {
      // Fresh extraction — overwrite regardless of what was stored before
      updates.push('items=?'); vals.push(itemsJson);
      if (orderTotal !== null) { updates.push('order_total=?'); vals.push(orderTotal); }
      if (taxAmount  !== null) { updates.push('tax_amount=?');  vals.push(taxAmount); }
      if (shipCost   !== null) { updates.push('ship_cost=?');   vals.push(shipCost); }
    } else {
      // No items extracted — only fill in fields that are currently missing
      if (orderTotal  && !existing.order_total)             { updates.push('order_total=?'); vals.push(orderTotal); }
      if (taxAmount   && !existing.tax_amount)              { updates.push('tax_amount=?');  vals.push(taxAmount); }
      if (shipCost !== null && existing.ship_cost === null)  { updates.push('ship_cost=?');   vals.push(shipCost); }
    }

    if (updates.length) {
      db.prepare(`UPDATE bot_orders SET ${updates.join(',')} WHERE id=?`).run([...vals, existing.id]);
      console.log(`   ✅ Updated #${existing.order_number}: ${updates.map((u,i)=>u.split('=')[0]+'='+vals[i]).join(', ')}`);
      return true;
    }
  } else if (orderNumber && dbStatus) {
    // Check blocklist
    try {
      const raw = db.prepare("SELECT value FROM settings WHERE key='scraper_blocked_orders'").get();
      const blocked = raw ? JSON.parse(raw.value) : [];
      if (blocked.includes(orderNumber)) {
        console.log(`   🚫 Skipped blocked order #${orderNumber}`);
        return false;
      }
    } catch(_) {}
    // Create new order
    const { retailer } = retailerInfo;
    const category  = detectCategoryFromContent(subject, plainText, retailerInfo.category);
    const emailDate = parsed.date ? parsed.date.toISOString() : new Date().toISOString();
    const orderDate = emailDate.split('T')[0];
    db.prepare(`INSERT OR IGNORE INTO bot_orders
      (category, retailer, order_number, tracking, status, tracking_status, expected_date,
       order_date, received_at, items, order_total, tax_amount, ship_cost, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)`)
      .run([category, retailer, orderNumber, tracking||null, dbStatus, trackingStatus||null,
            expectedDate||null, orderDate, emailDate,
            itemsJson||null, orderTotal||null, taxAmount||null, shipCost||null]);
    console.log(`   ➕ New: ${orderNumber} (${retailer}) — ${resolvedStatus}${itemStrings.length?' | '+itemStrings.length+' items':''}${expectedDate?' exp '+expectedDate:''}`);
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

// Build nested IMAP OR criteria for multiple FROM domains
// e.g. ['OR', ['FROM','a.com'], ['OR', ['FROM','b.com'], ['FROM','c.com']]]
function buildFromOr(domains) {
  if (domains.length === 1) return ['FROM', domains[0]];
  if (domains.length === 2) return ['OR', ['FROM', domains[0]], ['FROM', domains[1]]];
  return ['OR', ['FROM', domains[0]], buildFromOr(domains.slice(1))];
}

// All domains we care about across every retailer
const RETAILER_DOMAINS = [
  'target.com', 'pokemoncenter.com', 'narvar.com',
  'bearwalker.com', 'bear-walker.com',
  'shopifyemail.com', 'myshopify.com',
  'walmart.com', 'gamestop.com', 'bestbuy.com',
  'amazon.com', 'amazon-hq.com',
];

function fetchNewAndProcess(imap, db) {
  return new Promise((resolve, reject) => {
    // Read-only — we track what's been processed ourselves, don't touch read/unread
    imap.openBox('INBOX', true, (err) => {
      if (err) return reject(err);

      // Load seen Message-IDs from DB
      const seenRaw = getSetting(db, 'email_scraper_seen_ids', '[]');
      let seenIds;
      try { seenIds = new Set(JSON.parse(seenRaw)); } catch(_) { seenIds = new Set(); }

      // Search since last run date (default: today minus 1 day on first normal run)
      const sinceStr  = getSetting(db, 'email_scraper_since', null);
      const sinceDate = sinceStr ? new Date(sinceStr) : new Date(Date.now() - 1 * 24 * 60 * 60 * 1000);
      const imapDate  = formatImapDate(sinceDate);

      // Only fetch emails from known retailer domains — ignores all other inbox mail
      const fromFilter = buildFromOr(RETAILER_DOMAINS);
      const criteria   = [['SINCE', imapDate], fromFilter];

      console.log(`   Searching retailer emails since ${imapDate}…`);

      imap.search(criteria, (err, uids) => {
        if (err) return reject(err);
        if (!uids || !uids.length) {
          console.log('   No emails in range.');
          // Advance the since date so next run doesn't re-scan old range
          setSetting(db, 'email_scraper_since', new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString());
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
            // Advance since date (keep 1-day buffer so timezone edge cases don't miss anything)
            setSetting(db, 'email_scraper_since', new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString());
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

// ── Reset scraper state — Full Rescan goes back 90 days to recover lost orders ─
function resetEmailScraper(db) {
  setSetting(db, 'email_scraper_seen_ids', '[]');
  setSetting(db, 'email_scraper_since', new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString());
  console.log('📧 Email scraper state reset — next run will re-scan last 90 days');
}

module.exports = { runEmailScraper, scrapeByOrderNumber, resetEmailScraper };
