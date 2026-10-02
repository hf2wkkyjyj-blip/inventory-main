'use strict';
// ─── TRACKING NUMBER FROM EMAIL TEXT ─────────────────────────────────────────
//
// Read it the way a person does: whatever follows the "Tracking Number:" label,
// in any format. Carriers change formats (Pokemon Center went from 876… to
// 877… and orders silently lost their tracking), so a fixed list of shapes
// can't be the main rule. The known shapes are only a fallback for emails that
// print a number with no label.
//
// Safety: the value must hold at least 6 digits ("Tracking number will be
// emailed…" is not a number) and must not be the order number.

const LABEL = /tracking\s*(?:number|no\.?|num|id|code)?\s*(?:is)?\s*[:#]?\s*/gi;

// Known shapes, used only when nothing is labelled.
const KNOWN = [
  /\b(1Z[A-Z0-9]{16})\b/i,     // UPS
  /\b(87\d{10})\b/,            // Narvar / Pokemon Center (876…, 877…)
  /\b(9[234]\d{18,24})\b/,     // USPS
  /\b(96\d{20})\b/,            // FedEx Ground
  /\b(61\d{18})\b/,            // FedEx SmartPost
  /\b(TBA\d{9,14})\b/i,        // Amazon
];

function clean(v) { return String(v || '').replace(/[\s-]+/g, '').toUpperCase(); }
function plausible(v, orderNumber) {
  if (!v || v.length < 8 || v.length > 40) return false;
  if ((v.match(/\d/g) || []).length < 6) return false;
  if (orderNumber && clean(orderNumber) === v) return false;
  return true;
}

/**
 * @param {string} text
 * @param {{orderNumber?: string}} [opts]
 * @returns {string|null}
 */
function findTrackingNumber(text, { orderNumber } = {}) {
  if (!text) return null;
  const s = String(text).replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');   // markdown links → their text

  // 1 — after a label, any format. One code, optionally in groups of digits
  //     ("9400 1118 9922 3856 9256 83") — never the words that follow it.
  LABEL.lastIndex = 0;
  let m;
  while ((m = LABEL.exec(s))) {
    const after = s.slice(m.index + m[0].length, m.index + m[0].length + 80);
    const v = after.match(/^([A-Z0-9]+(?:[ -]\d{2,6})*)/i);
    if (v && plausible(clean(v[1]), orderNumber)) return clean(v[1]);
  }

  // 2 — no usable label: the shapes we know.
  for (const p of KNOWN) {
    const k = s.match(p);
    if (k && plausible(clean(k[1]), orderNumber)) return clean(k[1]);
  }
  return null;
}

module.exports = { findTrackingNumber };
