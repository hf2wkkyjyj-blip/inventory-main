'use strict';
// ─── LAYER 1: JSON-LD (schema.org) ───────────────────────────────────────────
// The highest-quality source by far. Google's Gmail markup spec asks retailers
// to embed <script type="application/ld+json"> with an Order or ParcelDelivery
// entity so Gmail can show purchase tracking. Amazon, Target, Walmart, Best Buy,
// Costco, Sam's Club and every Shopify store emit it.
//
// One parser here covers every retailer that follows the standard — including
// ones nobody has written custom code for.

const cheerio = require('cheerio');
const { flattenNodes, fromNodes } = require('./schemaOrg');

// Some emitters ship slightly invalid JSON (trailing commas, wrapping HTML
// comments, CDATA). Try strict parse first, then a forgiving cleanup.
function safeParse(raw) {
  if (!raw || !raw.trim()) return null;
  try { return JSON.parse(raw); } catch (_) { /* fall through */ }

  const cleaned = raw
    .replace(/<!\[CDATA\[|\]\]>/g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/,\s*([}\]])/g, '$1')      // trailing commas
    .trim();

  try { return JSON.parse(cleaned); } catch (_) { return null; }
}

function extractJsonLd(html) {
  if (!html) return null;

  let $;
  try { $ = cheerio.load(html); } catch (_) { return null; }

  const nodes = [];
  $('script').each((_, el) => {
    const type = ($(el).attr('type') || '').toLowerCase();
    if (!type.includes('ld+json')) return;
    const parsed = safeParse($(el).text());
    if (parsed) flattenNodes(parsed, nodes);
  });

  if (!nodes.length) return null;

  const result = fromNodes(nodes);
  if (!result) return null;

  result.source = 'jsonld';
  return result;
}

module.exports = { extractJsonLd, safeParse };
