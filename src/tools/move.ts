import { app } from '../app';
import { layerMatrix, localBounds, ctx2d } from '../core/layers';
import { apply, corners, invert, pointInPoly, xformMatrix, type Mat, type Pt, type Rect, type Xform } from '../core/math';
import type { PlacedLayer, ShapeProps } from '../core/types';
import { isPlaced } from '../core/types';
import { flipLayer, resetTransform, rotateLayer90 } from '../actions';
import { view } from '../ui/canvasview';
import { h } from '../ui/dom';
import { checkbox, icon } from '../ui/widgets';
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
  for (let i = doc.layers.length - 1; i >= 0; i--) {
    const l = doc.layers[i];
    if (!isPlaced(l) || !l.visible) continue;
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
  hint = 'Drag to move · corner handles scale (Shift = free) · outside a corner rotates · arrows nudge';
  private drag: Drag | null = null;

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
    bar.append(
      checkbox('Auto-select layer', o.autoSelect, (v) => { o.autoSelect = v; app.saveOpts(); }, 'Click picks the layer under the cursor (Ctrl+click does this any time)'),
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
    let hit = this.hit(p);
    if ((app.opts.move.autoSelect || p.ctrl) && hit.kind !== 'scale' && hit.kind !== 'rotate') {
      const l = layerAt(p.x, p.y);
      if (l && l.id !== doc.activeId) { doc.activeId = l.id; doc.touch('meta'); }
      hit = l ? { kind: 'move' } : hit;
    }
    const l = doc.activePlaced;
    if (!l) return;
    const kind = hit.kind === 'none' ? 'move' : hit.kind;
    this.drag = {
      kind, layer: l, h: hit.kind === 'scale' ? hit.h : undefined, p0: { x: p.x, y: p.y },
      t0: { ...l.t }, m0: layerMatrix(l), box: localBounds(l, doc.pool),
      shape0: l.type === 'shape' ? { ...l.shape } : undefined, moved: false,
    };
  }

  move(p: PInfo) {
    const d = this.drag;
    if (!d) return;
    const l = d.layer;
    d.moved = true;
    if (d.kind === 'move') {
      let dx = p.x - d.p0.x, dy = p.y - d.p0.y;
      if (p.shift) { if (Math.abs(dx) > Math.abs(dy)) dy = 0; else dx = 0; }
      l.t = { ...d.t0, x: d.t0.x + dx, y: d.t0.y + dy };
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
    app.doc!.touch('meta');
  }

  up() {
    const d = this.drag;
    this.drag = null;
    if (!d || !d.moved) return;
    app.doc!.commit(d.kind === 'move' ? 'Move' : d.kind === 'scale' ? 'Scale' : 'Rotate');
  }

  keydown(e: KeyboardEvent) {
    const l = app.doc?.activePlaced;
    if (!l) return false;
    const step = e.shiftKey ? 10 : 1;
    const dir = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
    if (!dir) return false;
    l.t = { ...l.t, x: l.t.x + dir[0] * step, y: l.t.y + dir[1] * step };
    app.doc!.commit('Nudge');
    return true;
  }

  overlay(ctx: CanvasRenderingContext2D) {
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
