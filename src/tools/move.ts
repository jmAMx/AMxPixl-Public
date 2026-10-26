import { app } from '../app';
import { visiblePlaced } from '../core/document';
import { follow, layerMatrix, localBounds, ctx2d } from '../core/layers';
import { apply, corners, invert, mapRect, pointInPoly, xformMatrix, type Mat, type Pt, type Rect, type Xform } from '../core/math';
import type { PlacedLayer, RasterLayer, ShapeProps } from '../core/types';
import { warpHandles, warpPoint } from '../core/warp';
import { applyWarp, ensureWarp, flipLayer, removeWarp, resetTransform, rotateLayer90, setPlacedTransform } from '../actions';
import { view } from '../ui/canvasview';
import { h } from '../ui/dom';
import { clearSnapLines, snapDelta, snapLines, snapTargets } from '../ui/snap';
import { checkbox, icon, seg } from '../ui/widgets';
import type { PInfo, Tool } from './tool';

type Handle = { u: number; v: number };
const HANDLES: Handle[] = [
  { u: 0, v: 0 }, { u: 0.5, v: 0 }, { u: 1, v: 0 }, { u: 1, v: 0.5 },
  { u: 1, v: 1 }, { u: 0.5, v: 1 }, { u: 0, v: 1 }, { u: 0, v: 0.5 },
];

type Hit = { kind: 'scale'; h: Handle } | { kind: 'rotate' } | { kind: 'move' } | { kind: 'none' };

interface Drag {
  kind: 'move' | 'scale' | 'rotate';
  layer: PlacedLayer;
  h?: Handle;
  p0: Pt;
  t0: Xform;
  m0: Mat;
  /** The layer mask's placement at drag start (masks move with their layer). */
  maskT0?: Xform;
  box: Rect;
  shape0?: ShapeProps;
  moved: boolean;
}

const ROTATE_CURSOR = `url("data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><path d="M18 9a7 7 0 1 0 1 6" fill="none" stroke="white" stroke-width="4" stroke-linecap="round"/><path d="M18 9a7 7 0 1 0 1 6" fill="none" stroke="black" stroke-width="1.8" stroke-linecap="round"/><path d="M19 4v5h-5" fill="none" stroke="white" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M19 4v5h-5" fill="none" stroke="black" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>')}") 12 12, crosshair`;

function boxPoint(b: Rect, u: number, v: number): Pt { return { x: b.x + u * b.w, y: b.y + v * b.h }; }

function screenCorners(l: PlacedLayer): Pt[] {
  const doc = app.doc!;
  return corners(layerMatrix(l), localBounds(l, doc.pool)).map((p) => view.toScreen(p.x, p.y));
}

/** Top-most visible layer with a pixel (or box) under the document point. */
export function layerAt(x: number, y: number): PlacedLayer | null {
  const doc = app.doc!;
  const layers = visiblePlaced(doc.layers);
  for (let i = layers.length - 1; i >= 0; i--) {
    const l = layers[i];
    const b = localBounds(l, doc.pool);
    const lp = apply(invert(layerMatrix(l)), x, y);
    if (lp.x < b.x || lp.y < b.y || lp.x >= b.x + b.w || lp.y >= b.y + b.h) continue;
    if (l.type === 'raster') {
      const a = ctx2d(doc.canvasOf(l), false).getImageData(Math.floor(lp.x), Math.floor(lp.y), 1, 1).data[3];
      if (a < 12) continue;
    }
    return l;
  }
  return null;
}

class MoveTool implements Tool {
  id = 'move'; name = 'Move & Transform'; key = 'V'; icon = 'move' as const;
  private drag: Drag | null = null;
  private wdrag: { layer: RasterLayer; i: number; moved: boolean } | null = null;

