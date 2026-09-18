// ─── EMAIL SCRAPER ───────────────────────────────────────────────────────────
// Reads UNSEEN emails only, marks them read after processing so they're
// never double-processed. No carrier website calls — status comes from
// retailer emails: Shipped → OFD → Delivered.

const Imap             = require('node-imap');
const { simpleParser } = require('mailparser');

// Layered structured-data parser (JSON-LD → microdata → DOM → optional AI).
// See parser/index.js — this is the primary extraction path; the hand-written
// retailer extractors further down are now only a last-resort fallback.
const { parseOrderEmail } = require('./parser');

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

  // Pokemon Center P-format, regardless of sender. PKC sends its confirmations
  // from a different domain than its shipping mail, so the sender-gated branch
  // above misses them entirely.
  const p = text.match(/\b(P\d{9,12})\b/);
  if (p) return p[1];

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
// Decide what an email is telling us about an order.
//
// CRITICAL: never test the body with a bare substring like "cancel" or "refund".
// Every retailer footer contains "Cancel order", "cancellation policy" and
// "refund policy", so a substring test marks literally every shipping email as
// Cancelled — including ones carrying a UPS tracking number.
//
// The subject line is what actually states the purpose of the email, so it is
// weighted first and the body is only consulted for unambiguous full phrases.
function determineStatus(subject, bodyText, opts = {}) {
  const subj = (subject  || '').toLowerCase();
  const body = (bodyText || '').toLowerCase();
  const both = `${subj} ${body}`;

  // ── Cancelled ────────────────────────────────────────────────────────────
  // Subject may be loose; body must be an explicit statement of fact.
  const SUBJ_CANCEL = /\bcancell?(?:ed|ation)\b/;
  const BODY_CANCEL = /\b(?:has\s+been|have\s+been|was|were|is)\s+cancell?ed\b|\bwe(?:'ve|\s+have)\s+cancell?ed\b|\byour\s+order\s+(?:was|has\s+been)\s+cancell?ed\b|\bcancell?ation\s+(?:confirm\w*|notice|complete\w*)\b/;
  // "Cancel order", "you can cancel", "cancellation policy" are UI/legal text.
  const isCancelled = SUBJ_CANCEL.test(subj) || BODY_CANCEL.test(body);

  // An email carrying a tracking number is a shipping notice. Whatever cancel
  // wording it contains is a footer link, not a cancellation.
  if (isCancelled && !opts.hasTracking) return 'Cancelled';

  // ── Refunded ─────────────────────────────────────────────────────────────
  const SUBJ_REFUND = /\brefund(?:ed)?\b/;
  const BODY_REFUND = /\brefund\s+(?:has\s+been|was)\s+(?:issued|processed|sent)\b|\bwe(?:'ve|\s+have)\s+(?:issued|processed)\s+(?:a\s+|your\s+)?refund\b|\byour\s+refund\s+(?:of|is|has)\b|\bhas\s+been\s+refunded\b/;
  if (SUBJ_REFUND.test(subj) || BODY_REFUND.test(body)) return 'Refunded';

  // ── Delivered ────────────────────────────────────────────────────────────
  // "delivered" only — never "delivery", which appears in every estimate line.
  const SUBJ_DELIVERED = /\bdelivered\b/;
  const BODY_DELIVERED = /\b(?:was|has\s+been|been)\s+delivered\b|\bdelivered\s+(?:on|to)\b/;
  const notAnEstimate  = !/\b(?:estimated|expected|scheduled|will\s+be|arriving|arrives)\b/.test(subj);
  if ((SUBJ_DELIVERED.test(subj) && notAnEstimate) || BODY_DELIVERED.test(body)) return 'Delivered';

  // ── Out for delivery ─────────────────────────────────────────────────────
  if (/\bout\s+for\s+delivery\b/.test(both)) return 'OFD';

  // ── Shipped ──────────────────────────────────────────────────────────────
  const SHIPPED = /\b(?:has\s+shipped|has\s+been\s+shipped|order\s+shipped|now\s+shipping|on\s+its\s+way|on\s+the\s+way|in\s+transit|has\s+left\s+our|shipment\s+(?:confirm\w*|notice)|your\s+package)\b/;
  if (SHIPPED.test(subj) || SHIPPED.test(body)) return 'Shipped';
  // A tracking number with no contrary signal means it shipped.
  if (opts.hasTracking) return 'Shipped';

  // ── Confirmed ────────────────────────────────────────────────────────────
  const CONFIRMED = /\b(?:order\s+confirm\w*|thank\s+you\s+for\s+your\s+order|thanks\s+for\s+your\s+order|thanks\s+for\s+shopping|order\s+received|we\s+received\s+your\s+order|we\s+have\s+your\s+order|we\s+got\s+your\s+order|we've\s+got\s+your\s+order|is\s+confirmed|your\s+order\s+is\s+placed|has\s+been\s+placed|placed\s+your\s+order|order\s+is\s+being\s+prepared|your\s+recent\s+order)\b/;
  if (CONFIRMED.test(subj) || CONFIRMED.test(body)) return 'Confirmed';
  if (/\border\s*#/.test(both)) return 'Confirmed';

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
    if (/:\s*$/.test(l)) return false;   // ends with colon = category label (e.g. "Pokemon TCG:"), not the product name
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

// Same display format, for items coming out of the structured parser (which
// carries a SKU). Keeps the trailing " @ $X.XX" the admin UI parses for unit price.
function formatParsedItems(items) {
  return items.map(i => {
    let s = i.qty > 1 ? `${i.qty}x ${i.name}` : i.name;
    if (i.sku) s += ` (SKU ${i.sku})`;
    if (i.unitPrice !== null && i.unitPrice !== undefined) s += ` @ $${i.unitPrice.toFixed(2)}`;
    return s;
  });
}

// Fall back to a readable retailer name derived from the sender's domain, for
// senders that aren't in the RETAILERS table but did emit structured order data.
function retailerFromDomain(fromEmail) {
  const m = String(fromEmail || '').toLowerCase().match(/@([^>\s]+)/);
  if (!m) return null;
  const host = m[1].replace(/^(?:mail|email|e|news|info|no-?reply|order|orders|shop|send|mkt|marketing|t|em|ct)\./, '');
  const base = host.split('.').slice(-2, -1)[0] || host.split('.')[0];
  if (!base || base.length < 2) return null;
  return base
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase());
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

  // Keep a copy of every order-ish email so the parser can be re-run later without
  // touching Gmail. This turns a Full Rescan from a multi-minute IMAP crawl into a
  // few seconds of local reparsing — see reparseStoredEmails().
  saveRawEmail(db, parsed, bodyHtml, plainText);

  // ── PRIMARY: layered structured-data parser ─────────────────────────────────
  // Reads schema.org JSON-LD / microdata first (which most major retailers embed
  // for Gmail purchase tracking), then falls back to a DOM-structure-aware reader.
  // This is what lets retailers with no hand-written extractor work automatically.
  const allowLlm = process.env.ENABLE_LLM_PARSE === '1';
  let P = null;
  try {
    P = await parseOrderEmail({ html: bodyHtml, text: plainText, subject, from: fromEmail, allowLlm });
  } catch (e) {
    console.log('   ⚠️  parser error:', e.message);
  }

  const retailerInfo = getRetailerInfo(fromEmail, plainText + ' ' + bodyHtml);
  const isStructured = !!(P && (P.source === 'jsonld' || P.source === 'microdata'));

  // Accept the email if we recognize the sender OR the parser found real order data.
  // Previously an unknown sender was dropped outright, which is why Sam's Club,
  // Costco and Mattel never appeared — they were never even looked at.
  if (!retailerInfo && !isStructured && !(P && P.items.length)) {
    console.log(`   ⏭️  Skipped [unknown sender, no order data] ${fromEmail} — "${subject.slice(0, 60)}"`);
    return false;
  }

  const retailer     = retailerInfo?.retailer || P?.retailer || retailerFromDomain(fromEmail);
  const baseCategory = retailerInfo?.category || 'Other';
  if (!retailer) return false;

  // Identifiers: trust structured data first, then the tuned retailer regexes.
  const tracking =
    (isStructured ? P.trackingNumber : null) || findTracking(fullText) || P?.trackingNumber || null;
  const orderNumber =
    (isStructured ? P.orderNumber : null) || findOrderNumber(fullText, fromEmail) || P?.orderNumber || null;

  // hasTracking stops a shipping notice's footer "Cancel order" link from being
  // read as an actual cancellation.
  const rawStatus =
    (isStructured ? P.status : null) ||
    determineStatus(subject, plainText, { hasTracking: !!tracking }) ||
    P?.status || null;
  const expectedDate = P?.expectedDate || findExpectedDate(plainText);

  if (!orderNumber && !tracking) {
    console.log(`   ⏭️  Skipped [no order # or tracking found] ${retailer} — "${subject.slice(0, 60)}"`);
    return false;
  }

  const resolvedStatus = rawStatus || (orderNumber ? 'Confirmed' : null);
  const dbStatus       = resolvedStatus === 'OFD' ? 'Shipped' : resolvedStatus;
  const trackingStatus = resolvedStatus === 'OFD' ? 'OFD' : (resolvedStatus === 'Delivered' ? 'Delivered' : null);

  // ── Items + financials ──────────────────────────────────────────────────────
  let itemStrings = [];
  let financials  = {};

  if (P && P.items.length) {
    itemStrings = formatParsedItems(P.items);
    // Belt and braces: if the parser still came up empty on a money field, fall
    // back to the original regex extractor over both the stripped HTML and the
    // text/plain part. Costs nothing and covers layouts neither reader handles.
    const finHtml = findOrderFinancials(strippedHtml);
    const finText = bodyText ? findOrderFinancials(bodyText) : {};
    financials = {
      subtotal: P.subtotal ?? finHtml.subtotal ?? finText.subtotal ?? null,
      tax:      P.tax      ?? finHtml.tax      ?? finText.tax      ?? null,
      shipping: P.shipping ?? finHtml.shipping ?? finText.shipping ?? null,
      total:    P.total    ?? finHtml.total    ?? finText.total    ?? null,
    };
    console.log(`   🛒 ${P.items.length} item(s) via ${P.source} (confidence ${P.confidence})`);
  } else if (resolvedStatus === 'Confirmed' && bodyHtml) {
    // Last resort: the original hand-written extractors.
    const legacy = retailer === 'Target' ? extractTargetItems(bodyHtml) : extractPKCItems(bodyHtml);
    itemStrings  = formatItems(legacy);
    const finHtml = findOrderFinancials(strippedHtml);
    const finText = bodyText ? findOrderFinancials(bodyText) : {};
    financials = {
      subtotal: P?.subtotal ?? finHtml.subtotal ?? finText.subtotal,
      tax:      P?.tax      ?? finHtml.tax      ?? finText.tax,
      shipping: P?.shipping ?? finHtml.shipping ?? finText.shipping,
      total:    P?.total    ?? finHtml.total    ?? finText.total,
    };
    if (legacy.length) console.log(`   🛒 ${legacy.length} item(s) via legacy extractor`);
  } else if (P) {
    financials = { subtotal: P.subtotal, tax: P.tax, shipping: P.shipping, total: P.total };
  }

  const itemsJson  = itemStrings.length ? JSON.stringify(itemStrings) : null;
  const orderTotal = financials.total    ?? financials.subtotal ?? null;
  const taxAmount  = financials.tax      ?? null;
  const shipCost   = financials.shipping ?? null;

  // True when the total was actually stated in this email rather than computed by
  // summing item lines. A shipping notification has items but no money summary,
  // so its "total" is a guess and must not clobber the confirmation email's figure.
  const totalIsReal = !!(financials.total !== null && financials.total !== undefined && !(P && P.derived && P.derived.total));

  if (itemStrings.length)
    console.log(`   💰 total=${orderTotal ?? '?'}${totalIsReal ? '' : ' (derived)'} tax=${taxAmount ?? '?'} ship=${shipCost ?? '?'}`);

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
    // Repair rows poisoned by the old footer-substring bug: if the stored status
    // is Cancelled but this email carries a tracking number and reports movement,
    // the earlier Cancelled was a misread of a "Cancel order" link. Allow the
    // downgrade in that one specific case — otherwise status never goes backwards.
    const correctingBadCancel =
      existing.status === 'Cancelled' && !!tracking &&
      (resolvedStatus === 'Shipped' || resolvedStatus === 'Delivered' || resolvedStatus === 'OFD');

    if (dbStatus && (newRank > curRank || correctingBadCancel)) {
      updates.push('status=?'); vals.push(dbStatus);
      if (correctingBadCancel) console.log(`   🔧 Corrected bad Cancelled → ${dbStatus} (has tracking ${tracking})`);
    }
    // Fix wrong category: if existing order is "Other" but content reveals a real category, upgrade it
    const redetectedCategory = detectCategoryFromContent(subject, plainText, baseCategory);
    if (redetectedCategory !== 'Other' && existing.category === 'Other') {
      updates.push('category=?'); vals.push(redetectedCategory);
    }
    // Items/financials: if we extracted fresh items from a confirmation email, ALWAYS overwrite
    // (fixes stale/wrong items from old scraper on rescan). Only use "fill-if-missing" logic
    // when we have no new items to offer (e.g. a shipping notification email).
    if (itemsJson) {
      // Fresh extraction — overwrite regardless of what was stored before
      updates.push('items=?'); vals.push(itemsJson);
      // ...but only replace the stored total with one this email actually stated.
      // A derived total (items summed on a shipping notice, which carries no tax
      // or shipping line) may only fill an empty field, never replace a real figure.
      if (orderTotal !== null && (totalIsReal || !existing.order_total)) {
        updates.push('order_total=?'); vals.push(orderTotal);
      }
      if (taxAmount !== null) { updates.push('tax_amount=?'); vals.push(taxAmount); }
      if (shipCost  !== null) { updates.push('ship_cost=?');  vals.push(shipCost); }
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
    const category  = detectCategoryFromContent(subject, plainText, baseCategory);
    const emailDate = parsed.date ? parsed.date.toISOString() : new Date().toISOString();
    const orderDate = emailDate.split('T')[0];
    db.prepare(`INSERT OR IGNORE INTO bot_orders
      (category, retailer, order_number, tracking, status, tracking_status, expected_date,
       order_date, received_at, items, order_total, tax_amount, ship_cost, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)`)
      // NOTE: ?? not || for the money fields — a legitimate $0.00 shipping or tax
      // is falsy, and || would silently store it as null.
      .run([category, retailer, orderNumber, tracking||null, dbStatus, trackingStatus||null,
            expectedDate||null, orderDate, emailDate,
            itemsJson||null, orderTotal ?? null, taxAmount ?? null, shipCost ?? null]);
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

// Superseded by the generic buildOr() above, which also handles SUBJECT terms.
function buildFromOr(domains) {
  return buildOr(domains.map(d => ['FROM', d]));
}

// All domains we care about across every retailer
// Sender domains we know send order mail. This is a HINT, not a gate — see the
// search criteria below, which also matches on subject so retailers missing from
// this list still get fetched.
//
// History: this used to be the only filter, and it silently lost every order from
// any retailer not listed — all 50 Mattel Creations orders were never downloaded
// from Gmail at all. It also lost Pokemon Center *confirmations*, because PKC
// sends those from a different domain than its shipping mail; the only PKC orders
// that survived arrived via narvar.com.
const RETAILER_DOMAINS = [
  'target.com', 'pokemoncenter.com', 'pokemon.com', 'narvar.com',
  'bearwalker.com', 'bear-walker.com',
  'shopifyemail.com', 'myshopify.com', 'shopify.com',
  'walmart.com', 'gamestop.com', 'bestbuy.com',
  'amazon.com', 'amazon-hq.com',
  'mattelcreations.com', 'mattel.com',
  'samsclub.com', 'costco.com', 'sams.com',
];

// Subject words that indicate a transactional order email. Matching on these
// means a retailer does not need to be in RETAILER_DOMAINS to be picked up.
const SUBJECT_KEYWORDS = [
  'order', 'shipped', 'shipment', 'delivered', 'delivery',
  'tracking', 'receipt', 'invoice', 'cancelled', 'canceled', 'refund',
];

// node-imap wants OR nested pairwise: ['OR', a, ['OR', b, c]]
function buildOr(criteria) {
  if (!criteria.length)      return null;
  if (criteria.length === 1) return criteria[0];
  return ['OR', criteria[0], buildOr(criteria.slice(1))];
}

function fetchNewAndProcess(imap, db) {
  return new Promise((resolve, reject) => {
    // Read-only — we track what's been processed ourselves, don't touch read/unread
    // INBOX misses anything archived. Set scraper_mailbox to '[Gmail]/All Mail'
    // to search the full account instead — slower, but nothing is hidden.
    const mailbox = getSetting(db, 'scraper_mailbox', 'INBOX');
    imap.openBox(mailbox, true, (err) => {
      if (err) return reject(err);

      // Load seen Message-IDs from DB
      const seenRaw = getSetting(db, 'email_scraper_seen_ids', '[]');
      let seenIds;
      try { seenIds = new Set(JSON.parse(seenRaw)); } catch(_) { seenIds = new Set(); }

      // Search since last run date (default: today minus 1 day on first normal run)
      const sinceStr  = getSetting(db, 'email_scraper_since', null);
      const sinceDate = sinceStr ? new Date(sinceStr) : new Date(Date.now() - 1 * 24 * 60 * 60 * 1000);
      const imapDate  = formatImapDate(sinceDate);

      // Match a known retailer domain OR an order-ish subject line. The subject
      // arm is what lets retailers absent from RETAILER_DOMAINS through — without
      // it, their mail is never downloaded and no amount of parser work can help.
      // Extra domains can be added at runtime via the scraper_extra_domains setting,
      // so a new retailer doesn't require a code change.
      let extraDomains = [];
      try { extraDomains = JSON.parse(getSetting(db, 'scraper_extra_domains', '[]')); } catch (_) {}

      const domains      = [...new Set([...RETAILER_DOMAINS, ...extraDomains])];
      const fromFilter   = buildOr(domains.map(d => ['FROM', d]));
      const subjectFilter= buildOr(SUBJECT_KEYWORDS.map(k => ['SUBJECT', k]));
      const criteria     = [['SINCE', imapDate], buildOr([fromFilter, subjectFilter])];

      console.log(`   Searching since ${imapDate} — ${domains.length} known domains + ${SUBJECT_KEYWORDS.length} subject keywords…`);

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
            // NB: this counts EMAILS that produced a write, not distinct orders.
            // One order normally sends 3 emails (confirmed → shipped → delivered),
            // so this number is expected to be several times the order count.
            const distinct = db.prepare('SELECT COUNT(*) AS n FROM bot_orders').get()?.n ?? '?';
            console.log(`   Processed ${newIds.length} new email(s); ${updated} produced a write. ${distinct} distinct order(s) now in DB.`);
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

// ── Raw email archive ────────────────────────────────────────────────────────
// Storing the bodies means the parser can be improved and re-run over real mail
// instantly, instead of re-crawling IMAP every time a regex changes.

function ensureRawEmailTable(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS raw_emails (
    message_id  TEXT PRIMARY KEY,
    subject     TEXT,
    from_email  TEXT,
    email_date  TEXT,
    html        TEXT,
    text        TEXT,
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
}

function saveRawEmail(db, parsed, html, text) {
  try {
    ensureRawEmailTable(db);
    const msgId = parsed.messageId || `${parsed.date?.toISOString() || Date.now()}|${parsed.subject || ''}`;
    db.prepare(`INSERT OR REPLACE INTO raw_emails
      (message_id, subject, from_email, email_date, html, text)
      VALUES (?,?,?,?,?,?)`)
      .run([
        msgId,
        parsed.subject || null,
        parsed.from?.value?.[0]?.address || null,
        parsed.date ? parsed.date.toISOString() : null,
        (html || '').slice(0, 400000),
        (text || '').slice(0, 100000),
      ]);
  } catch (e) { /* archiving must never break scraping */ }
}

// Re-run the parser over every archived email. No network, no IMAP.
async function reparseStoredEmails(db) {
  ensureRawEmailTable(db);
  const rows = db.prepare('SELECT * FROM raw_emails ORDER BY email_date ASC').all();
  console.log(`🔁 Reparsing ${rows.length} archived email(s) — no IMAP needed`);

  let updated = 0;
  for (const r of rows) {
    try {
      const fake = {
        messageId: r.message_id,
        subject:   r.subject || '',
        from:      { value: [{ address: r.from_email || '' }] },
        date:      r.email_date ? new Date(r.email_date) : new Date(),
        html:      r.html || '',
        text:      r.text || '',
      };
      if (await processEmail(fake, db)) updated++;
    } catch (e) {
      console.log(`   ⚠️  reparse failed for ${r.message_id}: ${e.message}`);
    }
  }
  console.log(`🔁 Reparse complete — ${updated} order(s) updated`);
  return { total: rows.length, updated };
}

// ── Reset scraper state ──────────────────────────────────────────────────────
// wipeOrders=true: delete all existing bot_orders first (start from zero)
// days: how far back to scan (default 180 to cover ~6 months)
function resetEmailScraper(db, { wipeOrders = false, days = 180 } = {}) {
  if (wipeOrders) {
    db.prepare('DELETE FROM bot_orders').run();
    // Also clear the blocked list so nothing is accidentally permanently blocked
    setSetting(db, 'scraper_blocked_orders', '[]');
    console.log('🗑️  All bot_orders wiped — starting fresh');
  }
  setSetting(db, 'email_scraper_seen_ids', '[]');
  setSetting(db, 'email_scraper_since', new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString());
  console.log(`📧 Email scraper reset — next run will re-scan last ${days} days`);
}

module.exports = {
  runEmailScraper, scrapeByOrderNumber, resetEmailScraper,
  reparseStoredEmails, ensureRawEmailTable,
  // Exposed for unit tests only.
  __test: { determineStatus, findOrderNumber, findTracking, findOrderFinancials },
};
