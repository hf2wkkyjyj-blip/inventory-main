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
    door:       { head: 'Doors, in stock and priced.',      blurb: 'Doors from the shelf, with sizes, handing and full specs listed on every product.' },
    doors:      { head: 'Doors, in stock and priced.',      blurb: 'Doors from the shelf, with sizes, handing and full specs listed on every product.' },
    window:     { head: 'Windows, in stock and priced.',    blurb: 'Windows from the shelf, with sizes and full specs listed on every product.' },
    windows:    { head: 'Windows, in stock and priced.',    blurb: 'Windows from the shelf, with sizes and full specs listed on every product.' },
    toilet:     { head: 'Toilets, in stock and priced.',    blurb: 'Toilets from the shelf, priced live.' },
    toilets:    { head: 'Toilets, in stock and priced.',    blurb: 'Toilets from the shelf, priced live.' },
    shingles:   { head: 'Shingles, in stock and priced.',   blurb: 'Roofing shingles from the shelf, priced live.' },
  };
  const copy = c => COPY[slug(c)] || { head: c + ', in stock now.', blurb: 'Everything we have on the shelf right now, with current prices. Need something else? Request a quote and we\'ll source it.' };
  // Centre a link inside the sticky category bar by scrolling the bar sideways only.
  // (Never use scrollIntoView here: on a sticky bar it also scrolls the page, which fights the visitor's scrolling.)
  const centerInBar = a => { const bar = a.parentElement; bar.scrollLeft = a.offsetLeft - (bar.clientWidth - a.offsetWidth) / 2; };
  const cap = t => String(t || '').charAt(0).toUpperCase() + String(t || '').slice(1);
  // "DURAPLEX Sunridge Oak 20 MIL x 7 in. W …" -> "Sunridge Oak": drop the brand and everything from the first size/spec onward.
  const shortName = p => {
    let n = String(p.name || '').trim();
    if (p.brand && n.toLowerCase().indexOf(String(p.brand).toLowerCase()) === 0) n = n.slice(String(p.brand).length).replace(/^[\s\-\u2013:]+/, '');
    const cut = n.search(/\s+\d+(?:\.\d+)?\s*(?:mil|mm)\b|\s+\d+(?:\.\d+)?\s*in\.|\s+\d+(?:\.\d+)?\s*cu\.?\s*ft/i);
    const out = cut > 2 ? n.slice(0, cut).trim() : n;
    return out || String(p.name || '');
  };
  // Links for the sticky category bar (01 Flooring, 02 Vanity …); `active` is the category being viewed.
  const catBarHtml = (order, active, esc) => order.map((c, i) =>
    '<a class="tone-' + (i % TONES) + (c === active ? ' on' : '') + '" href="' + href(c) + '"><i>' + String(i + 1).padStart(2, '0') + '</i>' + esc(c) + '</a>').join('');
  return { TONES, isFlooring, slug, href, live, sortCats, firstImg, photo, probe, minPrice, types, icon, copy, centerInBar, cap, catBarHtml, shortName };
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


// ── Product descriptions ──
// Imported specs often arrive as a long run of "Label / blank line / value". Turn that into a table
// (key facts on top, the rest grouped and collapsible); everything else becomes tidy paragraphs.
Site.parseSpecs = text => {
  text = String(text || '').replace(/\r/g, '').trim();
  if (!text) return null;
  const rows = [];
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  // Style A: "Label: value" on every line
  if (lines.length >= 3 && lines.filter(l => /^[^:]{2,40}:\s*\S/.test(l)).length >= lines.length * 0.8) {
    lines.forEach(l => { const m = l.match(/^([^:]{2,40}):\s*(.+)$/); if (m) rows.push({ sec: '', k: m[1].trim(), v: m[2].trim() }); });
    return rows.length >= 3 ? rows : null;
  }
  // Style B: blocks split by blank lines alternate label / value (a block can start with a section heading)
  const blocks = text.split(/\n\s*\n/).map(b => b.trim()).filter(Boolean);
  if (blocks.length < 8 || blocks.filter(b => b.length < 60).length < blocks.length * 0.9) return null;
  let sec = '';
  for (let i = 0; i + 1 < blocks.length; i += 2) {
    let label = blocks[i];
    const parts = label.split('\n').map(x => x.trim()).filter(Boolean);
    if (parts.length === 2) { sec = parts[0]; label = parts[1]; } else if (parts.length > 2) return null;
    if (/dimension/i.test(sec) && !/height|width|thickness|depth|length|size|opening|jamb|diameter|clearance|capacity/i.test(label)) sec = 'Details';
    rows.push({ sec, k: label, v: blocks[i + 1].replace(/\s*\n+\s*/g, ' ') });
  }
  return rows.length >= 4 ? rows : null;
};