  get hint() {
    const m = app.opts.move.mode;
    return m === 'perspective' ? 'Drag the corners to fit the layer into a perspective · Enter when done · lossless until you Apply'
      : m === 'warp' ? 'Drag the grid points to bend the layer · Enter when done · lossless until you Apply'
        : 'Drag to move · corner handles scale (Shift = free) · outside a corner rotates · arrows nudge · Ctrl while dragging turns snapping off';
  }

  private get mode() { return app.opts.move.mode; }

  activate() { app.opts.move.mode = 'transform'; }
  deactivate() { app.opts.move.mode = 'transform'; clearSnapLines(); }

  private setMode(m: 'transform' | 'perspective' | 'warp') {
    if (m !== 'transform' && !ensureWarp(m === 'warp' ? 'mesh' : 'perspective')) { app.emit('tool'); return; }
    app.opts.move.mode = m;
    app.emit('tool');
    view.requestOverlay();
  }

  /** The active layer's warp handles in screen space. */
  private warpHandlesScreen(l: RasterLayer) {
    const m = layerMatrix(l);
    return warpHandles(l.warp!).map((hd) => { const d = apply(m, hd.x, hd.y); return { i: hd.i, ...view.toScreen(d.x, d.y) }; });
  }

  private hit(p: PInfo): Hit {
    const l = app.doc?.activePlaced;
    if (!l || !l.visible) return { kind: 'none' };
    const doc = app.doc!;
    const box = localBounds(l, doc.pool);
    const m = layerMatrix(l);
    for (const hd of HANDLES) {
      const lp = boxPoint(box, hd.u, hd.v);
      const d = apply(m, lp.x, lp.y);
      const s = view.toScreen(d.x, d.y);
      if (Math.hypot(s.x - p.sx, s.y - p.sy) <= 7) return { kind: 'scale', h: hd };
    }
    const poly = screenCorners(l);
    const inside = pointInPoly({ x: p.sx, y: p.sy }, poly);
    if (!inside && poly.some((c) => Math.hypot(c.x - p.sx, c.y - p.sy) < 26)) return { kind: 'rotate' };
    return inside ? { kind: 'move' } : { kind: 'none' };
  }

  cursor(p: PInfo | null) {
    if (this.mode !== 'transform') {
      const l = app.doc?.activeRaster;
      if (this.wdrag) return 'grabbing';
      if (p && l?.warp && this.warpHandlesScreen(l).some((s) => Math.hypot(s.x - p.sx, s.y - p.sy) <= 8)) return 'grab';
      return 'default';
    }
    if (this.drag) return this.drag.kind === 'rotate' ? ROTATE_CURSOR : this.drag.kind === 'move' ? 'move' : 'crosshair';
    if (!p) return 'default';
    const hit = this.hit(p);
    if (hit.kind === 'rotate') return ROTATE_CURSOR;
    if (hit.kind === 'scale') {
      const l = app.doc!.activePlaced!;
      const deg = (((Math.atan2(hit.h.v - 0.5, hit.h.u - 0.5) + l.t.rot) * 180) / Math.PI + 360) % 180;
      const opts = ['ew-resize', 'nwse-resize', 'ns-resize', 'nesw-resize'];
      return opts[Math.round(deg / 45) % 4];
    }
    return 'move';
  }

