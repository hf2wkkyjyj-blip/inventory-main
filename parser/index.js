'use strict';
// ─── ORDER EMAIL PARSER — LAYERED ORCHESTRATOR ───────────────────────────────
//
// Layers run best-to-worst. Each one fills gaps the previous left behind:
//
//   1. JSON-LD    schema.org/Order — exact, standardized, retailer-agnostic
//   2. Microdata  same vocabulary, attribute-encoded
//   3. DOM        structure-aware cheerio traversal (never flattened text)
//   4. LLM        Claude Haiku, only when 1–3 found no items at all
//
// This is the approach Route and the Shop app use: read the structured data
// retailers already publish, and only fall back to parsing markup when there
// isn't any. It means retailers nobody wrote custom code for work automatically.

const { extractJsonLd }        = require('./jsonld');
const { extractMicrodata }     = require('./microdata');
const { extractDom }           = require('./dom');
const { extractTextFinancials } = require('./text');
const { extractWithLlm }       = require('./llm');
const {
  emptyOrder, merge, round2, parseMoney, cleanName, hasAnything,
} = require('./normalize');

// ── Plain-text fallbacks for the few fields regex is genuinely good at ───────

// Flatten HTML to text while keeping label/value adjacency intact. Block
// boundaries become newlines so "Tax</td><td>$3.41" doesn't glue into "Tax$3.41".
function htmlToText(html) {
  if (!html) return '';
  return String(html)
    .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(td|th|tr|p|div|li|h[1-6]|table|section)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#\d+;|&[a-z]+;/gi, ' ')
    .replace(/[^\S\n]+/g, ' ')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

const TRACKING_PATTERNS = [
  /\b(1Z[A-Z0-9]{16})\b/i,          // UPS
  /\b(876\d{9})\b/,                  // Narvar / Pokemon Center
  /\b(9[24]\d{18,22})\b/,            // USPS
  /\b(96\d{20})\b/,                  // FedEx Ground
  /\b(61\d{18})\b/,                  // FedEx SmartPost
  /\b(7\d{11})\b/,                   // FedEx Express
];

function findTrackingInText(text) {
  if (!text) return null;
  for (const p of TRACKING_PATTERNS) {
    const m = text.match(p);
    if (m) return m[1];
  }
  return null;
}

function findOrderNumberInText(text) {
  if (!text) return null;

  // Tried in order of decreasing confidence. The colon/# is optional after an
  // explicit "number"/"no"/"id" word, because plenty of retailers write
  // "Order Number CHP10033780" with nothing between label and value.
  const PATTERNS = [
    /\b(?:order|confirmation|purchase|invoice|receipt)\s*(?:#|number|no\.?|id)\s*[:#]?\s*([A-Za-z0-9][A-Za-z0-9-]{4,29})\b/i,
    /\b(?:order|confirmation|purchase|invoice|receipt)\s*[:#]\s*([A-Za-z0-9][A-Za-z0-9-]{4,29})\b/i,
    /\border\s*#\s*([A-Za-z0-9][A-Za-z0-9-]{4,29})\b/i,
  ];

  for (const p of PATTERNS) {
    const m = text.match(p);
    // Require a digit so words like "Confirmation" are never mistaken for a value.
    if (m && /\d/.test(m[1])) return m[1].trim();
  }

  // Common bare formats: Amazon 111-2223334-5556667, Target 15–16 digits
  const bare = text.match(/\b(\d{3}-\d{7}-\d{7}|\d{15,16})\b/);
  if (bare) return bare[1];

  return null;
}

// ── Reconciliation ───────────────────────────────────────────────────────────
// Retailers are inconsistent about whether the price on an item is the unit price
// or the line total. Decide by checking which interpretation adds up to the
// subtotal (or the total) the email itself reports.
function reconcile(o) {
  const items = o.items || [];

  if (items.length) {
    const priced = items.filter(i => i.unitPrice !== null && i.unitPrice !== undefined);

    if (priced.length) {
      const sumAsUnit = round2(priced.reduce((s, i) => s + i.unitPrice * (i.qty || 1), 0));
      const sumAsLine = round2(priced.reduce((s, i) => s + i.unitPrice, 0));
      const multiQty  = priced.some(i => (i.qty || 1) > 1);

      // Any item explicitly marked "/ea" settles it for the whole email.
      const explicitPerEach = priced.some(i => i._perEach);

      let treatAsLineTotal = false;
      if (!explicitPerEach && multiQty && sumAsUnit !== sumAsLine) {
        const target = o.subtotal !== null ? o.subtotal
                     : (o.total !== null
                         ? round2(o.total - (o.tax || 0) - (o.shipping || 0) + (o.discount || 0))
                         : null);
        if (target !== null) {
          treatAsLineTotal = Math.abs(sumAsLine - target) < Math.abs(sumAsUnit - target);
        }
      }

      for (const i of items) {
        if (i.unitPrice === null || i.unitPrice === undefined) continue;
        const qty = i.qty || 1;
        if (treatAsLineTotal) {
          i.lineTotal = round2(i.unitPrice);
          i.unitPrice = qty > 0 ? round2(i.unitPrice / qty) : i.unitPrice;
        } else if (i.lineTotal === null || i.lineTotal === undefined) {
          i.lineTotal = round2(i.unitPrice * qty);
        }
      }
    }

    for (const i of items) delete i._perEach;
  }

  // Fill in whichever totals are missing — but record that we INVENTED them.
  // A shipping-notification email lists items with no financial summary, so the
  // "total" here is just the sum of the lines. That must never be allowed to
  // overwrite the real total captured from the confirmation email.
  o.derived = { subtotal: false, total: false };

  const lineSum = items.length && items.every(i => i.lineTotal !== null && i.lineTotal !== undefined)
    ? round2(items.reduce((s, i) => s + i.lineTotal, 0))
    : null;

  if (o.subtotal === null && lineSum !== null) {
    o.subtotal = lineSum;
    o.derived.subtotal = true;
  }

  if (o.total === null && o.subtotal !== null) {
    o.total = round2(o.subtotal + (o.tax || 0) + (o.shipping || 0) - (o.discount || 0));
    o.derived.total = true;
  }

  // Sanity: a "subtotal" larger than the total (with no discount) is a misread.
  if (o.subtotal !== null && o.total !== null && !o.discount && o.subtotal > o.total + 0.01) {
    const implied = round2(o.total - (o.tax || 0) - (o.shipping || 0));
    if (implied > 0 && lineSum !== null && Math.abs(implied - lineSum) < 0.02) o.subtotal = implied;
  }

  return o;
}

function scoreConfidence(o) {
  let c = 0;
  switch (o.source) {
    case 'jsonld':    c = 0.95; break;
    case 'microdata': c = 0.90; break;
    case 'llm':       c = 0.70; break;
    case 'dom':       c = 0.55; break;
    default:          c = 0.30;
  }
  if (o.orderNumber) c += 0.05;

  // Totals that add up are strong evidence the items were read correctly.
  if (o.items.length && o.subtotal !== null && o.total !== null) {
    const expect = round2(o.subtotal + (o.tax || 0) + (o.shipping || 0) - (o.discount || 0));
    if (Math.abs(expect - o.total) < 0.02) c += 0.15;
  }
  return Math.min(1, round2(c));
}

// ── Public API ───────────────────────────────────────────────────────────────
/**
 * Parse one order email into the canonical shape.
 *
 * @param {object}  input
 * @param {string}  input.html      raw HTML body
 * @param {string}  input.text      plain-text body (used for regex fallbacks + LLM)
 * @param {string}  input.subject
 * @param {string}  input.from      sender address
 * @param {boolean} input.allowLlm  permit the paid AI fallback
 * @returns {Promise<object|null>}  canonical order, or null if nothing usable
 */
async function parseOrderEmail({ html, text, subject, from, allowLlm = false } = {}) {
  let result = emptyOrder();
  const layers = [];

  // 1 — JSON-LD
  try {
    const j = extractJsonLd(html);
    if (j && hasAnything(j)) { result = merge(result, j); layers.push('jsonld'); }
  } catch (e) { /* never let one layer break the rest */ }

  // 2 — Microdata
  if (!result.items.length || !result.orderNumber) {
    try {
      const m = extractMicrodata(html);
      if (m && hasAnything(m)) { result = merge(result, m); layers.push('microdata'); }
    } catch (e) {}
  }

  // 3 — DOM
  if (!result.items.length || result.total === null) {
    try {
      const d = extractDom(html);
      if (d && (d.items.length || d.total !== null)) { result = merge(result, d); layers.push('dom'); }
    } catch (e) {}
  }

  // 3b — Plain-text financials, only for amounts still missing.
  // The DOM walker needs a label and a value it can pair structurally; when the
  // summary is a flowing paragraph or a text/plain part, this catches it.
  if (result.subtotal === null || result.tax === null ||
      result.shipping === null || result.total === null) {
    const sources = [text];
    if (html) sources.push(htmlToText(html));

    for (const src of sources) {
      if (!src) continue;
      const t = extractTextFinancials(src);
      if (result.subtotal === null) result.subtotal = t.subtotal;
      if (result.tax      === null) result.tax      = t.tax;
      if (result.shipping === null) result.shipping = t.shipping;
      if (result.discount === null) result.discount = t.discount;
      if (result.total    === null) result.total    = t.total;
    }
  }

  // 4 — Regex fallbacks for identifiers only
  const haystack = `${subject || ''}\n${text || ''}`;
  if (!result.orderNumber)    result.orderNumber    = findOrderNumberInText(haystack);
  if (!result.trackingNumber) result.trackingNumber = findTrackingInText(haystack);

  // 5 — AI, only if nothing deterministic produced items
  if (allowLlm && !result.items.length) {
    try {
      const l = await extractWithLlm({ subject, from, text });
      if (l && l.items.length) { result = merge(result, l); result.source = 'llm'; layers.push('llm'); }
    } catch (e) {}
  }

  if (!hasAnything(result)) return null;

  reconcile(result);
  result.confidence = scoreConfidence(result);
  result.layers     = layers;
  return result;
}

module.exports = {
  parseOrderEmail,
  reconcile,
  findOrderNumberInText,
  findTrackingInText,
};
