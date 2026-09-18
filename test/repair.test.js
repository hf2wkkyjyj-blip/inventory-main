'use strict';
// Proves the status rebuild can undo statuses written by the old buggy detector.
//
// Scenario: the old code did body.includes('cancel'), so a shipping email whose
// footer said "Cancel order" stored the order as Cancelled. Because Cancelled
// outranks everything, no later email could correct it. These orders are stuck
// until status is re-derived from scratch.

const Module = require('module');
const originalLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'node-imap')  return function Imap() {};
  if (request === 'mailparser') return { simpleParser: async () => ({}) };
  return originalLoad.apply(this, [request, ...rest]);
};

const { reparseStoredEmails } = require('../emailScraper');

let passed = 0, failed = 0;
const eq = (n, a, e) => {
  if (a === e) { passed++; console.log(`  ✅ ${n}`); }
  else { failed++; console.log(`  ❌ ${n} — got ${JSON.stringify(a)}, expected ${JSON.stringify(e)}`); }
};

const FOOTER = 'Need to make changes? Cancel order within 30 minutes. See our cancellation policy and refund policy.';

function makeDb(orders, emails) {
  const settings = new Map();
  return {
    exec() {},
    _orders: orders,
    prepare(sql) {
      const s = sql.replace(/\s+/g, ' ').trim();
      return {
        all(p = []) {
          if (/FROM raw_emails/i.test(s)) return emails;
          if (/GROUP BY status/i.test(s)) {
            const m = {};
            orders.forEach(o => { m[o.status] = (m[o.status] || 0) + 1; });
            return Object.entries(m).map(([status, n]) => ({ status, n }));
          }
          if (/FROM bot_orders/i.test(s)) return orders;
          return [];
        },
        get(p = []) {
          if (/FROM settings/i.test(s)) {
            const k = (s.match(/key='([^']+)'/) || [])[1] || p[0];
            return settings.has(k) ? { value: settings.get(k) } : undefined;
          }
          if (/COUNT\(\*\)/i.test(s)) return { n: orders.length };
          if (/FROM bot_orders/i.test(s)) {
            if (/order_number=\?/.test(s)) return orders.find(o => o.order_number === p[0]);
            if (/tracking=\?/.test(s))     return orders.find(o => o.tracking === p[0]);
          }
          return undefined;
        },
        run(p = []) {
          if (/INTO settings/i.test(s)) {
            const k = (s.match(/VALUES \('([^']+)'/) || [])[1] || p[0];
            settings.set(k, p[p.length - 1]);
          } else if (/UPDATE bot_orders/i.test(s)) {
            const id = p[p.length - 1];
            const row = orders.find(o => o.id === id);
            if (row) {
              const cols = s.match(/SET (.+?) WHERE/i)[1].split(',').map(c => c.split('=')[0].trim());
              cols.forEach((c, i) => { row[c] = p[i]; });
            }
          }
          return { changes: 1 };
        },
      };
    },
  };
}

function email(id, date, subject, body, orderNo, tracking) {
  const html = `<html><body><p>Order #${orderNo}</p>${tracking ? `<p>Tracking: ${tracking}</p>` : ''}<p>${body}</p><p>${FOOTER}</p></body></html>`;
  return {
    message_id: id, subject, from_email: 'orders@oe.target.com',
    email_date: date, html,
    text: `Order #${orderNo} ${tracking ? 'Tracking: ' + tracking : ''} ${body} ${FOOTER}`,
  };
}

(async () => {
  console.log('\n── Falsely-cancelled order, emails say Confirmed only ──');
  {
    // No tracking anywhere, so correctingBadCancel cannot fire.
    const orders = [{ id: 1, order_number: '902003676318858', status: 'Cancelled', category: 'Pokemon', retailer: 'Target', tracking: null, items: null, order_total: null }];
    const emails = [email('<a1>', '2026-08-14T10:00:00Z', 'Thanks for your order', 'Your order has been placed.', '902003676318858', null)];

    const plain = await reparseStoredEmails(makeDb(JSON.parse(JSON.stringify(orders)), emails));
    eq('plain reparse leaves it Cancelled', plain.after.Cancelled, 1);

    const db = makeDb(JSON.parse(JSON.stringify(orders)), emails);
    const rebuilt = await reparseStoredEmails(db, { rebuildStatus: true });
    eq('rebuild corrects it to Confirmed', db._orders[0].status, 'Confirmed');
    eq('no Cancelled left', rebuilt.after.Cancelled, undefined);
  }

  console.log('\n── Timeline replays in order: Confirmed → Shipped → Delivered ──');
  {
    const orders = [{ id: 1, order_number: '102003676904439', status: 'Cancelled', category: 'Pokemon', retailer: 'Target', tracking: null, items: null, order_total: null }];
    const emails = [
      email('<c>', '2026-09-10T10:00:00Z', 'Thanks for your order',   'Your order has been placed.',    '102003676904439', null),
      email('<s>', '2026-09-12T10:00:00Z', 'Your order has shipped',  'Your package is on its way.',    '102003676904439', '1ZWY06570304019606'),
      email('<d>', '2026-09-14T10:00:00Z', 'Your order was delivered','Your package was delivered.',    '102003676904439', '1ZWY06570304019606'),
    ];
    const db = makeDb(orders, emails);
    await reparseStoredEmails(db, { rebuildStatus: true });
    eq('ends Delivered, not stuck', db._orders[0].status, 'Delivered');
    eq('tracking captured', db._orders[0].tracking, '1ZWY06570304019606');
  }

  console.log('\n── A genuine cancellation must survive the rebuild ──');
  {
    const orders = [{ id: 1, order_number: '912003440498135', status: 'Confirmed', category: 'Pokemon', retailer: 'Target', tracking: null, items: null, order_total: null }];
    const emails = [
      email('<c>', '2026-08-01T10:00:00Z', 'Thanks for your order',        'Your order has been placed.',                   '912003440498135', null),
      email('<x>', '2026-08-03T10:00:00Z', 'Your order was cancelled',     'Your order has been cancelled and refunded.',   '912003440498135', null),
    ];
    const db = makeDb(orders, emails);
    await reparseStoredEmails(db, { rebuildStatus: true });
    eq('real cancellation preserved', db._orders[0].status, 'Cancelled');
  }

  console.log(`\n${'─'.repeat(60)}`);
  console.log(`${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