  options(bar: HTMLElement) {
    const o = app.opts.move;
    const modes = seg([{ v: 'transform', label: 'Transform' }, { v: 'perspective', label: 'Perspective', icon: undefined }, { v: 'warp', label: 'Warp' }], o.mode, (v) => this.setMode(v));
    if (o.mode !== 'transform') {
      bar.append(modes,
        h('button', { class: 'btn small primary', type: 'button', onclick: () => this.setMode('transform') }, 'Done'),
        h('button', { class: 'btn small', type: 'button', title: 'Bake the warp into the pixels (needed before painting on the layer)', onclick: () => { applyWarp(); this.setMode('transform'); } }, 'Apply warp'),
        h('button', { class: 'btn small', type: 'button', onclick: () => { removeWarp(); this.setMode('transform'); } }, 'Remove warp'),
        h('span', { class: 'opt-note' }, 'The original pixels are kept: you can re-edit or remove the warp any time.'));
      return;
    }
    bar.append(
      modes,
      checkbox('Auto-select layer', o.autoSelect, (v) => { o.autoSelect = v; app.saveOpts(); }, 'Click picks the layer under the cursor (Ctrl+click does this any time)'),
      checkbox('Snap', app.prefs.snap, (v) => app.setPrefs({ snap: v }), 'Snap to guides, the canvas edges and centre, and other layers'),
      h('span', { class: 'opt-sep' }),
      h('button', { class: 'btn small', type: 'button', title: 'Flip layer horizontally', onclick: () => flipLayer('h') }, icon('flipH'), 'Flip H'),
      h('button', { class: 'btn small', type: 'button', title: 'Flip layer vertically', onclick: () => flipLayer('v') }, icon('flipV'), 'Flip V'),
      h('button', { class: 'btn small', type: 'button', title: 'Rotate layer 90° clockwise', onclick: () => rotateLayer90(1) }, icon('rotate'), '90°'),
      h('button', { class: 'btn small', type: 'button', title: 'Back to original size and angle', onclick: () => resetTransform() }, 'Reset transform'),
      h('span', { class: 'opt-note' }, 'Transforms are lossless: layers keep their original pixels.'),
    );
  }

  down(p: PInfo) {
    const doc = app.doc!;
    if (this.mode !== 'transform') {
      const l = ensureWarp(this.mode === 'warp' ? 'mesh' : 'perspective');
      if (!l) return;
      const near = this.warpHandlesScreen(l).find((s) => Math.hypot(s.x - p.sx, s.y - p.sy) <= 8);
      if (near) this.wdrag = { layer: l, i: near.i, moved: false };
      return;
    }
    let hit = this.hit(p);
    if ((app.opts.move.autoSelect || p.ctrl) && hit.kind !== 'scale' && hit.kind !== 'rotate') {
      const l = layerAt(p.x, p.y);
      if (l && l.id !== doc.activeId) { doc.setActive(l.id); doc.touch('meta'); }
      hit = l ? { kind: 'move' } : hit;
    }
    const l = doc.activePlaced;
    if (!l) return;
    const kind = hit.kind === 'none' ? 'move' : hit.kind;
    this.drag = {
      kind, layer: l, h: hit.kind === 'scale' ? hit.h : undefined, p0: { x: p.x, y: p.y },
      t0: { ...l.t }, m0: layerMatrix(l), box: localBounds(l, doc.pool),
      shape0: l.type === 'shape' ? { ...l.shape } : undefined, moved: false, maskT0: l.mask ? { ...l.mask.t } : undefined,
    };
  }

