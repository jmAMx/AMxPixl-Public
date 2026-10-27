import { app } from '../app';
import { view } from './canvasview';
import { h } from './dom';

/**
 * Scrollbars along the bottom and right of the canvas, shown when the image runs past the window. The scrollable
 * area is the image plus half a window on each side, so any edge can be brought to the middle; it stretches to
 * include the current view when it has been panned further than that.
 */
export function canvasScrollbars() {
  const bars = (['h', 'v'] as const).map((axis) => {
    const thumb = h('div', { class: 'cv-thumb' });
    const track = h('div', { class: `cv-scroll ${axis}` }, thumb);
    /** Viewport and scrollable lengths on this axis, and where the view starts within it (screen px). */
    const geom = () => {
      const d = app.doc!, { w, h: hh } = view.size;
      const vp = axis === 'h' ? w : hh;
      const pan = axis === 'h' ? d.panX : d.panY;
      const len = (axis === 'h' ? d.width : d.height) * d.zoom;
      const m = vp / 2;
      const lo = Math.min(-m, -pan), hi = Math.max(len + m, vp - pan);
      return { vp, total: hi - lo, at: -pan - lo, show: pan < -0.5 || pan + len > vp + 0.5 };
    };
    const scrollBy = (px: number) => view.panBy(axis === 'h' ? -px : 0, axis === 'v' ? -px : 0);
    const sync = () => {
      const d = app.doc;
      const g = d ? geom() : null;
      track.hidden = !g?.show;
      if (!g?.show) return;
      const pos = `${(g.at / g.total) * 100}%`, size = `${(g.vp / g.total) * 100}%`;
      if (axis === 'h') { thumb.style.left = pos; thumb.style.width = size; } else { thumb.style.top = pos; thumb.style.height = size; }
    };
    thumb.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || !app.doc) return;
      e.preventDefault(); e.stopPropagation();
      try { thumb.setPointerCapture(e.pointerId); } catch { /* pointer already gone */ }
      thumb.classList.add('drag');
      const r = track.getBoundingClientRect();
      const trackLen = axis === 'h' ? r.width : r.height;
      const scale = geom().total / trackLen;
      let last = axis === 'h' ? e.clientX : e.clientY;
      const move = (ev: PointerEvent) => {
        const p = axis === 'h' ? ev.clientX : ev.clientY;
        scrollBy((p - last) * scale);
        last = p;
      };
      const up = () => {
        thumb.classList.remove('drag');
        thumb.removeEventListener('pointermove', move);
        thumb.removeEventListener('pointerup', up);
        thumb.removeEventListener('pointercancel', up);
      };
      thumb.addEventListener('pointermove', move);
      thumb.addEventListener('pointerup', up);
      thumb.addEventListener('pointercancel', up);
    });
    // Clicking the track pages towards the click.
    track.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || e.target !== track || !app.doc) return;
      e.preventDefault();
      const t = thumb.getBoundingClientRect();
      const before = axis === 'h' ? e.clientX < t.left : e.clientY < t.top;
      scrollBy((before ? -1 : 1) * geom().vp * 0.9);
    });
    // The wheel over a bar scrolls along it.
    track.addEventListener('wheel', (e) => { if (!app.doc) return; e.preventDefault(); scrollBy(e.deltaY || e.deltaX); }, { passive: false });
    return { track, sync };
  });
  const syncAll = () => bars.forEach((b) => b.sync());
  let sig = '';
  app.on('view', syncAll);
  app.on('docs', syncAll);
  app.on('change', () => { const d = app.doc; const s = d ? `${d.width}x${d.height}` : ''; if (s !== sig) { sig = s; syncAll(); } });
  new ResizeObserver(syncAll).observe(view.el);
  const el = h('div', { class: 'cv-scrolls' }, ...bars.map((b) => b.track));
  syncAll();
  return el;
}