// Pull the facts a buyer scans for out of ordinary description sentences ("measures 36.5 in. W x 18.75 in. D…",
// "Each case covers 19.63 sq. ft., contains 8 planks…"). Only clear number+unit patterns are used, and the full
// original text is always shown too, so nothing is lost if a pattern misses.
Site.extractFacts = p => {
  const name = String(p.name || ''), desc = String(p.description || '');
  const t = desc + '\n' + name;
  const out = [], add = (k, v) => { if (v != null && v !== '' && !out.some(r => r.k === k)) out.push({ k, v: String(v) }); };
  const m = re => t.match(re);
  const trim = n => String(n).replace(/\.0+$/, '');
  let x;
  // size
  if ((x = m(/measures\s*([\d.]+)\s*in\.?\s*W\s*x\s*([\d.]+)\s*in\.?\s*D\s*x\s*([\d.]+)\s*in\.?\s*H/i))) { add('Width', trim(x[1]) + ' in'); add('Depth', trim(x[2]) + ' in'); add('Height', trim(x[3]) + ' in'); }
  const pw = m(/([\d.]+)\s*in\.?\s*width/i) || m(/x\s*([\d.]+)\s*in\.?\s*W\b/i) || m(/([\d.]+)\s*in\.?\s*x\s*[\d.\-\/]+\s*in\.?\s*planks?/i);
  const pl = m(/([\d.]+(?:-\d+\/\d+)?)\s*in\.?\s*length/i) || m(/x\s*([\d.]+(?:-\d+\/\d+)?)\s*in\.?\s*L\b/i) || m(/[\d.]+\s*in\.?\s*x\s*([\d.\-\/]+)\s*in\.?\s*planks?/i);
  if (pw && pl) add('Plank size', trim(pw[1]) + ' × ' + pl[1] + ' in');
  if ((x = m(/(\d+(?:\.\d+)?)\s*mm\.?\s*(?:thick|thickness)/i) || m(/(\d+(?:\.\d+)?)\s*mm\.?\s*T\b/i))) add('Thickness', trim(x[1]) + ' mm');
  if ((x = m(/(\d+)\s*mil\s*wear\s*layer/i) || m(/\b(\d+)\s*MIL\b/i))) add('Wear layer', x[1] + ' mil');
  if ((x = m(/\bAC\s?([1-5])\b/))) add('Durability rating', 'AC' + x[1]);
  // coverage & packaging
  const cov = p.coverage_sqft || ((x = m(/covers\s*([\d.]+)\s*sq/i) || m(/([\d.]+)\s*sq\.?\s*ft\.?\s*(?:per|\/)\s*(?:case|box|carton)/i)) ? parseFloat(x[1]) : null);
  if (cov) add('Coverage per box', trim(cov) + ' sq ft');
  if ((x = m(/contains\s*(\d+)\s*planks?/i) || m(/(\d+)\s*planks?\s*per\s*(?:box|case)/i) || m(/case quantity:?\s*(\d+)/i))) add('Planks per box', x[1]);
  if ((x = m(/weighs\s*([\d.]+)\s*lbs?/i) || m(/case weight:?\s*([\d.]+)\s*lbs?/i))) add('Box weight', trim(x[1]) + ' lb');
  // performance & install
  if (/100%\s*waterproof/i.test(t)) add('Waterproof', '100%'); else if (/water[- ]resistant/i.test(t)) add('Water resistant', 'Yes');
  if (/above[^.]*grade/i.test(t) && /below[^.]*grade/i.test(t)) add('Install', 'Above, on or below grade');
  if ((x = m(/\b(floating|click[- ]lock|drop[- ]and[- ]lock|glue[- ]down)\b/i))) add('Installation', x[1].replace(/^./, c => c.toUpperCase()));
  if (/(pre-)?attached underlayment/i.test(t)) add('Underlayment', 'Attached');
  // vanity
  if ((x = m(/with an?\s+([^,.]+),\s*([a-z\-]+)-style/i))) { add('Finish', Site.cap(x[1].trim())); add('Style', Site.cap(x[2])); }
  else if ((x = m(/([a-z\-]+)-style design/i))) add('Style', Site.cap(x[1]));
  if ((x = m(/(cultured marble|granite|quartz|engineered stone|marble|ceramic|porcelain|solid surface)\s*(?:vanity\s*)?top/i))) add('Top', Site.cap(x[1]));
  if ((x = m(/predrilled for an?\s+([\d.]+)\s*in\.?\s*(centerset|single[- ]hole|widespread)?/i))) add('Faucet holes', trim(x[1]) + ' in' + (x[2] ? ' ' + x[2].toLowerCase() : ''));
  if ((x = (name.match(/\b(single|double)\s+sink\b/i)))) add('Sinks', Site.cap(x[1].toLowerCase()));
  // warranty (e.g. Duraplex)
  if ((x = m(/(\d+)-year limited residential/i))) add('Residential warranty', x[1] + '-year limited');
  if ((x = m(/(\d+)-year limited light commercial/i))) add('Commercial warranty', x[1] + '-year limited');
  if ((x = m(/Color family:\s*([A-Za-z ]+?)\./i))) add('Color family', x[1].trim());
  return out;
};