  move(p: PInfo) {
    if (this.wdrag) {
      const w = this.wdrag;
      const lp = apply(invert(layerMatrix(w.layer)), p.x, p.y);
      const pts = [...w.layer.warp!.pts];
      pts[w.i * 2] = lp.x;
      pts[w.i * 2 + 1] = lp.y;
      w.layer.warp = { ...w.layer.warp!, pts };
      w.moved = true;
      app.doc!.touch('meta');
      return;
    }
    const d = this.drag;
    if (!d) return;
    const l = d.layer;
    d.moved = true;
    if (d.kind === 'move') {
      let dx = p.x - d.p0.x, dy = p.y - d.p0.y;
      if (p.shift) { if (Math.abs(dx) > Math.abs(dy)) dy = 0; else dx = 0; }
      l.t = { ...d.t0, x: d.t0.x + dx, y: d.t0.y + dy };
      clearSnapLines();
      if (app.prefs.snap && !p.ctrl) {
        // Line the layer's edges or centre up with guides, the canvas and other layers.
        const b = mapRect(xformMatrix(l.t), d.box);
        const { xs, ys } = snapTargets(l.id);
        const tol = 6 / app.doc!.zoom;
        const sx = p.shift && dx === 0 ? null : snapDelta([b.x, b.x + b.w / 2, b.x + b.w], xs, tol);
        const sy = p.shift && dy === 0 ? null : snapDelta([b.y, b.y + b.h / 2, b.y + b.h], ys, tol);
        if (sx) { l.t = { ...l.t, x: l.t.x + sx.d }; snapLines.x = [sx.at]; }
        if (sy) { l.t = { ...l.t, y: l.t.y + sy.d }; snapLines.y = [sy.at]; }
      }
    } else if (d.kind === 'scale') {
      const hd = d.h!;
      const corner = hd.u !== 0.5 && hd.v !== 0.5;
      const anchor = p.alt ? boxPoint(d.box, 0.5, 0.5) : boxPoint(d.box, 1 - hd.u, 1 - hd.v);
      const hl = boxPoint(d.box, hd.u, hd.v);
      const pl = apply(invert(d.m0), p.x, p.y);
      const D = { x: hl.x - anchor.x, y: hl.y - anchor.y };
      const Q = { x: pl.x - anchor.x, y: pl.y - anchor.y };
      let kx = hd.u === 0.5 ? 1 : Q.x / (D.x || 1e-9);
      let ky = hd.v === 0.5 ? 1 : Q.y / (D.y || 1e-9);
      if (corner && !p.shift) kx = ky = (Q.x * D.x + Q.y * D.y) / (D.x * D.x + D.y * D.y || 1e-9);
      const fix = (k: number) => (Math.abs(k) < 0.002 ? (k < 0 ? -0.002 : 0.002) : k);
      kx = fix(kx); ky = fix(ky);
      const ad = apply(d.m0, anchor.x, anchor.y);
      const lin = xformMatrix({ ...d.t0, x: 0, y: 0, sx: d.t0.sx * kx, sy: d.t0.sy * ky });
      const off = apply(lin, anchor.x, anchor.y);
      if (l.type === 'shape' && d.shape0) {
        // Shapes stay vector: resize their geometry instead of stretching them (keeps stroke width).
        l.shape = { ...d.shape0, w: d.shape0.w * kx, h: d.shape0.h * ky };
        l.t = { ...d.t0, x: ad.x - off.x, y: ad.y - off.y };
      } else {
        l.t = { ...d.t0, sx: d.t0.sx * kx, sy: d.t0.sy * ky, x: ad.x - off.x, y: ad.y - off.y };
      }
    } else {
      const cl = boxPoint(d.box, 0.5, 0.5);
      const cd = apply(d.m0, cl.x, cl.y);
      const a0 = Math.atan2(d.p0.y - cd.y, d.p0.x - cd.x);
      const a1 = Math.atan2(p.y - cd.y, p.x - cd.x);
      let rot = d.t0.rot + (a1 - a0);
      if (p.shift) rot = Math.round(rot / (Math.PI / 12)) * (Math.PI / 12);
      const lin = xformMatrix({ ...d.t0, x: 0, y: 0, rot });
      const off = apply(lin, cl.x, cl.y);
      l.t = { ...d.t0, rot, x: cd.x - off.x, y: cd.y - off.y };
    }
    if (l.mask && d.maskT0) l.mask.t = follow(d.maskT0, d.m0, l.t);
    app.doc!.touch('meta');
  }

  up() {
    clearSnapLines();
    if (this.wdrag) {
      const w = this.wdrag;
      this.wdrag = null;
      if (w.moved) app.doc!.commit(this.mode === 'warp' ? 'Warp' : 'Perspective');
      return;
    }
    const d = this.drag;
    this.drag = null;
    if (!d || !d.moved) return;
    app.doc!.commit(d.kind === 'move' ? 'Move' : d.kind === 'scale' ? 'Scale' : 'Rotate');
  }

