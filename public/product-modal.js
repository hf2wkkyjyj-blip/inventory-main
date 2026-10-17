// Product detail popup, shared by the category pages and the flooring page.
// Usage: include this file, then call openDetail(productId) (e.g. from a card's onclick).
(function () {
  let settings = {};
  fetch('/api/settings').then(r => r.json()).then(s => { settings = s || {}; }).catch(() => {});
  const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const parseImages = raw => { try { return JSON.parse(raw || '[]'); } catch (e) { return []; } };
  const catFaIcon = c => Site.icon(c);

  // The popup's markup is added the first time it's needed, so pages don't have to include it.
  function ensureOverlay() {
    let ov = document.getElementById('detail-overlay');
    if (ov) return ov;
    ov = document.createElement('div');
    ov.className = 'overlay'; ov.id = 'detail-overlay';
    ov.innerHTML = '<div class="detail-modal"><button class="detail-close" type="button" aria-label="Close" onclick="closeDetail()"><i class="fa fa-times"></i></button>' +
      '<div class="detail-gallery" id="detail-gallery"></div><div class="detail-info" id="detail-info"></div></div>';
    ov.addEventListener('click', e => { if (e.target.id === 'detail-overlay') closeDetail(); });
    document.body.appendChild(ov);
    return ov;
  }

  // PRODUCT DETAIL MODAL
  async function openDetail(id) {
    const overlay = ensureOverlay();
    document.getElementById('detail-gallery').innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100%;"><div class="spinner"></div></div>';
    document.getElementById('detail-info').innerHTML = '';
    overlay.classList.add('open');
    document.body.style.overflow = 'hidden';

    try {
      const res = await fetch('/api/products/' + id);
      const p = await res.json();
      const images = parseImages(p.images);
      const stockLabel = {in_stock:'In Stock',low_stock:'Low Stock',out_stock:'Out of Stock'}[p.stock]||p.stock;
      const srcDot = p.source==='Home Depot'?'hd':p.source==="Lowe's"?'lw':'ot';

      const galleryEl = document.getElementById('detail-gallery');
      if (images.length) {
        galleryImages = images;
        galleryIndex = 0;
        galleryEl.innerHTML = `
          <div class="gallery-main">
            <img id="detail-main-img" src="${images[0]}" alt="${esc(p.name)}">
            ${images.length > 1 ? `
              <button class="gallery-nav gallery-prev" onclick="galleryPrev()">&#8249;</button>
              <button class="gallery-nav gallery-next" onclick="galleryNext()">&#8250;</button>
              <div class="gallery-counter" id="gallery-counter">1 / ${images.length}</div>
            ` : ''}
          </div>
          ${images.length > 1 ? `
            <div class="detail-thumbs">
              ${images.map((img,i) => `<img class="detail-thumb${i===0?' active':''}" src="${img}" onclick="gallerySet(${i})">`).join('')}
            </div>
          ` : ''}
        `;
      } else {
        galleryImages = [];
        galleryEl.innerHTML = `<div class="gallery-main"><div class="no-img"><i class="fa fa-${catFaIcon(p.category)}"></i><span style="font-size:13px;color:var(--muted);">${esc(p.category)}</span></div></div>`;
      }

      const qty = p.quantity != null ? p.quantity : 0;
      const qtyColor = qty > 10 ? 'var(--green)' : qty > 0 ? 'var(--yellow)' : 'var(--red)';
      const _detCovM = (p.name||'').match(/([\d.]+)\s*sq\.?\s*ft\.?[^)]*(?:case|box|carton|pack)/i);
      const _detCov = p.coverage_sqft || (_detCovM ? parseFloat(_detCovM[1]) : null);
      const priceHtml = p.price != null
        ? (_detCov
          ? `<div><span class="detail-price">$${(p.price/_detCov).toFixed(2)}<span class="unit"> /sq. ft.</span></span><div style="font-size:13px;color:var(--muted);margin-top:3px;">($${Number(p.price).toFixed(2)} /${p.price_unit||'case'})</div></div>`
          : `<span class="detail-price">$${Number(p.price).toFixed(2)}<span class="unit"> / ${p.price_unit||'each'}</span></span>`)
        : `<span class="detail-price no-price">Call for price</span>`;

      document.getElementById('detail-info').innerHTML = `
        <div class="detail-cat">${esc(p.category)}${p.subcategory?' · '+esc(p.subcategory):''}</div>
        <div class="detail-name">${esc(p.name)}</div>
        ${priceHtml}
        <div class="detail-meta">
          <span class="detail-tag ${p.stock}">${stockLabel}</span>
          <span class="detail-tag"><span class="source-dot ${srcDot}" style="margin-right:2px;"></span>${esc(p.source||'')}</span>
          ${p.sku?`<span class="detail-tag">SKU: ${esc(p.sku)}</span>`:''}
        </div>
        <div class="detail-qty">
          <div>
            <div class="detail-qty-label">Quantity Available</div>
            <div class="detail-qty-unit">${p.price_unit||'units'}</div>
          </div>
          <div class="detail-qty-value" style="color:${qtyColor}">${qty}</div>
        </div>
        ${(()=>{ const m=(p.name||'').match(/([\d.]+)\s*sq\.?\s*ft\.?[^)]*(?:case|box|carton|pack)/i); const cov=p.coverage_sqft||(m?parseFloat(m[1]):null); if(!cov||!p.price||!qty)return''; return `<div style="display:flex;gap:10px;margin-top:10px;">
          <div style="flex:1;background:var(--surface);border:1.5px solid var(--border);border-radius:12px;padding:14px 16px;">
            <div style="font-size:11px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.5px;margin-bottom:4px;">Total Sq Ft Available</div>
            <div style="font-size:22px;font-weight:900;color:var(--navy);">${(qty*cov).toLocaleString('en-US',{maximumFractionDigits:1})} <span style="font-size:13px;font-weight:500;color:var(--muted);">sq ft</span></div>
            <div style="font-size:11px;color:var(--muted);margin-top:2px;">${qty} ${p.price_unit||'boxes'} × ${cov} sq ft each</div>
          </div>
          <div style="flex:1;background:var(--surface);border:1.5px solid var(--border);border-radius:12px;padding:14px 16px;">
            <div style="font-size:11px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.5px;margin-bottom:4px;">Price per Sq Ft</div>
            <div style="font-size:22px;font-weight:900;color:var(--navy);">$${(p.price/cov).toFixed(2)} <span style="font-size:13px;font-weight:500;color:var(--muted);">/ sq ft</span></div>
            <div style="font-size:11px;color:var(--muted);margin-top:2px;">$${Number(p.price).toFixed(2)} per ${p.price_unit||'box'}</div>
          </div>
        </div>`; })()}
        ${p.description?`<div class="detail-desc">${Site.detailHtml(p, esc)}</div>`:''}
        ${p.source_url ? `<a href="${p.source_url}" target="_blank" rel="noopener" style="display:flex;align-items:center;gap:8px;padding:12px 16px;background:var(--accent-light);border:1.5px solid #bfdbfe;border-radius:10px;color:var(--accent);text-decoration:none;font-size:13px;font-weight:700;transition:background .15s;" onmouseover="this.style.background='#dbeafe'" onmouseout="this.style.background='var(--accent-light)'"><i class="fa fa-external-link-alt"></i> View on ${esc(p.source)} for full specs &amp; reviews</a>` : ''}
        <div class="detail-cta">
          <p>Ready to order? Contact us for pricing and availability.</p>
          <a href="tel:${(settings.business_phone||'').replace(/[^0-9]/g,'')}"><i class="fa fa-phone"></i> ${settings.business_phone||'Call us'}</a>
          &nbsp;&nbsp;
          <a href="/#quote"><i class="fa fa-file-alt"></i> Request a Quote</a>
        </div>
      `;
    } catch(e) {
      document.getElementById('detail-info').innerHTML = '<p style="color:var(--muted);padding:20px;">Could not load product details.</p>';
    }
  }

  let galleryImages = [];
  let galleryIndex = 0;
  function gallerySet(idx) {
    galleryIndex = Math.max(0, Math.min(idx, galleryImages.length - 1));
    const img = document.getElementById('detail-main-img');
    if (img) { img.style.opacity = '0'; setTimeout(() => { img.src = galleryImages[galleryIndex]; img.style.opacity = '1'; }, 120); }
    document.querySelectorAll('.detail-thumb').forEach((t, i) => t.classList.toggle('active', i === galleryIndex));
    const counter = document.getElementById('gallery-counter');
    if (counter) counter.textContent = (galleryIndex + 1) + ' / ' + galleryImages.length;
  }
  function galleryPrev() { gallerySet(galleryIndex - 1); }
  function galleryNext() { gallerySet(galleryIndex + 1); }
  function closeDetail() {
    document.getElementById('detail-overlay').classList.remove('open');
    document.body.style.overflow = '';
  }
  document.addEventListener('keydown', e => {
    const ov = document.getElementById('detail-overlay');
    if (!ov || !ov.classList.contains('open')) return;
    if (e.key === 'Escape') closeDetail();
    if (e.key === 'ArrowLeft') galleryPrev();
    if (e.key === 'ArrowRight') galleryNext();
  });


  window.openDetail = openDetail; window.closeDetail = closeDetail;
  window.gallerySet = gallerySet; window.galleryPrev = galleryPrev; window.galleryNext = galleryNext;
})();
