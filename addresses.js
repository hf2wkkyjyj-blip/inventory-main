'use strict';
// ─── MAIN ADDRESSES ──────────────────────────────────────────────────────────
//
// Orders go out to "jigged" variations of a few real addresses — a leading
// zero or a letter on the house number (013564, 8410c), Avenue/Ave, North/N,
// and invented units (Apt 7d, unit-4-out, Door-1-in, Office). They all land at
// the same door. This maps every variation to one MAIN address so the site
// shows (and groups by) the few places you actually pick up from.
//
// Same place  =  same house number (digits only) + same street name (without
// street type, direction or any unit). Zip and city are ignored for the match —
// jigs change those too — but used for the label.
//
// The original text is never changed in the database: it's what's printed on
// the box label, and it's kept for claims and carrier lookups.

const TYPES = {
  avenue: 'Ave', ave: 'Ave', av: 'Ave', street: 'St', st: 'St', road: 'Rd', rd: 'Rd', drive: 'Dr', dr: 'Dr',
  boulevard: 'Blvd', blvd: 'Blvd', place: 'Pl', pl: 'Pl', lane: 'Ln', ln: 'Ln', court: 'Ct', ct: 'Ct',
  way: 'Way', circle: 'Cir', cir: 'Cir', parkway: 'Pkwy', pkwy: 'Pkwy', highway: 'Hwy', hwy: 'Hwy',
  terrace: 'Ter', ter: 'Ter', trail: 'Trl', trl: 'Trl',
};
const DIRS = {
  north: 'N', n: 'N', south: 'S', s: 'S', east: 'E', e: 'E', west: 'W', w: 'W',
  northeast: 'NE', ne: 'NE', northwest: 'NW', nw: 'NW', southeast: 'SE', se: 'SE', southwest: 'SW', sw: 'SW',
};
// Where the street name ends and the (usually invented) unit begins.
const UNIT = /^(apt|apartment|unit|ste|suite|fl|flr|floor|rm|room|door|dept|bsmt|basement|bldg|building|lot|office|ofc|rear|front|side|back|upstairs|downstairs|garage|shop|#.*|(apt|unit|ste|fl|rm|door)\d+\w*|\d+\w*|in|out)$/;
const STATES = /\b(A[LKZR]|C[AOT]|D[EC]|FL|GA|HI|I[ADLN]|K[SY]|LA|M[ADEINOST]|N[CDEHJMVY]|O[HKR]|PA|RI|S[CD]|T[NX]|UT|V[AT]|W[AIVY])\b/;
const STATE_NAMES = { minnesota: 'MN', texas: 'TX', wisconsin: 'WI', iowa: 'IA', california: 'CA', illinois: 'IL', 'north dakota': 'ND', 'south dakota': 'SD' };

const titleWord = w => /^\d/.test(w) ? w.toLowerCase() : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();

/** Parse one address string. Returns null when there's no house number to go on. */
function parseAddress(raw) {
  let s = String(raw || '').replace(/\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim();
  if (!s) return null;
  const parts = s.split(',').map(x => x.trim()).filter(Boolean);
  // The street line is the first part that starts with a house number
  // ("Maple Grove Sam's Club, 16701 94th Ave N, …" → the second part).
  const si = parts.findIndex(p => /^0*\d+[a-z]?\s+\S/i.test(p));
  if (si < 0) return null;
  const m = parts[si].match(/^0*(\d+)[a-z]?\s+(.*)$/i);
  let words = m[2].toLowerCase().replace(/[-_.]/g, ' ').split(/\s+/).filter(Boolean);
  // A unit starts at a unit word — but a bare number right after a type-only
  // name is the street itself ("Highway 7", "County Rd 81"), not a unit.
  const named = i => words.slice(0, i).some(x => !TYPES[x] && !DIRS[x]);
  const cut = words.findIndex((w, i) => i > 0 && UNIT.test(w) && (named(i) || !/^\d/.test(w)));
  if (cut >= 0) words = words.slice(0, cut);
  // Once the street TYPE (Ave, St, Dr…) and an optional direction after it have
  // appeared, whatever follows is a unit or a jig tag — "4th Ave S Hse",
  // "Maple Ave N Upper" — whatever word gets invented next. (Only when a street
  // name came before the type, so "Highway 7" keeps its number.)
  const ti = words.findIndex((w, i) => TYPES[w] && words.slice(0, i).some(x => !TYPES[x] && !DIRS[x]));
  if (ti >= 0) {
    let end = ti + 1;
    if (words[end] && DIRS[words[end]]) end++;
    words = words.slice(0, end);
  }
  // Stray 1–2 letter jig tags ("qu", "kl", "nh") that aren't a direction or type.
  words = words.filter(w => w.length > 2 || /\d/.test(w) || DIRS[w] || TYPES[w]);
  const core = words.filter(w => !TYPES[w] && !DIRS[w]);
  if (!core.length) return null;

  const tail   = parts.slice(si + 1).join(', ');
  const zipM   = tail.match(/\b(\d{5})(?:-\d{4})?\b/);
  let state    = (tail.match(STATES) || [])[1] || '';
  if (!state) { const sn = Object.keys(STATE_NAMES).find(n => tail.toLowerCase().includes(n)); if (sn) state = STATE_NAMES[sn]; }
  const cityPart = parts.slice(si + 1).find(p => !/\d{5}/.test(p) && !STATES.test(p) && !/united states|usa/i.test(p) && !UNIT.test(p.toLowerCase().split(' ')[0]));
  const city   = cityPart ? cityPart.split(' ').map(titleWord).join(' ') : '';

  return {
    key:    `${m[1]}|${core.join(' ')}`,
    street: `${m[1]} ${words.map(w => TYPES[w] || DIRS[w] || titleWord(w)).join(' ')}`,
    hasType: words.some(w => TYPES[w]),
    city, state, zip: zipM ? zipM[1] : '',
  };
}

const addressKey = raw => { const p = parseAddress(raw); return p ? p.key : null; };

/**
 * Build the address book from every address seen. For each place, the label
 * is the most common clean spelling (preferring one with a street type) plus
 * its most common city/state/zip — e.g. "13564 142nd Ave N, Dayton, MN 55327".
 * @returns {{ main(raw): string|null, groups: {key,label,variants,count}[] }}
 */
function buildAddressBook(rawList) {
  const g = new Map();
  for (const raw of rawList || []) {
    if (!raw) continue;
    const p = parseAddress(raw);
    if (!p) continue;
    if (!g.has(p.key)) g.set(p.key, { streets: new Map(), places: new Map(), variants: new Set(), count: 0 });
    const x = g.get(p.key);
    x.count++;
    x.variants.add(raw);
    const bump = (map, k) => map.set(k, (map.get(k) || 0) + 1);
    bump(x.streets, p.street + (p.hasType ? '' : '\u0000'));
    if (p.zip || p.city) bump(x.places, [p.city, [p.state, p.zip].filter(Boolean).join(' ')].filter(Boolean).join(', '));
  }
  const best = (map, prefer = () => 0) => [...map.entries()].sort((a, b) => (prefer(b[0]) - prefer(a[0])) || (b[1] - a[1]) || a[0].localeCompare(b[0]))[0];
  const labels = new Map();
  for (const [key, x] of g) {
    const st = best(x.streets, s => (s.endsWith('\u0000') ? 0 : 1));
    const pl = x.places.size ? best(x.places, s => (/\d{5}/.test(s) ? 1 : 0))[0] : '';
    labels.set(key, [st[0].replace('\u0000', ''), pl].filter(Boolean).join(', '));
  }
  return {
    main: raw => { if (!raw) return null; const k = addressKey(raw); return k && labels.has(k) ? labels.get(k) : raw; },
    groups: [...g].map(([key, x]) => ({ key, label: labels.get(key), variants: x.variants.size, count: x.count }))
      .sort((a, b) => b.count - a.count),
  };
}

module.exports = { parseAddress, addressKey, buildAddressBook };
