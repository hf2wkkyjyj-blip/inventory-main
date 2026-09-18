'use strict';
// Integration smoke test for the REAL processEmail() code path.
//
// Why this exists: `node --check` only validates syntax, so a leftover reference
// to a renamed variable ("extractedItems is not defined") sails straight through
// it and only fails in production. This test actually executes the function with
// a fake in-memory DB, so undefined variables and bad SQL surface here instead.
//
// node-imap / mailparser aren't needed for parsing, so they're stubbed.

const path = require('path');
const fs   = require('fs');
const Module = require('module');

const originalLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'node-imap')  return function Imap() {};
  if (request === 'mailparser') return { simpleParser: async () => ({}) };
  return originalLoad.apply(this, [request, ...rest]);
};

const { reparseStoredEmails } = require('../emailScraper');

// ── Minimal in-memory stand-in for node-sqlite3-wasm ─────────────────────────
function makeFakeDb(rawEmails) {
  const settings  = new Map();
  const botOrders = [];
  const log       = { inserts: [], updates: [] };

  const stmt = sql => {
    const s = sql.replace(/\s+/g, ' ').trim();
    return {
      all(params = []) {
        if (/FROM raw_emails/i.test(s)) return rawEmails;
        if (/FROM bot_orders/i.test(s)) return botOrders;
        return [];
      },
      get(params = []) {
        if (/FROM settings/i.test(s)) {
          const key = (s.match(/key='([^']+)'/) || [])[1] || params[0];
          return settings.has(key) ? { value: settings.get(key) } : undefined;
        }
        if (/FROM bot_orders/i.test(s)) {
          if (/order_number=\?/.test(s)) return botOrders.find(o => o.order_number === params[0]);
          if (/tracking=\?/.test(s))     return botOrders.find(o => o.tracking === params[0]);
          return undefined;
        }
        return undefined;
      },
      run(params = []) {
        if (/INTO settings/i.test(s)) {
          const key = (s.match(/VALUES \('([^']+)'/) || [])[1] || params[0];
          settings.set(key, params[params.length - 1]);
        } else if (/INTO bot_orders/i.test(s)) {
          const row = {
            id: botOrders.length + 1,
            category: params[0], retailer: params[1], order_number: params[2],
            tracking: params[3], status: params[4], items: params[9],
            order_total: params[10], tax_amount: params[11], ship_cost: params[12],
          };
          botOrders.push(row);
          log.inserts.push(row);
        } else if (/UPDATE bot_orders/i.test(s)) {
          log.updates.push({ sql: s, params });
        }
        return { changes: 1 };
      },
    };
  };

  return { exec() {}, prepare: stmt, _botOrders: botOrders, _log: log, _settings: settings };
}

const fixture = f => fs.readFileSync(path.join(__dirname, 'fixtures', f), 'utf8');

const toText = html => html
  .replace(/<br\s*\/?>/gi, '\n').replace(/<\/(tr|div|p|td|table)>/gi, '\n')
  .replace(/<[^>]+>/g, ' ').replace(/&eacute;/g, 'é').replace(/&amp;/g, '&')
  .replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();

function row(id, subject, from, html) {
  return {
    message_id: id, subject, from_email: from,
    email_date: '2026-08-14T12:00:00.000Z',
    html, text: toText(html),
  };
}

let passed = 0, failed = 0;
const check = (name, cond, detail) => {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else      { failed++; console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`); }
};

(async () => {
  console.log('\n── processEmail() end-to-end via reparseStoredEmails ──');

  const emails = [
    row('<t1@target.com>',  'Thanks for your order',    'orders@target.com',        fixture('target-confirmation.html')),
    row('<p1@pkc.com>',     'Order Confirmation',       'orders@pokemoncenter.com', fixture('pkc-confirmation.html')),
    row('<s1@sams.com>',    'Your order was delivered', 'no-reply@samsclub.com',    fixture('jsonld-samsclub.html')),
    row('<m1@target.com>',  'Weekend sale 30% off',     'deals@target.com',         '<html><body><h1>Sale!</h1></body></html>'),
  ];

  const db = makeFakeDb(emails);

  let result, threw = null;
  try { result = await reparseStoredEmails(db); }
  catch (e) { threw = e; }

  check('no runtime error', !threw, threw && `${threw.message}\n${threw.stack}`);
  if (threw) { console.log(`\n${passed} passed, ${failed} failed`); process.exit(1); }

  check('all 4 emails read', result.total === 4, `got ${result.total}`);
  check('3 orders created (marketing skipped)', db._botOrders.length === 3,
        `got ${db._botOrders.length}: ${db._botOrders.map(o => o.order_number).join(', ')}`);

  const byNum = n => db._botOrders.find(o => o.order_number === n);

  const tgt = byNum('902003676318858');
  check('Target order created', !!tgt);
  if (tgt) {
    const items = JSON.parse(tgt.items || '[]');
    check('Target: exactly 1 item', items.length === 1, items.join(' | '));
    check('Target: correct item text', /Poster Collection/.test(items[0] || ''), items[0]);
    check('Target: no payment junk', !items.some(i => /mastercard|based on/i.test(i)), items.join(' | '));
    check('Target: total 43.39', tgt.order_total === 43.39, String(tgt.order_total));
    check('Target: tax 3.41',    tgt.tax_amount  === 3.41,  String(tgt.tax_amount));
    check('Target: ship 0',      tgt.ship_cost   === 0,     String(tgt.ship_cost));
    check('Target: category Pokemon', tgt.category === 'Pokemon', tgt.category);
  }

  const pkc = byNum('P0040756156');
  check('PKC order created', !!pkc);
  if (pkc) {
    const items = JSON.parse(pkc.items || '[]');
    check('PKC: 2 items', items.length === 2, items.join(' | '));
    check('PKC: no bare "Pokemon TCG:"',
          !items.some(i => /^\d*x?\s*pokemon tcg:\s*(@|$)/i.test(i.trim())), items.join(' | '));
  }

  const sams = byNum('TC9915585140381162319628');
  check("Sam's Club accepted (unknown retailer, JSON-LD)", !!sams);
  if (sams) {
    check("Sam's: retailer name", sams.retailer === "Sam's Club", sams.retailer);
    check("Sam's: status Delivered", sams.status === 'Delivered', sams.status);
    const items = JSON.parse(sams.items || '[]');
    check("Sam's: qty 96 item", /96x/.test(items[0] || ''), items[0]);
  }

  console.log(`\n${'─'.repeat(60)}`);
  console.log(`${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
