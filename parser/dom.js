'use strict';
// ─── LAYER 3: STRUCTURE-AWARE DOM EXTRACTOR ──────────────────────────────────
//
// WHY THIS EXISTS
// The previous scraper flattened HTML into a list of text lines and then guessed
// which lines belonged together based on how close they were. That destroys the
// table structure, which is the only reliable signal about which price belongs to
// which product.
//
// Concrete failure it caused: in a Target confirmation, "$43.39" appears three
// times — once in the header preview, once as the order total, once in the payment
// row. Flattened to text they are indistinguishable, so the scraper attached
// product names like "Mastercard *5562" and "Based on 55445" (a zip code sitting
// next to the tax amount).
//
// In the actual DOM those three are in three different tables, and the real item
// price lives in a <tr> that also contains the product name and "Qty: 2".
// Completely unambiguous. So: walk the tree, never the flattened text.

const cheerio = require('cheerio');
const { parseMoney, cleanName, emptyOrder, round2 } = require('./normalize');

const MONEY_STRICT = /-?\$\s*[\d,]+\.\d{2}/;
const MONEY_ALL_G  = /-?\$\s*[\d,]+\.\d{2}/g;

// If a price sits in a row mentioning any of these, it is a total/fee/payment —
// not an item price.
const FINANCIAL_LABEL = /\b(sub\s?total|subtotal|order\s+total|grand\s+total|total|tax|taxes|shipping|delivery\s+fee|handling|discount|promo|promotion|coupon|savings|gift\s?card|store\s+credit|balance|amount\s+(?:due|paid|charged)|payment|paid\s+with|card\s+ending|ending\s+in|mastercard|visa|amex|discover|american\s+express|paypal|apple\s+pay|google\s+pay|venmo|afterpay|klarna|estimated\s+tax)\b/i;

// Everything after one of these headings is an upsell, not part of the order.
const PROMO_SECTION = /(you\s+might\s+also|perfect\s+pairings|recommended\s+for|recommended\s+just|customers\s+also|complete\s+the\s+look|people\s+also|frequently\s+bought|explore\s+more|just\s+for\s+you|top\s+picks|trending\s+now|more\s+to\s+love|inspired\s+by|similar\s+items|you\s+may\s+(?:also\s+)?like|shop\s+more|keep\s+shopping)/i;

const ADDRESS_RE = /\b\d{1,6}\s+[A-Za-z][A-Za-z.\s]{2,}\b(?:st|street|ave|avenue|blvd|boulevard|rd|road|ln|lane|dr|drive|ct|court|way|pkwy|parkway|hwy|highway|cir|circle|ste|suite|apt|unit)\b|\b[A-Z]{2}\s+\d{5}(?:-\d{4})?\b/i;

const NOT_A_NAME = /^(qty|quantity|item|items|sku|upc|order|tracking|status|date|subtotal|total|tax|shipping|delivery|price|each|ea|free|of|and|or)\b/i;

const BOILERPLATE = /\b(delivers?\s+to|ships?\s+to|shipping\s+to|sold\s+by|ships?\s+from|arrives?|arriving|estimated\s+delivery|expected\s+delivery|track\s+(?:your\s+)?(?:package|order|shipment)|view\s+(?:order|details)|order\s+details|rate\s*&?\s*review|write\s+a\s+review|return\s+policy|manage\s+(?:order|subscription)|unsubscribe|privacy\s+policy|terms\s+(?:of|and)|customer\s+service|contact\s+us|need\s+help|questions\?|click\s+here|sign\s+in|my\s+account|download\s+the\s+app|follow\s+us)\b/i;

const CHATTY = /\b(we'll|you'll|we're|you're|we've|you've|thanks\s+for|thank\s+you|sit\s+back|get\s+to\s+work|on\s+its\s+way|hang\s+tight|good\s+news|great\s+news)\b/i;

const norm = s => String(s || '').replace(/\s+/g, ' ').trim();

