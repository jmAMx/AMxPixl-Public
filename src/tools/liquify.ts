import { app } from '../app';
import { layerMatrix } from '../core/layers';
import { apply, invert, type Mat, type Pt } from '../core/math';
import type { RasterLayer, Warp } from '../core/types';
import { initWarp } from '../core/warp';
import { view } from '../ui/canvasview';
import { h } from '../ui/dom';
import { checkbox, seg, slider, toast } from '../ui/widgets';
import type { PInfo, Tool } from './tool';

type Mode = typeof app.opts.liquify.mode;

/**
 * One dab of the brush on a liquify grid, in the layer's own pixels: the grid points within `r` of `c` move by how
 * close they are (a smooth falloff). Push carries them along `delta`; pinch and bloat pull them in or push them out;
 * twirl turns them round `c`; restore takes them back towards where they started (`rest`); smooth evens them out.
 */
function dab(w: Warp, rest: number[], mode: Mode, c: Pt, r: number, s: number, delta: Pt, reverse: boolean, pin: boolean) {
  const n = w.n, p = w.pts, before = mode === 'smooth' ? p.slice() : p;
  // Only the grid points near the brush (the grid is evenly spaced at rest, but may have moved: a margin covers it).
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
    if (pin && (i === 0 || j === 0 || i === n - 1 || j === n - 1)) continue;
    const k = (i * n + j) * 2, x = p[k], y = p[k + 1];
    const d2 = (x - c.x) ** 2 + (y - c.y) ** 2;
    if (d2 >= r * r) continue;
    const t = 1 - d2 / (r * r), f = t * t * s;
    switch (mode) {
      case 'push': p[k] += delta.x * f; p[k + 1] += delta.y * f; break;
      case 'pinch': case 'bloat': {
        const k2 = ((mode === 'pinch') !== reverse ? 1 : -1) * f * 0.12;
        p[k] += (c.x - x) * k2; p[k + 1] += (c.y - y) * k2; break;
      }
      case 'twirl': {
        const a = (reverse ? -1 : 1) * f * 0.12, cs = Math.cos(a), sn = Math.sin(a), dx = x - c.x, dy = y - c.y;
        p[k] = c.x + dx * cs - dy * sn; p[k + 1] = c.y + dx * sn + dy * cs; break;
      }
      case 'restore': p[k] += (rest[k] - x) * f * 0.25; p[k + 1] += (rest[k + 1] - y) * f * 0.25; break;
      case 'smooth': {
        if (i === 0 || j === 0 || i === n - 1 || j === n - 1) break;
        const nb = (a: number) => (before[k - 2 + a] + before[k + 2 + a] + before[k - n * 2 + a] + before[k + n * 2 + a]) / 4;
        p[k] += (nb(0) - x) * f * 0.5; p[k + 1] += (nb(1) - y) * f * 0.5; break;
      }
    }
  }
}

/**
 * Liquify: push, pinch, bloat, twirl, restore or smooth the picture of an image layer with a brush. It bends a fine
 * warp of the layer, so it stays lossless: the pixels are only changed by Apply Warp. Holding still keeps pinching,
 * bloating, twirling, restoring or smoothing; Alt reverses pinch and bloat, and turns a twirl the other way.
 */
class LiquifyTool implements Tool {
  id = 'liquify'; name = 'Liquify'; key = 'R'; icon = 'liquify' as const;
  ownCursor = true;
  hint = 'Drag to push the picture around · hold still to keep pinching, bloating or twirling · Alt reverses · [ ] size';
  private s: { l: RasterLayer; inv: Mat; r: number; rest: number[]; last: Pt; alt: boolean; before: Warp | null; timer: number } | null = null;

  private get o() { return app.opts.liquify; }

  options(bar: HTMLElement) {
    const o = this.o;
    bar.append(
      seg<Mode>([{ v: 'push', label: 'Push' }, { v: 'pinch', label: 'Pinch' }, { v: 'bloat', label: 'Bloat' }, { v: 'twirl', label: 'Twirl' },
        { v: 'restore', label: 'Restore' }, { v: 'smooth', label: 'Smooth' }], o.mode, (v) => { o.mode = v; app.saveOpts(); }),
      slider({ label: 'Size', min: 4, max: 2000, value: o.size, unit: 'px', compact: true, onInput: (v) => { o.size = v; view.requestOverlay(); }, onChange: () => app.saveOpts() }),
      slider({ label: 'Strength', min: 0.01, max: 1, display: 100, value: o.strength, unit: '%', compact: true, onInput: (v) => { o.strength = v; }, onChange: () => app.saveOpts() }),
      checkbox('Pin edges', o.pin, (v) => { o.pin = v; app.saveOpts(); }, 'Keep the layer\'s edges where they are'),
      h('button', { class: 'btn small', type: 'button', title: 'Take the whole layer back to how it was before liquifying', onclick: () => this.restoreAll() }, 'Restore all'),
    );
  }

