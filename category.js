'use strict';
// ─── ORDER CATEGORY ──────────────────────────────────────────────────────────
//
// Decided from the ORDER'S ITEM NAMES — clean product text — never from the
// whole email body.
//
// Why: the old check lowercased the entire email and looked for substrings like
// "tcg". A Target email carries ~40 tracking links full of random letters, and
// "tcg" turns up inside them by chance in about 1 email in 10. A Topps baseball
// box and a Ring camera were filed under Pokemon that way. Recommendation
// carousels ("Perfect pairings…") cause the same problem with real words.
//
// Also: "tcg" on its own is not a Pokemon signal (Lorcana, One Piece and
// Magic are all TCGs), and short names need word boundaries ("nami" is inside
// "dynamic", "chopper" is a kitchen tool).

const deaccent = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '');

const RULES = [
  ['Pokemon',   [/pokemon/,     // substring on purpose: catches "LEGOPOKEMONEEVEE"
                 /\b(pikachu|charizard|eevee|mewtwo|bulbasaur|squirtle|charmander|sylveon|umbreon|lucario|greninja|gengar|snorlax|jigglypuff)\b/,
                 /\bpoke ?ball\b/]],
  ['One Piece', [/\bone piece\b/, /\b(luffy|zoro|sanji|nami|tony tony chopper)\b/]],
  ['Mattel',    [/\bmattel\b/, /\bhot wheels?\b/, /\bbarbie\b/, /\bfisher[- ]price\b/, /\buno\b/]],
];

function categoryOfText(text) {
  const s = deaccent(text).toLowerCase();
  for (const [cat, patterns] of RULES) if (patterns.some(re => re.test(s))) return cat;
  return null;
}

function itemList(items) {
  if (Array.isArray(items)) return items;
  try { const a = JSON.parse(items || '[]'); return Array.isArray(a) ? a : [a]; } catch (_) { return []; }
}

// Category the ITEMS point to, weighted by quantity; null if they point nowhere.
function categoryFromItems(items) {
  const votes = {};
  for (const raw of itemList(items)) {
    for (const part of String(raw || '').split(/\s*\|\s*|\n+/)) {
      const cat = categoryOfText(part);
      if (!cat) continue;
      const q = (part.match(/^\s*(\d+)\s*[xX×]\s+/) || [])[1];
      votes[cat] = (votes[cat] || 0) + (q ? parseInt(q, 10) : 1);
    }
  }
  const best = Object.entries(votes).sort((a, b) => b[1] - a[1])[0];
  return best ? best[0] : null;
}

/**
 * @param {object} p
 * @param {string|string[]} [p.items]    the order's items
 * @param {string} [p.subject]           only consulted when there are no items
 * @param {string} [p.retailerDefault]   e.g. Pokemon Center → 'Pokemon'
 */
function decideCategory({ items, subject, retailerDefault } = {}) {
  const hasItems = itemList(items).some(Boolean);
  const fromItems = hasItems ? categoryFromItems(items) : null;
  if (fromItems) return fromItems;
  // No items yet (e.g. a shipping email arrived first): the subject line is
  // short and deliberate; the body is not.
  const fromSubject = !hasItems ? categoryOfText(subject) : null;
  return fromSubject || retailerDefault || 'Other';
}

// Put existing orders back in line with their items. Runs at startup; only
// orders that HAVE items are touched, and every change is logged. Idempotent.
function recategorizeOrders(db, retailerDefaultFor = () => 'Other', log = console.log) {
  let rows = [];
  try {
    rows = db.prepare("SELECT id, order_number, retailer, category, items FROM bot_orders WHERE items IS NOT NULL AND items != '' AND items != '[]'").all();
  } catch (_) { return { checked: 0, changed: 0 }; }
  let changed = 0;
  for (const r of rows) {
    const cat = decideCategory({ items: r.items, retailerDefault: retailerDefaultFor(r.retailer) });
    if (cat !== (r.category || 'Other')) {
      db.prepare('UPDATE bot_orders SET category=? WHERE id=?').run([cat, r.id]);
      changed++;
      log(`   🏷️  #${r.order_number || r.id} (${r.retailer || '?'}): ${r.category || 'Other'} → ${cat}`);
    }
  }
  if (changed) log(`🏷️  Recategorized ${changed} of ${rows.length} order(s) from their items`);
  return { checked: rows.length, changed };
}

module.exports = { decideCategory, categoryFromItems, categoryOfText, recategorizeOrders };
