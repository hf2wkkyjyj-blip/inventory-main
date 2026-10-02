'use strict';
// ─── RE-READ SAVED EMAILS WHEN THE READER GETS BETTER ────────────────────────
//
// The scraper reads each email once. When the reader improves (Pokemon Center
// moving to 877… tracking numbers, addresses being read at all), orders read
// by the OLD code keep their gaps — "Shipped" with no tracking, no address —
// until someone re-reads the saved emails by hand.
//
// After every scan this checks for those gaps and, if there are any, re-reads
// the saved emails (fill-only: nothing already set is overwritten).
// It only re-runs when something changed — the reader's code (a new deploy)
// or the number of gaps — so gaps that genuinely can't be filled don't
// trigger a re-read every two hours.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Fingerprint of the email-reading code: changes on any deploy that touches it.
function readerVersion() {
  const h = crypto.createHash('sha1');
  const files = ['emailScraper.js', 'retailers.js', 'category.js',
    ...fs.readdirSync(path.join(__dirname, 'parser')).filter(f => f.endsWith('.js')).sort().map(f => path.join('parser', f))];
  for (const f of files) { try { h.update(fs.readFileSync(path.join(__dirname, f))); } catch (_) {} }
  return h.digest('hex').slice(0, 12);
}

function countGaps(db) {
  const n = sql => { try { return db.prepare(sql).get().n || 0; } catch (_) { return 0; } };
  return {
    noTracking: n("SELECT COUNT(*) n FROM bot_orders WHERE status='Shipped' AND (tracking IS NULL OR tracking='')"),
    noAddress:  n("SELECT COUNT(*) n FROM bot_orders WHERE status NOT IN ('Cancelled','Refunded') AND (shipping_address IS NULL OR shipping_address='')"),
  };
}

/**
 * @param {object} db
 * @param {(db) => Promise<object>} reparse   reparseStoredEmails
 * @param {{version?: string, after?: (db)=>void, log?: Function}} [opts]
 */
async function healFromSavedEmails(db, reparse, { version = readerVersion(), after, log = console.log } = {}) {
  const gaps = countGaps(db);
  const total = gaps.noTracking + gaps.noAddress;
  if (!total) return { ran: false, reason: 'no gaps', gaps };
  const sig = `${version}|${gaps.noTracking}|${gaps.noAddress}`;
  let last = null;
  try { const r = db.prepare("SELECT value FROM settings WHERE key='heal_signature'").get(); last = r && r.value; } catch (_) {}
  if (last === sig) return { ran: false, reason: 'nothing changed', gaps };

  log(`🩹 ${gaps.noTracking} shipped without tracking, ${gaps.noAddress} without address — re-reading saved emails`);
  await reparse(db);
  if (after) after(db);
  const now = countGaps(db);
  // Remember the state AFTER the re-read: if nothing new happens, don't repeat.
  const sigAfter = `${version}|${now.noTracking}|${now.noAddress}`;
  try { db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('heal_signature', ?)").run([sigAfter]); } catch (_) {}
  log(`🩹 now ${now.noTracking} without tracking, ${now.noAddress} without address`);
  return { ran: true, before: gaps, after: now };
}

module.exports = { healFromSavedEmails, countGaps, readerVersion };
