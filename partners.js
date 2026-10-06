'use strict';
// ─── PARTNERS ────────────────────────────────────────────────────────────────
//
// Some orders are bought for someone else, on their card. Their money is
// theirs (spend + all fees go on their tab, not yours); the units still sit in
// your stock because you sell them; and when they sell, the money is owed back.
//
// Whose order is it? Matched on the profile you saved (database only — never
// in code): the account email the order went to, or the name on the order.
// A per-order override (✎) wins over the match: 0 = mine, or a partner id.

const norm = s => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
const list = s => String(s || '').split(/[,;\n]/).map(norm).filter(Boolean);

function loadPartners(db) {
  let rows = [];
  try { rows = db.prepare('SELECT * FROM bot_partners ORDER BY name').all(); } catch (_) {}
  return rows.map(p => ({ ...p, _emails: new Set(list(p.emails)), _names: new Set(list(p.names)) }));
}

/** @returns {{id:number,name:string,match:'manual'|'email'|'name'}|null} */
function partnerFor(order, partners) {
  const ov = order.partner_override;
  if (ov !== null && ov !== undefined && ov !== '') {
    const id = Number(ov);
    if (!id) return null;                                // explicitly mine
    const p = partners.find(x => x.id === id);
    return p ? { id: p.id, name: p.name, match: 'manual' } : null;
  }
  const email = norm(order.account_email);
  const name  = norm(order.shipping_name);
  for (const p of partners) {
    if (email && p._emails.has(email)) return { id: p.id, name: p.name, match: 'email' };
  }
  for (const p of partners) {
    if (name && p._names.has(name)) return { id: p.id, name: p.name, match: 'name' };
  }
  return null;
}

// Adds partner_id / partner_name / partner_match to each order (null = yours).
function annotatePartners(orders, partners) {
  return orders.map(o => {
    const p = partnerFor(o, partners);
    return { ...o, partner_id: p ? p.id : null, partner_name: p ? p.name : null, partner_match: p ? p.match : null };
  });
}

module.exports = { loadPartners, partnerFor, annotatePartners };
