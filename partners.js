'use strict';
// ─── PARTNERS ────────────────────────────────────────────────────────────────
//
// Some orders are bought for someone else, on their card. Their money is
// theirs (spend + all fees go on their tab, not yours); the units still sit in
// your stock because you sell them; and when they sell, the money is owed back.
//
// Whose order is it? A partner has one profile list PER RETAILER (database
// only — never in code): his account emails and the names on his orders at
// that store. Names alone are not enough — the same names are used on your own
// profiles — so:
//
//   • retailer must match, AND
//   • his account email must match, AND (if the list has names) the name too.
//   • A near-miss — his name but no email saved on the order yet (old orders),
//     or his email with a name not on his list — is NOT moved to his tab. It's
//     flagged "check" so you decide (✎ / His / Mine).
//   • A per-order override (✎) wins over everything: 0 = mine, or a partner id.

const norm = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '')
  .trim().toLowerCase().replace(/\s+/g, ' ');
const list = s => String(s || '').split(/[,;\n]/).map(norm).filter(Boolean);

function loadPartners(db) {
  let rows = [], profs = [];
  try { rows  = db.prepare('SELECT * FROM bot_partners ORDER BY name').all(); } catch (_) {}
  try { profs = db.prepare('SELECT * FROM bot_partner_profiles ORDER BY retailer, id').all(); } catch (_) {}
  return rows.map(p => ({
    ...p,
    profiles: profs.filter(x => x.partner_id === p.id).map(x => ({
      ...x, _retailer: norm(x.retailer), _emails: new Set(list(x.emails)), _names: new Set(list(x.names)),
    })),
  }));
}

/**
 * @returns {{owner: {id,name,match:'manual'|'email+name'|'email'}|null,
 *            check: {id,name,why:string}|null}}
 */
function classifyOrder(order, partners) {
  const ov = order.partner_override;
  if (ov !== null && ov !== undefined && ov !== '') {
    const id = Number(ov);
    const p = id ? partners.find(x => x.id === id) : null;
    return { owner: p ? { id: p.id, name: p.name, match: 'manual' } : null, check: null };   // 0 = explicitly mine
  }
  const retailer = norm(order.retailer);
  const email = norm(order.account_email);
  const name  = norm(order.shipping_name);
  let check = null;
  for (const p of partners) {
    for (const pr of p.profiles || []) {
      if (!pr._retailer || pr._retailer !== retailer) continue;
      const eHit = !!email && pr._emails.has(email);
      const nHit = !!name  && pr._names.has(name);
      const needName = pr._names.size > 0;
      if (eHit && (!needName || nHit)) return { owner: { id: p.id, name: p.name, match: needName ? 'email+name' : 'email' }, check: null };
      if (check) continue;
      if (eHit)                 check = { id: p.id, name: p.name, why: 'his email, but the name isn\'t on his list' };
      else if (nHit && !email)  check = { id: p.id, name: p.name, why: 'his name, but no email saved on this order yet' };
      // his name + a different (non-his) email → that's your account: no flag.
    }
  }
  return { owner: null, check };
}

// Kept for callers that only need the owner.
function partnerFor(order, partners) { return classifyOrder(order, partners).owner; }

// Adds partner_id / partner_name / partner_match (null = yours) and, for
// near-misses, partner_check_id / partner_check_name / partner_check_why.
function annotatePartners(orders, partners) {
  return orders.map(o => {
    const { owner, check } = classifyOrder(o, partners);
    return { ...o,
      partner_id: owner ? owner.id : null, partner_name: owner ? owner.name : null, partner_match: owner ? owner.match : null,
      partner_check_id: check ? check.id : null, partner_check_name: check ? check.name : null, partner_check_why: check ? check.why : null };
  });
}

module.exports = { loadPartners, classifyOrder, partnerFor, annotatePartners, norm };
