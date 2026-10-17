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
