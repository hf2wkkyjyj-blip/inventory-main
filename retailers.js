'use strict';
// ─── RETAILER PROFILE REGISTRY ───────────────────────────────────────────────
//
// One place describing how each retailer identifies itself: which addresses it
// sends from, what its order numbers look like, and which category its products
// belong to.
//
// Why this beats a broad subject search: asking Gmail for "any mail whose subject
// contains 'order'" drags in a huge amount of marketing, all of which must be
// downloaded and examined. Asking for "mail from these specific senders" is exact
// and cheap. The trade-off is that a retailer must be known first — so the
// registry LEARNS: when an order is successfully parsed from an unrecognised
// sender, that sender is recorded and future runs target it directly.
//
// Order-number patterns below are taken from the user's real order history.

const BUILT_IN = [
  {
    name: 'Target',
    category: 'Other',
    // CONFIRMED: orders@oe.target.com  (order confirmations)
    senders: ['oe.target.com', 'target.com', 'orders.target.com', 'email.target.com', 'e.target.com'],
    // Observed: 912003499321226, 902003677072140, 102003676904439
    orderNumber: [/\b(\d{15,16})\b/],
  },
  {
    name: 'Pokemon Center',
    category: 'Pokemon',
    // CONFIRMED: info@em.pokemon.com  (order confirmations)
    //
    // This is why Pokemon Center confirmations were missing entirely: they come
    // from em.pokemon.com, NOT pokemoncenter.com. Only the Narvar-relayed
    // shipping mail was being matched, which is why every PKC order that did
    // arrive was already "Shipped" and none were "Confirmed".
    senders: ['em.pokemon.com', 'pokemon.com', 'pokemoncenter.com', 'email.pokemoncenter.com', 'e.pokemoncenter.com'],
    // Observed: P0040889108, P0040756156
    orderNumber: [/\b(P\d{9,12})\b/],
  },
  {
    name: 'Mattel Creations',
    category: 'Mattel',
    // CONFIRMED: orders@mattel.com  (order confirmations)
    senders: ['mattel.com', 'mattelcreations.com', 'creations.mattel.com', 'email.mattel.com'],
    // Observed: CHP10033780, CHP9993463
    orderNumber: [/\b(CHP\d{6,12})\b/i],
  },
  // Sam's Club and Costco senders below are UNVERIFIED guesses — these orders
  // currently come from the baseline import, not from email. If mail from them
  // ever does arrive, the learning loop will record the real sender.
  {
    name: "Sam's Club",
    category: 'Other',
    senders: ['samsclub.com', 'sams.com', 'email.samsclub.com', 'e.samsclub.com'],
    // Observed: TC9915585140381162319628 (in-club) and 10425483529 (online).
    // The bare-digit pattern is deliberately last so the distinctive TC form wins.
    orderNumber: [/\b(TC\d{15,25})\b/i, /\border\s*#?\s*(\d{9,12})\b/i],
  },
  {
    name: 'Costco',
    category: 'Other',
    senders: ['costco.com', 'costco.ca', 'online.costco.com'],
    // Observed: 1287328120
    orderNumber: [/\border\s*#?\s*(\d{10})\b/i, /\b(\d{10})\b/],
  },
  {
    name: 'Bear Walker',
    category: 'One Piece',
    // CONFIRMED: info@bearwalker.com  (Shopify store)
    senders: ['bearwalker.com', 'bear-walker.com'],
    // Shopify-style short sequential numbers: 25293, 25164, 24662.
    // These MUST stay anchored to an "order"/"#" marker — a bare 4–6 digit run
    // matches zip codes, prices and dates, which is exactly the class of mistake
    // that produced junk order numbers before.
    orderNumber: [/\border\s*#?\s*(\d{4,6})\b/i, /#(\d{4,6})\b/],
  },
  {
    name: 'Walmart',
    category: 'Other',
    senders: ['walmart.com', 'email.walmart.com'],
    orderNumber: [/\b(\d{7}-\d{8})\b/, /\b(\d{13,15})\b/],
  },
  {
    name: 'GameStop',  category: 'Other', senders: ['gamestop.com', 'email.gamestop.com'], orderNumber: [/\b(\d{10,12})\b/] },
  {
    name: 'Best Buy',  category: 'Other', senders: ['bestbuy.com', 'emailinfo.bestbuy.com'], orderNumber: [/\b(BBY01-\d{12})\b/i, /\b(\d{10,12})\b/] },
  {
    name: 'Amazon',    category: 'Other', senders: ['amazon.com', 'amazon-hq.com'], orderNumber: [/\b(\d{3}-\d{7}-\d{7})\b/] },
  {
    name: 'Shopify Store', category: 'Other', senders: ['shopifyemail.com', 'myshopify.com', 'shopify.com'], orderNumber: [/\border\s*#?\s*(\d{4,8})\b/i] },

  // Narvar relays shipping notifications on behalf of many retailers, so the
  // real retailer must be read from the body rather than the sender.
  { name: 'Narvar', category: 'Other', senders: ['narvar.com'], relay: true, orderNumber: [] },
];

// Retailers whose name may appear in a relayed (Narvar) email body.
const RELAY_BODY_HINTS = [
  ['target.com',        'Target'],
  ['pokemoncenter',     'Pokemon Center'],
  ['pokemon center',    'Pokemon Center'],
  ['walmart',           'Walmart'],
  ['gamestop',          'GameStop'],
  ['best buy',          'Best Buy'],
  ["sam's club",        "Sam's Club"],
  ['samsclub',          "Sam's Club"],
  ['mattel',            'Mattel Creations'],
];

const domainOf = (email) => {
  const m = String(email || '').toLowerCase().match(/@([^>\s,;]+)/);
  return m ? m[1] : String(email || '').toLowerCase().trim();
};

// Match on a domain boundary, not a substring. "oe.target.com" is Target;
// "target.com.phishing.net" is not. Plain `includes` would accept both.
function domainMatches(domain, pattern) {
  if (!domain || !pattern) return false;
  return domain === pattern || domain.endsWith('.' + pattern);
}

const senderMatches = (domain, profile) =>
  (profile.senders || []).some(s => domainMatches(domain, s));

// ── Learned senders ─────────────────────────────────────────────────────────
// { "<domain>": "<Retailer Name>" } — grown automatically at runtime.
function loadLearned(db) {
  try {
    const row = db.prepare("SELECT value FROM settings WHERE key='scraper_learned_senders'").get();
    return row ? JSON.parse(row.value) : {};
  } catch (_) { return {}; }
}

function saveLearned(db, map) {
  try {
    db.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES ('scraper_learned_senders',?)")
      .run([JSON.stringify(map)]);
  } catch (_) {}
}

// Record that `fromEmail` belongs to `retailerName`. Returns true if newly learned.
function learnSender(db, fromEmail, retailerName) {
  const d = domainOf(fromEmail);
  if (!d || !retailerName) return false;
  // Already covered by a built-in profile? Nothing to learn.
  if (BUILT_IN.some(p => senderMatches(d, p))) return false;

  const map = loadLearned(db);
  if (map[d] === retailerName) return false;
  map[d] = retailerName;
  saveLearned(db, map);
  console.log(`   🧠 Learned sender: ${d} → ${retailerName}`);
  return true;
}

// Every sender domain worth searching: built-ins plus everything learned.
function knownSenders(db, extra = []) {
  const learned = Object.keys(loadLearned(db));
  const builtIn = BUILT_IN.flatMap(p => p.senders);
  return [...new Set([...builtIn, ...learned, ...extra])];
}

// Identify the retailer for an email.
function profileFor(fromEmail, bodyText, db) {
  const d = domainOf(fromEmail);
  if (!d) return null;

  const direct = BUILT_IN.find(p => senderMatches(d, p));
  if (direct && !direct.relay) return direct;

  if (direct && direct.relay) {
    const b = (bodyText || '').toLowerCase();
    for (const [needle, name] of RELAY_BODY_HINTS) {
      if (b.includes(needle)) {
        const p = BUILT_IN.find(x => x.name === name);
        if (p) return { ...p, viaRelay: true };
      }
    }
    return { ...direct, category: 'Other' };
  }

  // Learned sender → reuse that retailer's profile if we have one.
  if (db) {
    const name = loadLearned(db)[d];
    if (name) {
      const p = BUILT_IN.find(x => x.name === name);
      if (p) return { ...p, learned: true };
      return { name, category: 'Other', senders: [d], orderNumber: [], learned: true };
    }
  }
  return null;
}

// Try a profile's order-number patterns against the email text.
function orderNumberFor(profile, text) {
  if (!profile || !text) return null;
  for (const re of (profile.orderNumber || [])) {
    const m = text.match(re);
    if (m && m[1]) return m[1].trim();
  }
  return null;
}

module.exports = {
  BUILT_IN, RELAY_BODY_HINTS,
  domainOf, knownSenders, profileFor, orderNumberFor,
  learnSender, loadLearned, saveLearned,
};
