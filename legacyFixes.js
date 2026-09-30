'use strict';
// ─── ONE-TIME DATA FIXES, SAFE TO RUN ON EVERY START ─────────────────────────
//
// These were hand-written corrections from mid-September (tracking numbers the
// scraper missed at the time, a few statuses). They used to be plain UPDATEs
// that ran on EVERY server start — so every deploy:
//   • put the WRONG tracking back on P0038311805 (a number that belongs to
//     P0038320540), undoing the fix made with ✎, and
//   • forced 16 Pokemon Center orders back to "Shipped", even delivered ones.
//
// Rules now:
//   • a tracking number is only filled in when the order has none;
//   • a status only ever moves FORWARD from Confirmed, and never on a row
//     whose status you set by hand (status_source = 'manual');
//   • nothing here can overwrite what you, the emails or the carrier set later.

const TRACKING = [
  // Bear Walker
  ['25293', '1ZH9146G0309059483'],
  ['25164', '1ZH9146G0308841629'],
  ['24662', '1ZH9146G0304222055'],
  // Pokemon Center, shipped 2026-09-14
  ['P0038241809', '876893093507'],
  ['P0038246261', '876920927416'],
  ['P0038308968', '876921456036'],
  ['P0038309993', '876937213416'],
  ['P0038311805', '876937209516'],   // was wrongly 876928855241 (that's P0038320540's)
  ['P0038320540', '876928855241'],
  ['P0038322055', '876921445510'],
  ['P0038323517', '876937255320'],
  ['P0038323739', '876911355367'],
  ['P0038369919', '876929344074'],
  ['P0038379467', '876921717791'],
  ['P0038408819', '876937413400'],
  ['P0038646655', '876922922325'],
  ['P0038838257', '876923650600'],
  ['P0038964312', '876940016644'],
  ['P0039007837', '876924193616'],
];
const SHIPPED   = TRACKING.map(([n]) => n);           // all of these did ship
const DELIVERED = ['902003606387023'];

const NOT_MANUAL = "COALESCE(status_source,'')<>'manual'";

function applyLegacyFixes(db) {
  let changed = 0;
  const run = (sql, params) => {
    try { const r = db.prepare(sql).run(params); changed += Number((r && r.changes) || 0); } catch (_) { /* column may not exist yet */ }
  };
  for (const [num, trk] of TRACKING) {
    run("UPDATE bot_orders SET tracking=? WHERE order_number=? AND (tracking IS NULL OR tracking='')", [trk, num]);
  }
  for (const num of SHIPPED) {
    run(`UPDATE bot_orders SET status='Shipped' WHERE order_number=? AND status IN ('Confirmed','Unship') AND ${NOT_MANUAL}`, [num]);
  }
  for (const num of DELIVERED) {
    run(`UPDATE bot_orders SET status='Delivered' WHERE order_number=? AND status IN ('Confirmed','Unship','Shipped') AND ${NOT_MANUAL}`, [num]);
  }
  return changed;
}

module.exports = { applyLegacyFixes, TRACKING };
