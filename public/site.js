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
  // Centre a link inside the sticky category bar by scrolling the bar sideways only.
  // (Never use scrollIntoView here: on a sticky bar it also scrolls the page, which fights the visitor's scrolling.)
  const centerInBar = a => { const bar = a.parentElement; bar.scrollLeft = a.offsetLeft - (bar.clientWidth - a.offsetWidth) / 2; };
  return { TONES, isFlooring, slug, href, live, sortCats, firstImg, photo, probe, minPrice, types, icon, copy, centerInBar };
})();

// ── Motion (all of it switches off for visitors who ask for reduced motion) ──
Site.motionOK = !(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches);

// Fade/slide elements in as they scroll into view. Call again after you render new content.
Site.reveal = (selector, opts) => {
  opts = opts || {};
  if (!Site.motionOK || !('IntersectionObserver' in window)) return;
  const els = [...document.querySelectorAll(selector)].filter(el => !el.classList.contains('rv'));
  if (!els.length) return;
  const io = new IntersectionObserver(es => es.forEach(e => {
    if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); }
  }), { threshold: 0.1, rootMargin: '0px 0px -5% 0px' });
  els.forEach((el, i) => {
    el.classList.add('rv');
    if (opts.from === 'left') el.classList.add('rv-l'); else if (opts.from === 'right') el.classList.add('rv-r');
    const d = (opts.delay || 0) + (opts.stagger ? (i % 8) * opts.stagger : 0);
    if (d) el.style.animationDelay = d + 'ms';
    io.observe(el);
  });
};

// Count a number up from 0 when it scrolls into view.
Site.countUp = (el, to, ms) => {
  to = Number(to);
  const set = v => { el.textContent = Math.round(v).toLocaleString('en-US'); };
  if (!Site.motionOK || !('IntersectionObserver' in window) || !isFinite(to)) { el.textContent = isFinite(to) ? to.toLocaleString('en-US') : el.textContent; return; }
  set(0);
  const io = new IntersectionObserver(es => {
    if (!es.some(e => e.isIntersecting)) return;
    io.disconnect();
    const t0 = performance.now(), dur = ms || 1100;
    (function tick(now) {
      const p = Math.min(1, (now - t0) / dur), e = 1 - Math.pow(1 - p, 3);
      set(to * e);
      if (p < 1) requestAnimationFrame(tick); else set(to);
    })(t0);
  }, { threshold: 0.4 });
  io.observe(el);
};

// A floor being laid, plank by plank, in each Duraplex colour in turn. Fills the container (see .planks in site.css).
Site.planks = el => {
  if (!el) return;
  const FAMILIES = [   // three tones per colour so the floor looks like a real mixed run
    ['#cfae7c', '#dcc196', '#c19c68'],   // Sunridge Oak
    ['#b3b1a8', '#a3a198', '#c1bfb7'],   // Stonebrook
    ['#85827c', '#726f69', '#948f88'],   // Overshore Oak
    ['#7d5d3f', '#6b4d33', '#8d6b49'],   // Caprino Oak
    ['#e7dece', '#d9cebb', '#f0e8da'],   // Chantilly Hickory
    ['#cc9d58', '#bb8c4a', '#d8ac6a'],   // Honeymark
  ];
  const ROWS = 8;
  let seed = 11; const rnd = () => (seed = (seed * 9301 + 49297) % 233280) / 233280;
  let html = '';
  for (let r = 0; r < ROWS; r++) {
    let x = -rnd() * 0.28, k = 0;
    while (x < 1) {
      const len = 0.24 + rnd() * 0.2;
      html += '<i class="pl t' + Math.floor(rnd() * 3) + '" style="left:' + (x * 100).toFixed(2) + '%;width:' + (len * 100).toFixed(2) + '%;top:' + (r * 100 / ROWS).toFixed(3) + '%;height:' + (100 / ROWS).toFixed(3) + '%;--d:' + (r * 0.24 + k * 0.1).toFixed(2) + 's"></i>';
      x += len; k++;
    }
  }
  el.innerHTML = html;
  let fam = 0;
  const paint = () => { FAMILIES[fam % FAMILIES.length].forEach((c, i) => el.style.setProperty('--t' + i, c)); };
  paint();
  if (!Site.motionOK) { el.classList.add('static'); return; }
  // Pause button: the floor loops, so visitors can stop it (it then rests as a finished floor).
  let paused = false, timers = [];
  const host = el.parentElement;
  const btn = document.createElement('button');
  btn.type = 'button'; btn.className = 'motion-toggle'; btn.setAttribute('aria-label', 'Pause floor animation');
  btn.innerHTML = '<i class="fa fa-pause" aria-hidden="true"></i>';
  host.appendChild(btn);
  const stopTimers = () => { timers.forEach(clearTimeout); timers = []; };
  const cycle = () => {
    if (paused) return;
    if (document.hidden) { timers.push(setTimeout(cycle, 1000)); return; }   // don't animate in a background tab
    paint(); el.classList.remove('out', 'play', 'static');
    void el.offsetWidth;                       // restart the animation
    el.classList.add('play');
    timers.push(setTimeout(() => el.classList.add('out'), 5600));
    timers.push(setTimeout(() => { fam++; cycle(); }, 6400));
  };
  btn.onclick = () => {
    paused = !paused;
    btn.setAttribute('aria-label', paused ? 'Play floor animation' : 'Pause floor animation');
    btn.firstChild.className = 'fa fa-' + (paused ? 'play' : 'pause');
    stopTimers();
    if (paused) { el.classList.remove('out', 'play'); el.classList.add('static'); } else cycle();
  };
  cycle();
};
