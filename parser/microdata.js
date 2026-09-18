'use strict';
// ─── LAYER 2: MICRODATA ──────────────────────────────────────────────────────
// Same schema.org vocabulary as JSON-LD, but encoded as itemscope/itemprop
// attributes on the HTML itself. Older retailer templates use this form.
// We convert it into the same plain-object shape and reuse the JSON-LD extractors.

const cheerio = require('cheerio');
const { flattenNodes, fromNodes } = require('./schemaOrg');

// Build a plain object from an [itemscope] element, recursing into nested scopes.
function nodeToObject($, el, depth = 0) {
  if (depth > 10) return {};

  const obj = {};
  const itemtype = $(el).attr('itemtype');
  if (itemtype) obj['@type'] = String(itemtype).split(/[/#]/).pop();

  $(el).find('[itemprop]').each((_, prop) => {
    // Only take properties belonging directly to this scope, not nested ones.
    const ownerScope = $(prop).parents('[itemscope]').first().get(0);
    if (ownerScope !== el) return;

    const name = $(prop).attr('itemprop');
    if (!name) return;

    let value;
    if ($(prop).attr('itemscope') !== undefined) {
      value = nodeToObject($, prop, depth + 1);
    } else {
      value =
        $(prop).attr('content')  ??
        $(prop).attr('datetime') ??
        $(prop).attr('href')     ??
        $(prop).attr('src')      ??
        $(prop).text().replace(/\s+/g, ' ').trim();
    }
    if (value === '' || value === undefined) return;

    if (obj[name] === undefined)      obj[name] = value;
    else if (Array.isArray(obj[name])) obj[name].push(value);
    else                               obj[name] = [obj[name], value];
  });

  return obj;
}

function extractMicrodata(html) {
  if (!html) return null;
  if (!/itemscope/i.test(html)) return null;   // cheap bail-out

  let $;
  try { $ = cheerio.load(html); } catch (_) { return null; }

  // Top-level scopes only — nested ones are picked up recursively.
  const roots = $('[itemscope]').filter((_, el) => $(el).parents('[itemscope]').length === 0);
  if (!roots.length) return null;

  const nodes = [];
  roots.each((_, el) => flattenNodes(nodeToObject($, el), nodes));
  if (!nodes.length) return null;

  const result = fromNodes(nodes);
  if (!result) return null;

  result.source = 'microdata';
  return result;
}

module.exports = { extractMicrodata };
