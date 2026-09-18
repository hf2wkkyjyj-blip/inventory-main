'use strict';
// ─── LAYER 4: AI FALLBACK (last resort) ──────────────────────────────────────
// Only runs when JSON-LD, microdata and the DOM parser all found zero items.
// That means an email from a retailer with no structured data and no recognizable
// item table — e.g. a Sam's Club in-club receipt or a Mattel Creations confirmation.
//
// Requires ANTHROPIC_API_KEY. If it isn't set this no-ops silently and the email
// is simply skipped, exactly as before. Results are cached per Message-ID by the
// caller, so each email is only ever paid for once.

const { parseMoney, cleanName, emptyOrder, toDate } = require('./normalize');

const MODEL      = 'claude-haiku-4-5-20251001';
const MAX_CHARS  = 12000;
const TIMEOUT_MS = 25000;

const SYSTEM_PROMPT = `You extract structured order data from retail order-confirmation and shipping emails.

Return ONLY a JSON object, no prose, no markdown fences. Use this exact shape:

{
  "orderNumber": string|null,
  "retailer": string|null,
  "status": "Confirmed"|"Shipped"|"OFD"|"Delivered"|"Cancelled"|"Refunded"|null,
  "orderDate": "YYYY-MM-DD"|null,
  "items": [{"name": string, "sku": string|null, "qty": number, "unitPrice": number|null}],
  "subtotal": number|null,
  "tax": number|null,
  "shipping": number|null,
  "total": number|null,
  "trackingNumber": string|null,
  "carrier": string|null,
  "expectedDate": "YYYY-MM-DD"|null,
  "shippingName": string|null,
  "shippingAddress": string|null
}

Rules:
- Include ONLY items the customer actually purchased. Never include recommended,
  suggested, "you might also like", or promotional products.
- unitPrice is the price of ONE unit, not the line total. If the email shows a line
  total, divide by qty.
- Never treat a payment method, card number, zip code, address, tax line, or total
  as a product name.
- Numbers must be plain numbers with no currency symbols.
- Use null for anything not present. Do not guess or invent values.`;

function stripFences(s) {
  return String(s || '').replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
}

function coerce(raw) {
  if (!raw || typeof raw !== 'object') return null;

  const o = emptyOrder();
  o.orderNumber     = raw.orderNumber ? String(raw.orderNumber).trim() : null;
  o.retailer        = cleanName(raw.retailer);
  o.orderDate       = toDate(raw.orderDate);
  o.expectedDate    = toDate(raw.expectedDate);
  o.trackingNumber  = raw.trackingNumber ? String(raw.trackingNumber).trim() : null;
  o.carrier         = cleanName(raw.carrier);
  o.shippingName    = cleanName(raw.shippingName);
  o.shippingAddress = raw.shippingAddress ? String(raw.shippingAddress).slice(0, 250) : null;

  const ALLOWED = ['Confirmed', 'Shipped', 'OFD', 'Delivered', 'Cancelled', 'Refunded'];
  o.status = ALLOWED.includes(raw.status) ? raw.status : null;

  o.subtotal = parseMoney(raw.subtotal);
  o.tax      = parseMoney(raw.tax);
  o.shipping = parseMoney(raw.shipping);
  o.total    = parseMoney(raw.total);

  if (Array.isArray(raw.items)) {
    for (const it of raw.items.slice(0, 50)) {
      const name = cleanName(it && it.name);
      if (!name) continue;
      const qty = parseInt(it.qty, 10);
      o.items.push({
        name,
        sku:       it.sku ? String(it.sku).slice(0, 60) : null,
        qty:       Number.isFinite(qty) && qty > 0 ? qty : 1,
        unitPrice: parseMoney(it.unitPrice),
        lineTotal: null,
        imageUrl:  null,
      });
    }
  }

  o.source = 'llm';
  return o;
}

async function extractWithLlm({ subject, from, text }) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  if (!text || text.trim().length < 40) return null;

  const body = {
    model: MODEL,
    max_tokens: 2000,
    system: SYSTEM_PROMPT,
    messages: [{
      role: 'user',
      content: `From: ${from || 'unknown'}\nSubject: ${subject || '(none)'}\n\n---\n${text.slice(0, MAX_CHARS)}`,
    }],
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type':      'application/json',
        'x-api-key':         apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!res.ok) {
      console.log(`   ⚠️  LLM parse failed: HTTP ${res.status}`);
      return null;
    }

    const data = await res.json();
    const out  = (data.content || []).filter(c => c.type === 'text').map(c => c.text).join('');
    if (!out) return null;

    let parsed;
    try { parsed = JSON.parse(stripFences(out)); }
    catch (_) {
      const m = out.match(/\{[\s\S]*\}/);
      if (!m) return null;
      try { parsed = JSON.parse(m[0]); } catch (_) { return null; }
    }

    const result = coerce(parsed);
    return result && result.items.length ? result : null;

  } catch (e) {
    if (e.name !== 'AbortError') console.log(`   ⚠️  LLM parse error: ${e.message}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { extractWithLlm, coerce, MODEL };
