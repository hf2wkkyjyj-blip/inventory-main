// Shows a photo behind a header band if the file exists; otherwise the band keeps its light textured look.
// It also looks for a looping video with the same name (hero.jpg -> hero.mp4 / hero.webm). If you drop one
// into public/, it plays muted behind the headline. Skipped when the visitor asked for reduced motion.
function bandPhoto(selector, file) {
  const el = document.querySelector(selector);
  if (!el) return;
  const im = new Image();
  im.onload = () => el.style.setProperty('--band-img', "url('" + file + "')");
  im.src = file;
  bandVideo(el, file.replace(/\.\w+$/, ''), file);
}

async function bandVideo(el, base, poster) {
  if (window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const found = [];
  for (const [ext, type] of [['mp4', 'video/mp4'], ['webm', 'video/webm']]) {
    try {
      const r = await fetch(base + '.' + ext, { method: 'HEAD' });
      if (r.ok && /^video\//.test(r.headers.get('content-type') || '')) found.push([ext, type]);
    } catch (e) {}
  }
  if (!found.length) return;
  const v = document.createElement('video');
  v.className = 'band-video';
  v.muted = true; v.loop = true; v.autoplay = true; v.playsInline = true; v.preload = 'metadata';
  v.setAttribute('muted', ''); v.setAttribute('playsinline', ''); v.setAttribute('aria-hidden', 'true');
  v.poster = poster;
  found.forEach(([ext, type]) => { const s = document.createElement('source'); s.src = base + '.' + ext; s.type = type; v.appendChild(s); });
  const fade = document.createElement('div');
  fade.className = 'band-fade';
  el.prepend(fade); el.prepend(v);
  el.classList.add('has-video');
  v.play().catch(() => {});
}

// ── Shared category helpers (Materials overview, category pages, homepage tiles) ──
window.Site = (() => {
  const TONES = 6;   // .tone-0 … .tone-5 in site.css
  const isFlooring = c => /^flooring$/i.test(c);
  const slug = c => String(c).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  // Flooring has its own page (room calculator); every other category uses the shared category page.
  const href = c => isFlooring(c) ? '/flooring.html' : '/category.html?cat=' + encodeURIComponent(c);
  const live = items => (items || []).filter(p => p.stock !== 'out_stock');
  // Flooring leads; the rest go by how much is in stock. A category's position decides its colour.
  const sortCats = (cats, by) => cats.slice().sort((a, b) =>
    (isFlooring(b) - isFlooring(a)) || live(by[b]).length - live(by[a]).length || a.localeCompare(b));
  const firstImg = items => { for (const p of items || []) { try { const im = (JSON.parse(p.images || '[]') || [])[0]; if (im) return im; } catch (e) {} } return ''; };
  // A product photo for the category (Duraplex first for Flooring) until you add your own /cat-<name>.jpg.
  const photo = (c, items) => { const l = live(items); return firstImg(isFlooring(c) ? l.filter(p => /duraplex/i.test(p.source || '')).concat(l) : l); };
  // Calls ok(url) if you've added your own photo for this category.
  const probe = (c, ok) => { const u = '/cat-' + slug(c) + '.jpg', im = new Image(); im.onload = () => ok(u); im.src = u; };
  const minPrice = items => { const v = live(items).map(p => p.price).filter(x => x != null && x > 0); return v.length ? Math.min(...v) : null; };
  const types = items => { const m = {}; live(items).forEach(p => { if (p.subcategory) m[p.subcategory] = (m[p.subcategory] || 0) + 1; }); return Object.keys(m).sort((a, b) => m[b] - m[a]); };
  const ICON = { flooring: 'layer-group', vanity: 'sink', vanities: 'sink', appliances: 'kitchen-set', tools: 'screwdriver-wrench' };
  const icon = c => ICON[slug(c)] || 'box-open';
  const COPY = {
    flooring:   { head: 'Flooring, stocked for the job.',   blurb: 'Vinyl plank, laminate and tile on the shelf. Use the room calculator to see how many boxes you need.' },
    vanity:     { head: 'Vanities, ready to pull.',         blurb: 'Bathroom vanities in stock and priced live from the shelf.' },
    vanities:   { head: 'Vanities, ready to pull.',         blurb: 'Bathroom vanities in stock and priced live from the shelf.' },
    appliances: { head: 'Appliances, in stock and priced.', blurb: 'Kitchen appliances from the shelf. Ask us about availability.' },
    tools:      { head: 'Tools for the job site.',          blurb: 'Hand and power tools in stock, priced live.' },
  };
  const copy = c => COPY[slug(c)] || { head: c + ', in stock now.', blurb: 'Everything we have on the shelf right now, with current prices. Need something else? Request a quote and we\'ll source it.' };
  return { TONES, isFlooring, slug, href, live, sortCats, firstImg, photo, probe, minPrice, types, icon, copy };
})();