// One place that decides what to show for a listing: key facts, specification tables, and the written description.
Site.productFacts = p => {
  const desc = String(p.description || '').trim();
  const rows = Site.parseSpecs(desc);
  const clean = k => k.replace(/\s*\((in|lb|ft|sq\.?\s*ft|mm|cm|lbs?)\.?\)\s*$/i, '');
  if (rows) {
    const get = re => rows.find(r => re.test(clean(r.k)));
    const boxes = [];
    const w = get(/^nominal .*width/i), h = get(/^nominal .*height/i);
    if (w && h) boxes.push(['Size', String(w.v).replace(/\s*in\.?$/i, '') + ' × ' + String(h.v).replace(/\s*in\.?$/i, '') + ' in']);
    [['Type', /^(door |window |product )?type$/i], ['Material', /^(door )?material$/i], ['Handing', /handing$/i], ['Style', /^(door )?style$/i],
     ['Finish', /^(color\/?finish|finish|color family|color)$/i], ['Glass', /^glass style$/i], ['Capacity', /capacity$/i], ['Voltage', /voltage$/i]]
      .forEach(([label, re]) => { const r = get(re); if (r && boxes.length < 6 && !boxes.some(b => b[0] === label)) boxes.push([label, r.v]); });
    if (boxes.length < 4) rows.filter(r => r.v.length <= 22 && !boxes.some(b => b[1] === r.v)).slice(0, 6 - boxes.length).forEach(r => boxes.push([clean(r.k), r.v]));
    const groups = [];
    rows.forEach(r => { const name = r.sec || 'Specifications'; let g = groups.find(x => x.name === name); if (!g) groups.push(g = { name, rows: [] }); g.rows.push({ k: clean(r.k), v: r.v }); });
    return { boxes, groups, prose: '' };
  }
  const ex = Site.extractFacts(p);
  return { boxes: ex.slice(0, 6).map(r => [r.k, r.v]), groups: ex.length >= 3 ? [{ name: 'Specifications', rows: ex }] : [], prose: desc };
};

// Paragraphs for sentences, bullets for a run of short lines.
Site.proseHtml = (text, esc) => String(text || '').trim().split(/\n\s*\n/).map(par => {
  const ls = par.split('\n').map(l => l.trim()).filter(Boolean);
  if (ls.length >= 3 && ls.every(l => l.length < 220)) return '<ul>' + ls.map(l => '<li>' + esc(l) + '</li>').join('') + '</ul>';
  return '<p>' + ls.map(esc).join('<br>') + '</p>';
}).join('');

Site.boxesHtml = (boxes, esc) => boxes.length ? '<div class="spec-key">' + boxes.map(f => '<div><small>' + esc(f[0]) + '</small><b>' + esc(f[1]) + '</b></div>').join('') + '</div>' : '';

Site.detailHtml = (p, esc, opts) => {
  const f = Site.productFacts(p);
  return ((opts && opts.noBoxes) ? '' : Site.boxesHtml(f.boxes, esc)) +
    f.groups.map((g, i) => '<details class="spec-sec"' + (i === 0 ? ' open' : '') + '><summary>' + esc(g.name) + ' <em>' + g.rows.length + '</em></summary><table>' +
      g.rows.map(r => '<tr><th>' + esc(r.k) + '</th><td>' + esc(r.v) + '</td></tr>').join('') + '</table></details>').join('') +
    (f.prose ? '<details class="spec-sec"' + (f.groups.length ? '' : ' open') + '><summary>Description</summary><div class="spec-prose">' + Site.proseHtml(f.prose, esc) + '</div></details>' : '');
};
