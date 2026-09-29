'use strict';
// ─── SHIP-TO FROM EMAIL TEXT ─────────────────────────────────────────────────
//
// Orders created from emails never had an address: nothing looked for one.
// Stores print it in two shapes:
//
//   Target   "Delivers to:" then  "Name, 12 Street Ave N, City, ST 55000"
//            (same line or the next one)
//   Mattel / Shopify / most others — a block under a heading:
//            Shipping Address
//            Name
//            12 Street Ave N, unit 3
//            City, State 55000
//            United States
//
// Only accepted when it has a house number and a 5-digit zip, so a "Shipping
// $0.00" total line or a store's footer address can't be mistaken for it.

const HEADINGS = /^(shipping address|ship(ping)? to|delivery address|delivering to|deliver to|shipped to|shipment address|address)\s*:?\s*$/i;
const ZIP      = /\b\d{5}(?:-\d{4})?\b/;
const STREET   = /^0*\d+[a-z]?\s+\S/i;
// Lines that end an address block: country, links/buttons, and email-footer
// words — past them comes the STORE's own address, which must never be taken.
const JUNK     = /^(united states|usa|us|https?:|track|view|manage|edit|change|my account|account|help|contact|customer service|privacy|terms|unsubscribe|shop|community|membership|please|©|\(c\)|copyright)\b/i;

function clean(s) {
  return String(s || '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/\s+/g, ' ').trim();
}

// "Name, 12 Street, City, ST 55000" → { name, address }
function splitNameFirst(line) {
  const parts = clean(line).split(',').map(p => p.trim()).filter(Boolean);
  const si = parts.findIndex(p => STREET.test(p));
  if (si < 0) return null;
  const address = parts.slice(si).join(', ');
  if (!ZIP.test(address)) return null;
  return { name: parts.slice(0, si).join(', ') || null, address };
}

/**
 * @param {string} text  plain text (or HTML flattened to text), line breaks kept
 * @returns {{name: string|null, address: string}|null}
 */
function extractShipTo(text) {
  if (!text) return null;
  const lines = String(text).split(/\r?\n/).map(clean).filter(Boolean);

  // 1 — "Delivers to:" (Target), value on the same line or the next.
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^deliver(?:s|ing)? to:?\s*(.*)$/i);
    if (!m) continue;
    const r = splitNameFirst(m[1] || lines[i + 1] || '');
    if (r) return r;
  }

  // 2 — Everything on one line after the label (Pokemon Center):
  //     "Shipping Address: Name Surname 1 Test St apt 3f Springfield, MN 55001 US"
  for (const l of lines) {
    const m = l.replace(/^\|\s*|\s*\|$/g, '').match(/^(?:shipping address|ship(?:ping)? to)\s*:\s*(.+)$/i);
    if (!m) continue;
    const v = m[1].replace(/\s+(US|USA|United States)\s*$/i, '').trim();
    const at = v.search(/\b0*\d+[a-z]?\s+\S/i);
    if (at < 0 || !ZIP.test(v.slice(at))) continue;
    return { name: v.slice(0, at).trim() || null, address: v.slice(at).trim() };
  }

  // 3 — A heading, then name / street / city-state-zip lines.
  for (let i = 0; i < lines.length; i++) {
    if (!HEADINGS.test(lines[i])) continue;
    const block = [];
    for (let j = i + 1; j < Math.min(lines.length, i + 7); j++) {
      if (JUNK.test(lines[j]) || HEADINGS.test(lines[j])) break;
      block.push(lines[j]);
      if (ZIP.test(lines[j]) && block.some(l => STREET.test(l))) break;
    }
    if (block.length === 1) { const r = splitNameFirst(block[0]); if (r) return r; continue; }
    const si = block.findIndex(l => STREET.test(l));
    const zi = block.findIndex((l, k) => k >= si && ZIP.test(l));
    if (si < 0 || zi < 0) continue;
    const name = si > 0 ? block.slice(0, si).join(' ') : null;
    return { name, address: block.slice(si, zi + 1).join(', ') };
  }
  return null;
}

module.exports = { extractShipTo };
