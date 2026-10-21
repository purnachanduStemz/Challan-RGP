/* Shared motion + UX helpers (loaded after api.js on every page) */
const UI = (() => {
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function toast(message, kind = 'success') {
    let box = document.getElementById('uiToasts');
    if (!box) { box = document.createElement('div'); box.id = 'uiToasts'; document.body.appendChild(box); }
    const el = document.createElement('div');
    el.className = `ui-toast ${kind}`;
    el.innerHTML = `<i>${kind === 'error' ? '!' : '✓'}</i><span>${esc(message)}</span>`;
    box.appendChild(el);
    const kill = () => { el.classList.add('out'); setTimeout(() => el.remove(), 260); };
    el.onclick = kill; setTimeout(kill, 4000);
  }

  // Animated hide for modal overlays that the page shows/hides via style.display.
  function hide(overlay, done) {
    if (!overlay || overlay.style.display === 'none') return;
    overlay.classList.add('leaving');
    setTimeout(() => { overlay.classList.remove('leaving'); overlay.style.display = 'none'; done && done(); }, reduce ? 0 : 200);
  }

  // Promise-based replacement for window.confirm.
  function confirm(message, { title = 'Please confirm', ok = 'Confirm', danger = false } = {}) {
    return new Promise((resolve) => {
      const ov = document.createElement('div');
      ov.className = 'modal-overlay';
      ov.innerHTML = `<div class="modal ui-confirm" style="width:400px" role="dialog" aria-modal="true"><h2>${esc(title)}</h2><p>${esc(message)}</p>
        <div style="margin-top:18px;text-align:right"><button class="btn btn-secondary" data-r="0">Cancel</button><button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-r="1" style="margin-right:0">${esc(ok)}</button></div></div>`;
      const finish = (v) => { document.removeEventListener('keydown', onKey); ov.classList.add('leaving'); setTimeout(() => ov.remove(), 200); resolve(v); };
      const onKey = (e) => { if (e.key === 'Escape') finish(false); if (e.key === 'Enter') finish(true); };
      ov.addEventListener('mousedown', (e) => { if (e.target === ov) finish(false); });
      ov.querySelectorAll('button').forEach((b) => { b.onclick = () => finish(b.dataset.r === '1'); });
      document.addEventListener('keydown', onKey);
      document.body.appendChild(ov);
      ov.querySelector('[data-r="1"]').focus();
    });
  }

  function countUp(el) {
    const end = parseInt(el.textContent, 10);
    if (reduce || Number.isNaN(end) || end === 0) return;
    const t0 = performance.now(), dur = 900;
    const step = (t) => { const p = Math.min(1, (t - t0) / dur); el.textContent = Math.round(end * (1 - Math.pow(1 - p, 4))); if (p < 1) requestAnimationFrame(step); };
    el.textContent = '0'; requestAnimationFrame(step);
  }

  // Auto-reveal anything the pages render dynamically (cards, rows, stats, timeline items).
  const SEL = '.card, .adm-stat, tbody tr, .timeline li, .chip, .error-banner, .success-banner, .adm-warn, .tracker';
  const obs = new MutationObserver((muts) => {
    for (const m of muts) for (const n of m.addedNodes) {
      if (n.nodeType !== 1 || n.closest('.modal-overlay,#uiToasts')) continue;
      const list = [...(n.matches(SEL) ? [n] : []), ...n.querySelectorAll(SEL)];
      list.forEach((el, i) => { if (el.classList.contains('rise')) return; el.style.setProperty('--i', Math.min(i, 14)); el.classList.add('rise'); });
      n.querySelectorAll('.adm-stat b').forEach(countUp);
    }
  });
  document.addEventListener('DOMContentLoaded', () => {
    obs.observe(document.body, { childList: true, subtree: true });
    document.querySelectorAll('.card').forEach((el, i) => { el.style.setProperty('--i', Math.min(i, 14)); el.classList.add('rise'); });
  });

  // Ripple on every button + smooth page-leave on internal links.
  document.addEventListener('pointerdown', (e) => {
    const b = e.target.closest('.btn'); if (!b || b.disabled || reduce) return;
    const r = b.getBoundingClientRect(), s = Math.max(r.width, r.height) * 2;
    const d = document.createElement('span'); d.className = 'rip';
    d.style.cssText = `width:${s}px;height:${s}px;left:${e.clientX - r.left - s / 2}px;top:${e.clientY - r.top - s / 2}px`;
    b.appendChild(d); setTimeout(() => d.remove(), 650);
  });
  document.addEventListener('click', (e) => {
    const a = e.target.closest('a[href]');
    if (!a || e.defaultPrevented || a.target || e.metaKey || e.ctrlKey || e.shiftKey || !/\.html(\?|$)/.test(a.getAttribute('href')) || reduce) return;
    e.preventDefault(); document.body.classList.add('leaving'); setTimeout(() => { location.href = a.href; }, 170);
  });
  window.addEventListener('pageshow', (e) => { if (e.persisted) document.body.classList.remove('leaving'); });

  return { toast, hide, confirm, countUp, esc };
})();