// Text belonging directly to an element, excluding its children's text.
// Separate text nodes are joined with a space, never concatenated: they are only
// split apart because an element (usually <br/>) sits between them, so gluing
// them together invents words. "Estimated taxes<br/>Based on 55445" must not
// become "Estimated taxesBased on 55445" — that breaks every \bword\b match.
// Reads the underlying parser nodes directly rather than going through a cheerio
// wrapper — this is called once per element on every email, so avoiding the
// wrapper allocation is a measurable win on large messages.
function ownText($, el) {
  const kids = (el && el.children) || [];
  let parts = null;
  for (let i = 0; i < kids.length; i++) {
    const n = kids[i];
    if (n.type === 'text' && n.data) {
      const t = n.data.trim();
      if (t) (parts || (parts = [])).push(t);
    }
  }
  return parts ? norm(parts.join(' ')) : '';
}

function childElements(el) {
  const kids = (el && el.children) || [];
  const out = [];
  for (let i = 0; i < kids.length; i++) if (kids[i].type === 'tag') out.push(kids[i]);
  return out;
}

function isNameCandidate(s) {
  if (!s) return false;
  const t = s.trim();
  if (t.length < 4 || t.length > 200) return false;
  // A name ending in an ellipsis is UI truncation from a recommendation tile
  // ("Pokemon Card Game MEGA High…"), never an actual product title. Target's
  // delivery emails are full of these carousels.
  if (/(\.\.\.|…)$/.test(t)) return false;
  if (MONEY_STRICT.test(t))            return false;
  if (/^-?[\d,.\s]+$/.test(t))         return false;   // pure number
  if (!/[a-z]/i.test(t))               return false;   // must have letters
  if (NOT_A_NAME.test(t))              return false;
  if (FINANCIAL_LABEL.test(t))         return false;
  if (BOILERPLATE.test(t))             return false;
  if (ADDRESS_RE.test(t))              return false;
  if (/^(https?:\/\/|www\.)/i.test(t)) return false;
  if (/^\d{1,2}[/-]\d{1,2}[/-]\d{2,4}$/.test(t)) return false;
  if (/^(mon|tue|wed|thu|fri|sat|sun|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i.test(t) && /\d{4}/.test(t)) return false;
  return true;
}

function nameScore(s) {
  let sc = Math.min(s.length, 90);
  if (CHATTY.test(s)) sc -= 300;
  const words = s.split(/\s+/).length;
  if (/[.!?]$/.test(s) && words > 8) sc -= 80;    // looks like a sentence
  if (words === 1 && s.length < 8)   sc -= 40;
  if (words >= 2)                    sc += 15;
  return sc;
}

// Is this price inside a totals / payment / tax row?
//
// The walk upward must stop at the boundary of the line item, otherwise on a
// short email it reaches <body> — which contains both the item and the order
// summary — sees the word "Subtotal", and throws away a perfectly good item.
// Two stopping rules: a <tr> is the natural unit of one line item, and any
// ancestor holding more than one price means we have climbed out of the row.
function inFinancialContext($, el) {
  let cur = $(el);
  for (let i = 0; i < 5; i++) {
    const t = norm(cur.text());
    if (t) {
      if (t.length > 220) break;               // too broad to judge reliably
      const moneyCount = (t.match(MONEY_ALL_G) || []).length;
      if (i > 0 && moneyCount > 1) break;      // escaped into a multi-row container
      if (FINANCIAL_LABEL.test(t)) return true;
    }
    if (cur.is('tr')) break;                   // one row = one line item
    const p = cur.parent();
    if (!p.length) break;
    cur = p;
  }
  return false;
}

// Best product-name text inside a block, ignoring the money element itself.
function pickName($, block, moneyEl, ordinals) {
  const candidates = [];
  const consider = (txt, el) => {
    const t = norm(txt);
    if (!isNameCandidate(t)) return;
    candidates.push({ t, score: nameScore(t), ord: ordinals.get(el) ?? 0 });
  };

  consider(ownText($, block.get(0)), block.get(0));
  block.find('*').each((_, d) => {
    if (d === moneyEl) return;
    consider(ownText($, d), d);
  });

  if (!candidates.length) return null;
  candidates.sort((a, b) => (b.score - a.score) || (a.ord - b.ord));
  return candidates[0].score > 0 ? cleanName(candidates[0].t) : null;
}

// Climb from a price up to the smallest block that also contains a product name.
function findItemBlock($, moneyEl, ordinals) {
  // Case A: name and price share one text node — "Booster Bundle $19.99"
  const own = ownText($, moneyEl);
  const stripped = norm(own.replace(MONEY_ALL_G, ' ').replace(/\/\s*(?:ea|each)\b/i, ' '));
  if (isNameCandidate(stripped) && nameScore(stripped) > 0) {
    return { block: $(moneyEl), name: cleanName(stripped) };
  }

  // Case B: climb the tree, but not past the boundary of this line item.
  //
  // Without these stops a price whose own row has no usable product name keeps
  // climbing until it reaches <body> and adopts any stray sentence as the name —
  // that is how "Your package was delivered." became a purchased product.
  let cur = $(moneyEl);
  for (let depth = 0; depth < 7; depth++) {
    const parent = cur.parent();
    if (!parent.length) break;
    cur = parent;

    const txt = norm(cur.text());
    if (txt.length > 700) break;                              // way past the item
    if ((txt.match(MONEY_ALL_G) || []).length > 1) break;      // holds several prices → not one row

    const name = pickName($, cur, moneyEl, ordinals);
    if (name) return { block: cur, name };

    // Examined an entire <tr> and found no product name: there is no item here.
    if (cur.is('tr')) break;
  }
  return null;
}

function qtyFromText(t) {
  let m = t.match(/\b(?:qty|quantity)\s*[:.]?\s*(\d{1,3})\b/i);
  if (m) return parseInt(m[1], 10);
  m = t.match(/\b(\d{1,3})\s*[x×]\s*\$/i);
  if (m) return parseInt(m[1], 10);
  m = t.match(/(?:^|\s)[x×]\s*(\d{1,3})(?:\s|$)/i);
  if (m) return parseInt(m[1], 10);
  return 1;
}

// ── Financial totals ─────────────────────────────────────────────────────────
function classifyLabel(t) {
  const s = t.trim();
  if (!s || s.length > 60) return null;
  if (/\bsub\s?total\b/i.test(s) || /\bitems?\s+total\b/i.test(s) || /\bmerchandise\s+(?:sub)?total\b/i.test(s)) return 'subtotal';
  if (/\b(?:sales\s+|estimated\s+)?tax(?:es)?\b/i.test(s))                                  return 'tax';
  if (/\b(?:retail\s+)?(?:shipping|delivery)(?:\s+(?:fee|cost|charge))?\b/i.test(s))        return 'shipping';
  if (/\b(?:discount|promotion|promo|coupon|savings)\b/i.test(s))                           return 'discount';
  if (/\b(?:order\s+total|grand\s+total|total\s+charged|amount\s+(?:due|paid|charged)|you\s+paid)\b/i.test(s)) return 'total';
  if (/^total\b/i.test(s))                                                                  return 'total';
  return null;
}

function valueForLabel($, el, t) {
  const m = t.match(MONEY_STRICT);
  if (m) return parseMoney(m[0]);
  if (/\bfree\b/i.test(t)) return 0;

  const tr = $(el).closest('tr');
  if (tr.length) {
    const rowText = norm(tr.text());
    const all = rowText.match(MONEY_ALL_G);
    if (all && all.length) return parseMoney(all[all.length - 1]);
    if (/\bfree\b/i.test(rowText)) return 0;
  }

  let sib = $(el).next();
  for (let i = 0; i < 3 && sib.length; i++) {
    const st = norm(sib.text());
    const mm = st.match(MONEY_STRICT);
    if (mm) return parseMoney(mm[0]);
    if (/^free$/i.test(st)) return 0;
    sib = sib.next();
  }

  const pn = $(el).parent().next();
  if (pn.length) {
    const st = norm(pn.text());
    const mm = st.match(MONEY_STRICT);
    if (mm) return parseMoney(mm[0]);
    if (/^free$/i.test(st)) return 0;
  }
  return null;
}

// Takes the label nodes already collected during the single tree walk, so this
// no longer re-traverses the document.
function extractFinancials($, labelNodes) {
  const out = { subtotal: null, tax: null, shipping: null, discount: null, total: null };
  for (const { el, text, label } of labelNodes) {
    if (out[label] !== null) continue;
    const val = valueForLabel($, el, text);
    if (val === null) continue;
    out[label] = label === 'discount' ? Math.abs(val) : val;
  }
  return out;
}

// ── Main ─────────────────────────────────────────────────────────────────────
function extractDom(html) {
  if (!html) return null;

  let $;
  try { $ = cheerio.load(html); } catch (_) { return null; }

  // Drop non-content and hidden preheader text (the hidden preview line is a
  // common source of phantom prices — Target puts the order total there).
  $('script, style, head, title, noscript').remove();
  $('[hidden]').remove();
  $('[style]').each((_, el) => {
    const s = ($(el).attr('style') || '').replace(/\s+/g, '').toLowerCase();
    if (/display:none|font-size:0|max-height:0|mso-hide:all|opacity:0/.test(s)) $(el).remove();
  });

  // ── Single tree walk ──────────────────────────────────────────────────────
  // Previously this was four separate full traversals (ordinals, promo markers,
  // price nodes, financial labels), each re-deriving the own-text of every
  // element. One pass collects all of it.
  const ordinals   = new Map();
  const moneyNodes = [];
  const labelNodes = [];
  let promoCutoff  = Infinity;
  let ord = 0;

  const walk = (el) => {
    const myOrd = ord++;
    ordinals.set(el, myOrd);

    const t = ownText($, el);
    if (t) {
      // Document order means the first promo marker found is the earliest one.
      if (promoCutoff === Infinity && PROMO_SECTION.test(t)) promoCutoff = myOrd;

      const m = t.match(MONEY_STRICT);
      if (m) {
        const price = parseMoney(m[0]);
        if (price !== null && price > 0 && price <= 100000) {
          moneyNodes.push({ el, text: t, price, ord: myOrd });
        }
      }

      const label = classifyLabel(t);
      if (label) labelNodes.push({ el, text: t, label });
    }

    const kids = childElements(el);
    for (let i = 0; i < kids.length; i++) walk(kids[i]);
  };
  $.root().children().each((_, el) => { if (el.type === 'tag') walk(el); });

  const items = [];
  const seen  = new Set();

  for (const mn of moneyNodes) {
    if (mn.ord >= promoCutoff)          continue;   // upsell section
    if (inFinancialContext($, mn.el))   continue;   // total / tax / payment row

    const found = findItemBlock($, mn.el, ordinals);
    if (!found || !found.name) continue;

    const blockText = norm(found.block.text());
    const qty       = qtyFromText(blockText);
    const perEach   = /\/\s*(?:ea|each)\b/i.test(mn.text) || /\beach\b/i.test(mn.text);

    const key = `${found.name.toLowerCase()}|${mn.price}`;
    if (seen.has(key)) continue;
    seen.add(key);

    items.push({
      name:      found.name,
      sku:       null,
      qty:       qty > 0 && qty <= 999 ? qty : 1,
      unitPrice: mn.price,
      lineTotal: perEach ? round2(mn.price * qty) : null,
      imageUrl:  null,
      _perEach:  perEach,
    });
  }

  const fin = extractFinancials($, labelNodes);

  const result = emptyOrder();
  result.items    = items;
  result.subtotal = fin.subtotal;
  result.tax      = fin.tax;
  result.shipping = fin.shipping;
  result.discount = fin.discount;
  result.total    = fin.total;
  result.source   = 'dom';

  return result;
}

module.exports = {
  extractDom, extractFinancials, classifyLabel,
  isNameCandidate, inFinancialContext, ownText,
};
