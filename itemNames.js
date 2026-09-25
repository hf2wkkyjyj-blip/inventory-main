'use strict';
// ─── ITEM STRING PARSING ─────────────────────────────────────────────────────
// Items are stored as display strings built by the scraper or the baseline
// import, in several shapes:
//   "2x Pokemon TCG: Booster Bundle (SKU 10-10451-115) @ $35.14"   ← scraper
//   "2x Pokemon 30th Anniversary EX Box 1 ($29.99/ea)"             ← baseline
//   "2x Pokemon TCG: Chaos Rising Bundle (SKU unknown; $29.99/ea)" ← baseline
// Listing, renaming, deleting and the product catalog all need the bare store
// title out of these, and they MUST agree — there is exactly one implementation.

// Trailing tags that are not part of the product title. Stripped repeatedly so
// their order doesn't matter.
const TRAILING_TAGS = [
  /^([\s\S]*?)(\s*@\s*\$?[\d,]+(?:\.\d+)?\s*)$/,                  // " @ $65.24"
  /^([\s\S]*?)(\s*\(\s*\$[\d,]+(?:\.\d+)?\s*\/\s*ea\s*\)\s*)$/i,  // " ($19.99/ea)"
  /^([\s\S]*?)(\s*\(SKU\b[^)]*\)\s*)$/i,                           // " (SKU 10-10451-115)"
  /^([\s\S]+?)(\s+[xX×]\s*\d+)$/,                                  // " x2"
];

function decomposeItem(s) {
  let rest = String(s || '').trim();
  let qtyPrefix = '', suffix = '';
  let m;

  if ((m = rest.match(/^(\d+\s*[xX×]\s+)([\s\S]+)$/))) { qtyPrefix = m[1]; rest = m[2]; }

  for (let changed = true, guard = 0; changed && guard < 8; guard++) {
    changed = false;
    for (const re of TRAILING_TAGS) {
      if ((m = rest.match(re))) { rest = m[1]; suffix = m[2] + suffix; changed = true; }
    }
  }
  return { qtyPrefix, name: rest.trim(), suffix };
}

function parseItemName(s) { return decomposeItem(s).name; }

// Unit price from any of the stored formats, or null.
function parseItemPrice(s) {
  const str = String(s || '');
  const m = str.match(/@\s*\$?\s*([\d,]+(?:\.\d+)?)/) ||
            str.match(/\$\s*([\d,]+(?:\.\d+)?)\s*\/\s*ea\b/i);
  if (!m) return null;
  const n = parseFloat(m[1].replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

function deaccent(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '');
}

// Comparison key for product names. Retailers spell the same product both
// "Pokémon" and "Pokemon", so grouping on the raw lowercase name split one
// product into two rows. Strip accents and collapse whitespace.
function itemKey(s) {
  return deaccent(s).toLowerCase().replace(/\s+/g, ' ').trim();
}

// One stored element can hold several items joined by " | " or newlines.
function splitItemParts(raw) {
  return String(raw || '').split(/\s*\|\s*|\n+/).map(p => p.trim()).filter(Boolean);
}

// ─── SHORT NAME SUGGESTIONS ──────────────────────────────────────────────────
// Store titles are long and front-loaded with boilerplate:
//   "Pokémon Trading Card Game: 30th Celebration Tech Sticker Collection
//    (Lucario or Alolan Exeggutor)- Styles May Vary"
// This proposes a readable name for the product catalog. It is only a
// SUGGESTION — the user can edit it, and the edit is what gets displayed.

const BRAND_PREFIXES = [
  /^pok[eé]mon\s+trading\s+card\s+game\s*[:\-–—]?\s*/i,
  /^pok[eé]mon\s+tcg\s*[:\-–—]?\s*/i,
  /^one\s+piece\s+card\s+game\s*[:\-–—]?\s*/i,
  /^trading\s+card\s+game\s*[:\-–—]?\s*/i,
];
const BARE_BRAND = /^pok[eé]mon\s+/i;

const BOILERPLATE = [
  /\s*[-–—]?\s*\(?\s*styles?\s+may\s+vary\s*\)?/gi,
  /\s*[-–—]\s*in-club\s+purchase\b/gi,
  /\s*\(\s*sku\b[^)]*\)/gi,
  /\s+trading\s+cards?(?=\s*(?:\(|$))/gi,
];
const ITEM_TAG = /\s*\(\s*item\s*#?\s*[\w-]+\s*\)/gi;

const ABBREVIATIONS = [
  [/\bpok[eé]mon\s+center\s+elite\s+trainer\s+box\b/gi, 'PC ETB'],
  [/\belite\s+trainer\s+box\b/gi, 'ETB'],
];

function tidy(s) {
  return s
    .replace(/\s*[–—]\s*/g, ' · ')                               // em/en dash separators
    .replace(/\s+-\s+/g, ' · ')                                  // " - "
    .replace(/([A-Za-z0-9)])-\s+/g, '$1 · ')                     // "Tin- Mega"
    .replace(/\b(Scarlet & Violet|Mega Evolution|Sword & Shield|Sun & Moon)\s*-\s*(?=\S)/g, '$1 · ')
    .replace(/\s{2,}/g, ' ')
    .replace(/^[\s·:,\-]+|[\s·:,\-]+$/g, '')
    .trim();
}

function shortenName(raw) {
  const original = parseItemName(raw);
  let s = original;

  for (const re of BOILERPLATE) s = s.replace(re, '');
  const withItemTag = s;
  s = s.replace(ITEM_TAG, '');

  // Brand prefixes, repeatedly: titles like "Pokemon Pokémon TCG 30th…" stack them.
  for (let changed = true, guard = 0; changed && guard < 5; guard++) {
    changed = false;
    for (const re of BRAND_PREFIXES) {
      const next = s.replace(re, '');
      if (next !== s) { s = next; changed = true; }
    }
    // A bare leading "Pokémon" only goes if something meaningful is left.
    const bare = s.replace(BARE_BRAND, '');
    if (bare !== s && bare.split(/\s+/).length >= 2 && bare.length >= 8) { s = bare; changed = true; }
  }

  for (const [re, rep] of ABBREVIATIONS) s = s.replace(re, rep);
  s = tidy(s);

  // Nothing but a brand word left (e.g. Sam's Club "POKEMON (Item 990518062)"):
  // the item number is the only thing identifying it, so keep it.
  if (!s || /^pok[eé]mon$/i.test(s) || s.length < 4 || !/[a-z]/i.test(s)) {
    s = tidy(withItemTag) || original;
  }
  return s;
}

module.exports = {
  decomposeItem, parseItemName, parseItemPrice, splitItemParts,
  itemKey, deaccent, shortenName,
};
