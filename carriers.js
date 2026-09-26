'use strict';
// ─── CARRIER DETECTION + TRACKING LINKS ──────────────────────────────────────
//
// The carrier is identified from the TRACKING NUMBER'S SHAPE. The admin page
// used to guess it from the retailer name instead — and since the retailer is
// "Target", not "UPS", every 1Z… number fell through to a Google search link.
//
// public/admin.html carries a copy of carrierOf()/trackingUrl() (the page has no
// build step). test/ui.test.js asserts the two agree, so they can't drift.
//
// Note: server.js has its own detectCarrier() feeding the auto-tracking job.
// That one is intentionally left alone — the job only knows how to check the
// carriers it returns, so widening it here could break tracking refresh.

const CARRIERS = [
  // order matters: most specific first
  { id: 'ups',    re: /^1Z[0-9A-Z]{16}$/i,
    url: t => `https://www.ups.com/track?tracknum=${encodeURIComponent(t)}` },
  { id: 'amazon', re: /^TBA\d{9,}$/i,
    url: t => `https://track.amazon.com/tracking/${encodeURIComponent(t)}` },
  { id: 'narvar', re: /^87\d{10}$/,                       // Pokemon Center via Narvar
    url: t => `https://www.google.com/search?q=${encodeURIComponent(t + ' tracking')}` },
  { id: 'usps',   re: /^(?:9[1-5]\d{18,24}|82\d{8}|[A-Z]{2}\d{9}US)$/i,
    url: t => `https://tools.usps.com/go/TrackConfirmAction?qtc_tLabels1=${encodeURIComponent(t)}` },
  { id: 'fedex',  re: /^(?:\d{12}|\d{15}|96\d{20}|7489\d{16,18}|61\d{18})$/,
    url: t => `https://www.fedex.com/fedextrack/?trknbr=${encodeURIComponent(t)}` },
  { id: 'ontrac', re: /^[CD]\d{14}$/i,
    url: t => `https://www.ontrac.com/tracking/?number=${encodeURIComponent(t)}` },
];

const clean = t => String(t || '').replace(/\s+/g, '').trim();

function carrierOf(tracking) {
  const t = clean(tracking);
  if (!t) return null;
  const c = CARRIERS.find(c => c.re.test(t));
  return c ? c.id : null;
}

function trackingUrl(tracking) {
  const t = clean(tracking);
  if (!t) return null;
  const c = CARRIERS.find(c => c.re.test(t));
  return c ? c.url(t) : `https://www.google.com/search?q=${encodeURIComponent(t + ' tracking')}`;
}

const CARRIER_LABEL = { ups: 'UPS', usps: 'USPS', fedex: 'FedEx', amazon: 'Amazon', ontrac: 'OnTrac', narvar: 'Narvar' };

module.exports = { carrierOf, trackingUrl, CARRIER_LABEL };