  private layer(): RasterLayer | null {
    const doc = app.doc, l = doc?.active;
    if (!doc || !l) return null;
    if (l.type !== 'raster') { toast(l.type === 'text' || l.type === 'shape' ? 'Rasterize this layer to liquify it.' : 'Select an image layer to liquify.'); return null; }
    if (l.model) { toast('3D layers can\'t be liquified. Rasterize the 3D first.'); return null; }
    if (!doc.shows(l)) { toast('That layer is hidden. Show it to liquify it.'); return null; }
    return l;
  }

  down(p: PInfo) {
    const doc = app.doc!, l = this.layer();
    if (!l) return;
    const c = doc.canvasOf(l), box = { x: 0, y: 0, w: c.width, h: c.height };
    const before = l.warp ?? null;
    // Starts from the layer's current warp (if any), so its shape is kept.
    if (l.warp?.kind !== 'liquify') l.warp = initWarp('liquify', box, l.warp);
    else l.warp = { ...l.warp, pts: l.warp.pts.slice() };
    const n = l.warp.n, rest: number[] = [];
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) rest.push((j / (n - 1)) * box.w, (i / (n - 1)) * box.h);
    const m = layerMatrix(l), sc = Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2])) || 1;
    this.s = { l, inv: invert(m), r: this.o.size / 2 / sc, rest, last: apply(invert(m), p.x, p.y), alt: p.alt, before, timer: 0 };
    if (this.o.mode !== 'push') {
      this.paint(this.s.last, { x: 0, y: 0 });
      // Holding still keeps going, like Photoshop's.
      this.s.timer = window.setInterval(() => { if (this.s) this.paint(this.s.last, { x: 0, y: 0 }); }, 40);
    }
  }

  private paint(at: Pt, delta: Pt) {
    const s = this.s!;
    const o = this.o;
    // A long push is done in short steps, so the picture follows the stroke instead of tearing.
    const len = Math.hypot(delta.x, delta.y), steps = o.mode === 'push' ? Math.max(1, Math.ceil(len / (s.r * 0.25))) : 1;
    for (let k = 0; k < steps; k++) {
      const c = o.mode === 'push' ? { x: at.x - delta.x + (delta.x * (k + 0.5)) / steps, y: at.y - delta.y + (delta.y * (k + 0.5)) / steps } : at;
      dab(s.l.warp!, s.rest, o.mode, c, s.r, o.strength, { x: delta.x / steps, y: delta.y / steps }, s.alt, o.pin);
    }
    app.doc!.touch('meta');
  }

  move(p: PInfo) {
    const s = this.s;
    if (!s) return;
    const at = apply(s.inv, p.x, p.y);
    s.alt = p.alt;
    if (this.o.mode === 'push') this.paint(at, { x: at.x - s.last.x, y: at.y - s.last.y });
    else this.paint(at, { x: 0, y: 0 });
    s.last = at;
  }

  up() {
    const s = this.s;
    if (!s) return;
    clearInterval(s.timer);
    this.s = null;
    app.doc!.commit('Liquify');
  }

  cancel() {
    const s = this.s;
    if (!s) return;
    clearInterval(s.timer);
    s.l.warp = s.before;
    this.s = null;
    app.doc!.touch('meta');
  }

  deactivate() { this.cancel(); }

  private restoreAll() {
    const doc = app.doc, l = doc?.active;
    if (!doc || l?.type !== 'raster' || l.warp?.kind !== 'liquify') { toast('This layer isn\'t liquified.'); return; }
    l.warp = null;
    doc.commit('Restore liquify');
  }

  keydown(e: KeyboardEvent) {
    if (e.key !== '[' && e.key !== ']') return false;
    const o = this.o;
    const step = o.size < 20 ? 2 : o.size < 100 ? 10 : o.size < 400 ? 25 : 100;
    o.size = Math.max(4, Math.min(2000, o.size + (e.key === ']' ? step : -step)));
    app.saveOpts();
    view.requestOverlay();
    return true;
  }

  overlay(ctx: CanvasRenderingContext2D) {
    const hv = view.hover;
    if (!hv) return;
    const r = Math.max(2, (this.o.size / 2) * view.zoom);
    ctx.save();
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(0,0,0,.7)';
    ctx.beginPath(); ctx.arc(hv.sx, hv.sy, r + 0.5, 0, Math.PI * 2); ctx.stroke();
    ctx.strokeStyle = 'rgba(255,255,255,.9)';
    ctx.beginPath(); ctx.arc(hv.sx, hv.sy, r - 0.5, 0, Math.PI * 2); ctx.stroke();
    // The centre, so it's clear where the push starts.
    ctx.beginPath(); ctx.arc(hv.sx, hv.sy, 1.5, 0, Math.PI * 2); ctx.stroke();
    ctx.restore();
  }
}

export const liquifyTool = new LiquifyTool();
