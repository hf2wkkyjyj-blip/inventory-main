'use strict';
// ─── LAYER 3b: PLAIN-TEXT FINANCIALS ─────────────────────────────────────────
// Some emails put the order summary somewhere the DOM walker can't pair a label
// with a value — a background-image receipt, a <pre> block, a single flowing
// paragraph, or a text/plain alternative part with no markup at all.
//
// This runs label→amount regexes over flat text purely to fill gaps the DOM layer
// left. It never overrides a value the DOM or structured data already found.
//
// Separator discipline matters: only whitespace, colons and dots are allowed
// between a label and its amount. An earlier version permitted "any non-digit",
// which let "Delivery  Free  Estimated taxes $3.41" match shipping to $3.41.

const { parseMoney } = require('./normalize');

const AMOUNT = '\\$?\\s*([\\d,]+\\.\\d{2})';
const GAP    = '[\\s:.]*';                 // whitespace / colon / dot only
const PAREN  = '(?:\\([^)]*\\))?';         // "(2 items)" style annotation

const re = body => new RegExp(body, 'i');

const PATTERNS = {
  subtotal: [
    re(`\\b(?:order\\s+)?subtotal${GAP}${PAREN}${GAP}${AMOUNT}`),
    re(`\\bsub-total${GAP}${PAREN}${GAP}${AMOUNT}`),
    re(`\\bitems?\\s+total${GAP}${PAREN}${GAP}${AMOUNT}`),
    re(`\\bmerchandise\\s+(?:sub)?total${GAP}${PAREN}${GAP}${AMOUNT}`),
  ],
  tax: [
    re(`\\b(?:estimated\\s+|sales\\s+|state\\s+|local\\s+)*tax(?:es)?${GAP}${PAREN}${GAP}${AMOUNT}`),
  ],
  shipping: [
    re(`\\b(?:retail\\s+delivery(?:\\s+fee)?|delivery(?:\\s+fee)?|shipping(?:\\s*(?:&|and)\\s*handling)?|freight)${GAP}${AMOUNT}`),
  ],
  discount: [
    re(`\\b(?:discount|promotion|promo(?:\\s+code)?|coupon|savings|you\\s+saved)${GAP}-?${AMOUNT}`),
  ],
  total: [
    re(`\\b(?:order\\s+total|grand\\s+total|total\\s+charged|amount\\s+(?:charged|paid|due)|you\\s+paid)${GAP}${AMOUNT}`),
    re(`(?<!\\w)total${GAP}${AMOUNT}`),     // bare "Total" — must not match "Subtotal"
  ],
};

// "Shipping: Free" / "Delivery  FREE" → 0
const FREE_SHIPPING = /\b(?:shipping|delivery)(?:\s+fee)?[\s:.]*free\b/i;

function extractTextFinancials(text) {
  const out = { subtotal: null, tax: null, shipping: null, discount: null, total: null };
  if (!text) return out;

  for (const [field, patterns] of Object.entries(PATTERNS)) {
    for (const p of patterns) {
      const m = text.match(p);
      if (!m) continue;
      const v = parseMoney(m[1]);
      if (v === null) continue;
      out[field] = field === 'discount' ? Math.abs(v) : v;
      break;
    }
  }

  // Free shipping only counts if we didn't already find a shipping charge.
  if (out.shipping === null && FREE_SHIPPING.test(text)) out.shipping = 0;

  return out;
}

module.exports = { extractTextFinancials };
