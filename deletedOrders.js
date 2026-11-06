'use strict';
// ─── DELETED ORDERS: A COPY IS KEPT, SO A DELETE CAN BE UNDONE ───────────────
//
// Deleting an order used to be final: the row was gone, its number was added to
// the scraper's block list (so the scraper wouldn't bring it back), and that was
// it. The trash button on a product row deleted EVERY order of that product —
// including the ones its filter was hiding — so "delete the 11 cancelled ones"
// took the other 32 with it.
//
// Now every delete first saves the whole row to deleted_orders, and a restore puts
// it back exactly as it was (same id, so check-ins and issue notes reconnect).
//
// For orders deleted BEFORE this existed, only the block list remembers them
// (newest last). planRebuild() finds their saved emails so the scraper can read
// them again; fees you typed by hand, notes and check-ins can't come back that way.

const BLOCK_KEY = 'scraper_blocked_orders';

function ensureTable(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS deleted_orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT, order_id INTEGER, order_number TEXT, retailer TEXT, status TEXT,
    items TEXT, row_json TEXT NOT NULL, checked_at TEXT, reason TEXT, deleted_at TEXT, restored_at TEXT)`);
}

function loadBlocked(db) {
  try {
    const r = db.prepare('SELECT value FROM settings WHERE key=?').get([BLOCK_KEY]);
    const a = r ? JSON.parse(r.value) : [];
    return Array.isArray(a) ? a : [];
  } catch (_) { return []; }
}
function saveBlocked(db, list) {
  db.prepare('INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)').run([BLOCK_KEY, JSON.stringify(list)]);
}
function unblock(db, numbers) {
  const drop = new Set(numbers.map(String));
  const list = loadBlocked(db);
  const keep = list.filter(n => !drop.has(String(n)));
  if (keep.length !== list.length) saveBlocked(db, keep);
  return list.length - keep.length;
}

/** Save a copy of these orders. Call BEFORE deleting; throws if it can't, so nothing is deleted unsaved. */
function archiveOrders(db, ids, reason, at = new Date().toISOString()) {
  ensureTable(db);
  let n = 0;
  for (const id of ids) {
    const row = db.prepare('SELECT * FROM bot_orders WHERE id=?').get([id]);
    if (!row) continue;
    let checked = null;
    try { const c = db.prepare('SELECT checked_at FROM bot_checkins WHERE order_id=?').get([id]); if (c) checked = c.checked_at || ''; } catch (_) {}
    db.prepare(`INSERT INTO deleted_orders (order_id, order_number, retailer, status, items, row_json, checked_at, reason, deleted_at)
                VALUES (?,?,?,?,?,?,?,?,?)`)
      .run([row.id, row.order_number || null, row.retailer || null, row.status || null, row.items || null,
            JSON.stringify(row), checked, reason || null, at]);
    n++;
  }
  return n;
}

/** Orders that can be put back, newest first. */
function listDeleted(db, limit = 300) {
  ensureTable(db);
  return db.prepare(`SELECT id, order_id, order_number, retailer, status, items, reason, deleted_at
                       FROM deleted_orders WHERE restored_at IS NULL ORDER BY id DESC LIMIT ?`).all([limit]);
}

/** Put saved orders back as they were. Returns { restored, already, failed }. */
function restoreDeleted(db, archiveIds, at = new Date().toISOString()) {
  ensureTable(db);
  const cols = db.prepare('PRAGMA table_info(bot_orders)').all().map(c => c.name);
  const out = { restored: 0, already: 0, failed: 0 };
  for (const aid of archiveIds) {
    const a = db.prepare('SELECT * FROM deleted_orders WHERE id=?').get([aid]);
    if (!a || a.restored_at) continue;
    let row; try { row = JSON.parse(a.row_json); } catch (_) { out.failed++; continue; }

    // Its number is already on a live order (the scraper made it again): nothing to put back.
    if (row.order_number && db.prepare('SELECT 1 FROM bot_orders WHERE order_number=?').get([row.order_number])) {
      db.prepare('UPDATE deleted_orders SET restored_at=? WHERE id=?').run([at, aid]);
      unblock(db, [row.order_number]);
      out.already++; continue;
    }
    const idFree = row.id != null && !db.prepare('SELECT 1 FROM bot_orders WHERE id=?').get([row.id]);
    const use = cols.filter(c => c in row && (idFree || c !== 'id'));
    const insert = withEmail => {
      const vals = use.map(c => (c === 'email_id' && !withEmail ? null : row[c]));
      db.prepare(`INSERT INTO bot_orders (${use.join(',')}) VALUES (${use.map(() => '?').join(',')})`).run(vals);
    };
    try { insert(true); }
    catch (_) { try { insert(false); } catch (e) { out.failed++; continue; } }   // email_id is UNIQUE: drop it if taken

    const back = idFree ? row.id : (db.prepare('SELECT id FROM bot_orders WHERE order_number=? ORDER BY id DESC').get([row.order_number]) || {}).id;
    if (a.checked_at !== null && back != null) {
      try { db.prepare('INSERT OR IGNORE INTO bot_checkins (order_id, checked_at) VALUES (?,?)').run([back, a.checked_at || null]); } catch (_) {}
    }
    if (row.order_number) unblock(db, [row.order_number]);
    db.prepare('UPDATE deleted_orders SET restored_at=? WHERE id=?').run([at, aid]);
    out.restored++;
  }
  return out;
}

/**
 * The last `last` order numbers on the block list (what you deleted most recently)
 * and which saved emails mention them.
 * @returns {{numbers: string[], messageIds: Set<string>, noEmail: string[]}}
 */
function planRebuild(db, last) {
  const live = new Set();
  try { db.prepare('SELECT order_number FROM bot_orders WHERE order_number IS NOT NULL').all().forEach(r => live.add(String(r.order_number))); } catch (_) {}
  const numbers = loadBlocked(db).map(String).filter(n => n && !live.has(n)).slice(-Math.max(1, last | 0));
  const found = new Set(), messageIds = new Set();
  if (numbers.length) {
    const re = new RegExp(numbers.map(n => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'g');
    let rows = [];
    try {
      rows = db.prepare(`SELECT message_id, subject, CASE WHEN text IS NULL OR text='' THEN html ELSE text END AS body FROM raw_emails`).all();
    } catch (_) {}
    for (const r of rows) {
      const hay = `${r.subject || ''}\n${r.body || ''}`;
      const m = hay.match(re);
      if (m) { messageIds.add(r.message_id); m.forEach(x => found.add(x)); }
    }
  }
  return { numbers, messageIds, noEmail: numbers.filter(n => !found.has(n)) };
}

module.exports = { ensureTable, archiveOrders, listDeleted, restoreDeleted, planRebuild, unblock, loadBlocked, saveBlocked };