  keydown(e: KeyboardEvent) {
    if (this.mode !== 'transform' && (e.key === 'Enter' || e.key === 'Escape')) { this.setMode('transform'); return true; }
    const l = app.doc?.activePlaced;
    if (!l) return false;
    const step = e.shiftKey ? 10 : 1;
    const dir = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
    if (!dir) return false;
    setPlacedTransform(l, { ...l.t, x: l.t.x + dir[0] * step, y: l.t.y + dir[1] * step });
    app.doc!.commit('Nudge');
    return true;
  }

  /** Warp/perspective editing: the bent grid (sampled from the warp itself) and its control points. */
  private warpOverlay(ctx: CanvasRenderingContext2D, l: RasterLayer, accent: string) {
    const w = l.warp!;
    const m = layerMatrix(l);
    const sp = (u: number, v: number) => { const q = warpPoint(w, u, v); const d = apply(m, q.x, q.y); return view.toScreen(d.x, d.y); };
    ctx.save();
    ctx.lineWidth = 1;
    ctx.strokeStyle = accent;
    const lines = w.kind === 'perspective' ? 2 : w.n;
    const N = 32;
    for (let k = 0; k < lines; k++) {
      const t = k / (lines - 1);
      for (const along of [0, 1]) {
        ctx.beginPath();
        for (let i = 0; i <= N; i++) {
          const s = i / N;
          const pt = along ? sp(t, s) : sp(s, t);
          if (i) ctx.lineTo(pt.x, pt.y); else ctx.moveTo(pt.x, pt.y);
        }
        ctx.stroke();
      }
    }
    for (const hd of this.warpHandlesScreen(l)) {
      ctx.fillStyle = '#fff';
      ctx.beginPath(); ctx.arc(hd.x, hd.y, 5, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    }
    ctx.restore();
  }

  overlay(ctx: CanvasRenderingContext2D) {
    const accentNow = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#2EE6BE';
    if (this.mode !== 'transform') {
      const r = app.doc?.activeRaster;
      if (r?.warp && r.visible) this.warpOverlay(ctx, r, accentNow);
      return;
    }
    const l = app.doc?.activePlaced;
    if (!l || !l.visible) return;
    const doc = app.doc!;
    const box = localBounds(l, doc.pool);
    const m = layerMatrix(l);
    const poly = screenCorners(l);
    const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#2EE6BE';
    ctx.save();
    ctx.lineWidth = 1;
    ctx.strokeStyle = accent;
    ctx.beginPath();
    poly.forEach((c, i) => (i ? ctx.lineTo(c.x, c.y) : ctx.moveTo(c.x, c.y)));
    ctx.closePath();
    ctx.stroke();
    for (const hd of HANDLES) {
      const lp = boxPoint(box, hd.u, hd.v);
      const d = apply(m, lp.x, lp.y);
      const s = view.toScreen(d.x, d.y);
      ctx.fillStyle = '#fff';
      ctx.fillRect(Math.round(s.x) - 3.5, Math.round(s.y) - 3.5, 7, 7);
      ctx.strokeRect(Math.round(s.x) - 3.5, Math.round(s.y) - 3.5, 7, 7);
    }
    if (this.drag && this.drag.kind !== 'move') {
      const t = l.t;
      const w = Math.abs(box.w * t.sx), hh = Math.abs(box.h * t.sy);
      const label = this.drag.kind === 'rotate'
        ? `${(((t.rot * 180) / Math.PI) % 360).toFixed(1)}°`
        : `${Math.round(w)} × ${Math.round(hh)} px`;
      const c = poly[2];
      ctx.font = '600 12px "Segoe UI", sans-serif';
      const tw = ctx.measureText(label).width;
      ctx.fillStyle = 'rgba(10,14,13,.85)';
      ctx.fillRect(c.x + 10, c.y + 8, tw + 12, 20);
      ctx.fillStyle = '#fff';
      ctx.fillText(label, c.x + 16, c.y + 22);
    }
    ctx.restore();
  }
}

export const moveTool = new MoveTool();
