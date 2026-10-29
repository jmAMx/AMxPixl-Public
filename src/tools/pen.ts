import { app } from '../app';
import { newPath } from '../actions';
import { layerMatrix } from '../core/layers';
import { apply, identity, invert, matScale, type Mat } from '../core/math';
import { corner, fitPolyline, hitPath, isSmooth, segments, splitSegment, toggleSmooth } from '../core/paths';
import type { PathPoint, ShapeLayer, VPath } from '../core/types';
import { view } from '../ui/canvasview';
import { h } from '../ui/dom';
import { seg, slider } from '../ui/widgets';
import type { PInfo, Tool } from './tool';

type Drag =
  | { kind: 'new' | 'in' | 'out'; sub: number; i: number; alt: boolean }
  | { kind: 'point'; sub: number; i: number; x0: number; y0: number; orig: PathPoint };

const LABELS = { new: 'Add point', in: 'Edit curve', out: 'Edit curve', point: 'Move point' } as const;

/**
 * Paths (P), in two modes like Illustrator's Pen and Pencil.
 * Pen: click to add corner points, drag to pull out curve handles, click the first point to close. Drag any point
 * or handle to adjust; Alt+click a point switches corner/smooth; Ctrl+click a point deletes it and Ctrl+click on a
 * line adds one. Enter or Esc finishes the current line.
 * Freehand: drag to draw; the line is smoothed into a few editable points (ending near the start closes it).
 */
class PenTool implements Tool {
  id = 'pen'; name = 'Paths'; key = 'P'; icon = 'pen' as const;
  get hint() {
    return app.opts.pen.mode === 'freehand'
      ? 'Drag to draw a path freehand · end near the start to close it · higher Smoothness = fewer, rounder points'
      : 'Click to add points · drag to curve · click the first point to close · drag points/handles to adjust · Alt+click point: corner ↔ smooth · Ctrl+click: delete point / add point on a line · Enter finishes';
  }
  private open: { path: string; sub: number } | null = null;
  private sel: { sub: number; i: number } | null = null;
  private drag: Drag | null = null;
  private changed = false;
  /** Points of a freehand line being drawn (document pixels). */
  private drawn: { x: number; y: number }[] | null = null;

  cursor() { return 'crosshair'; }

  activate() {
    // The Paths panel is where paths get used (fill, stroke, selection), so show it.
    if (app.prefs.dock.paths !== true) app.setPrefs({ dock: { ...app.prefs.dock, paths: true } });
  }

  deactivate() { this.open = null; this.sel = null; }

  options(bar: HTMLElement) {
    const doc = app.doc, o = app.opts.pen;
    bar.append(
      seg([{ v: 'pen', label: 'Pen', title: 'Click to place points; drag for curves' }, { v: 'freehand', label: 'Freehand', title: 'Drag to draw; smoothed into editable points' }],
        o.mode, (v) => { o.mode = v; this.open = null; app.saveOpts(); app.emit('tool'); }),
      ...(o.mode === 'freehand' ? [slider({ label: 'Smoothness', min: 0, max: 100, value: o.smooth, unit: '%', compact: true, onInput: (v) => { o.smooth = v; }, onChange: () => app.saveOpts() })] : []),
      h('span', { class: 'opt-note' }, this.target?.layer ? `Reshaping the outline "${this.target.layer.name}"` : doc?.path ? `Adding to "${doc.path.name}"` : 'Draw on the image to start a path'),
      h('button', { class: 'btn small', type: 'button', title: 'Start a separate path', onclick: () => { this.open = null; this.sel = null; newPath(); app.emit('tool'); } }, 'New path'));
  }

  /**
   * What the tool edits: an outline shape layer's own outline when one is selected (text turned into outlines;
   * its points are in the layer's pixels and `m` maps them to the document), otherwise the active path.
   */
  private get target(): { path: VPath; m: Mat; inv: Mat; k: number; layer: ShapeLayer | null } | null {
    const doc = app.doc;
    if (!doc) return null;
    const l = doc.active;
    if (l?.type === 'shape' && l.shape.kind === 'path' && l.shape.subs) {
      const m = layerMatrix(l);
      return { path: { id: l.id, name: l.name, subs: l.shape.subs }, m, inv: invert(m), k: matScale(m) || 1, layer: l };
    }
    return doc.path ? { path: doc.path, m: identity(), inv: identity(), k: 1, layer: null } : null;
  }
  private get path(): VPath | null { return this.target?.path ?? null; }
  /** The pointer in the target's own coordinates. */
  private local(p: PInfo) { const t = this.target; return t ? apply(t.inv, p.x, p.y) : { x: p.x, y: p.y }; }
  /** Screen pixels per target pixel. */
  private get scale() { return (app.doc?.zoom ?? 1) * (this.target?.k ?? 1); }

  /** Handles show for smooth points next to the selected one (and on the line being drawn). */
  private handlesShown = (sub: number, i: number) => {
    const s = this.sel;
    if (this.open?.sub === sub) return true;
    if (!s || s.sub !== sub) return false;
    const n = this.path?.subs[sub]?.pts.length ?? 0;
    return Math.abs(s.i - i) <= 1 || (n > 2 && Math.abs(s.i - i) === n - 1);
  };

  down(p: PInfo) {
    const doc = app.doc!;
    if (app.opts.pen.mode === 'freehand') { this.drawn = [{ x: p.x, y: p.y }]; this.sel = null; return; }
    const q = this.local(p);
    const tol = 6 / this.scale;
    let path = this.path;
    if (this.open && (!path || path.id !== this.open.path || !path.subs[this.open.sub])) this.open = null;
    const hit = path ? hitPath(path, q.x, q.y, tol, this.handlesShown) : null;
    if (path && hit?.kind === 'point') {
      const s = path.subs[hit.sub];
      if (p.ctrl) {
        s.pts.splice(hit.i, 1);
        if (!s.pts.length) { path.subs.splice(hit.sub, 1); this.open = null; }
        else if (s.pts.length < 3) s.closed = false;
        this.sel = null;
        doc.commit('Delete point');
        return;
      }
      if (p.alt) { toggleSmooth(s, hit.i); this.sel = { sub: hit.sub, i: hit.i }; doc.commit('Corner / smooth point'); return; }
      if (this.open?.sub === hit.sub && hit.i === 0 && s.pts.length > 2 && !s.closed) {
        s.closed = true;
        this.open = null;
        doc.commit('Close path');
        return;
      }
      this.sel = { sub: hit.sub, i: hit.i };
      this.drag = { kind: 'point', sub: hit.sub, i: hit.i, x0: q.x, y0: q.y, orig: { ...s.pts[hit.i] } };
      this.changed = false;
      view.requestOverlay();
      return;
    }
    if (path && hit && (hit.kind === 'in' || hit.kind === 'out')) {
      this.sel = { sub: hit.sub, i: hit.i };
      this.drag = { kind: hit.kind, sub: hit.sub, i: hit.i, alt: p.alt };
      this.changed = false;
      return;
    }
    if (path && hit?.kind === 'segment' && p.ctrl) {
      splitSegment(path.subs[hit.sub], hit.i, hit.t);
      this.sel = { sub: hit.sub, i: hit.i + 1 };
      doc.commit('Add point');
      return;
    }
    // A new point: on the line being drawn, or starting a new one.
    if (!path) { path = newPath(); if (!path) return; }
    if (!this.open) { path.subs.push({ closed: false, pts: [] }); this.open = { path: path.id, sub: path.subs.length - 1 }; }
    const s = path.subs[this.open.sub];
    let x = q.x, y = q.y;
    const last = s.pts[s.pts.length - 1];
    if (p.shift && last) {
      // Shift keeps the new line at 45° steps.
      const a = Math.round(Math.atan2(y - last.y, x - last.x) / (Math.PI / 4)) * (Math.PI / 4), len = Math.hypot(x - last.x, y - last.y);
      x = last.x + Math.cos(a) * len; y = last.y + Math.sin(a) * len;
    }
    s.pts.push(corner(x, y));
    this.sel = { sub: this.open.sub, i: s.pts.length - 1 };
    this.drag = { kind: 'new', sub: this.open.sub, i: s.pts.length - 1, alt: false };
    this.changed = true;
    doc.touch('meta');
  }

  move(p: PInfo) {
    if (this.drawn) {
      const last = this.drawn[this.drawn.length - 1];
      if (Math.hypot(p.x - last.x, p.y - last.y) * app.doc!.zoom >= 1.5) { this.drawn.push({ x: p.x, y: p.y }); view.requestOverlay(); }
      return;
    }
    const d = this.drag, path = this.path;
    if (!d || !path) return;
    const pt = path.subs[d.sub]?.pts[d.i];
    if (!pt) return;
    const q = this.local(p);
    if (d.kind === 'point') {
      const dx = q.x - d.x0, dy = q.y - d.y0, o = d.orig;
      Object.assign(pt, { x: o.x + dx, y: o.y + dy, ix: o.ix + dx, iy: o.iy + dy, ox: o.ox + dx, oy: o.oy + dy });
    } else if (d.kind === 'new') {
      // Dragging while adding a point pulls out a smooth curve (handles mirror each other).
      if (Math.hypot(q.x - pt.x, q.y - pt.y) * this.scale < 3) { pt.ox = pt.ix = pt.x; pt.oy = pt.iy = pt.y; }
      else { pt.ox = q.x; pt.oy = q.y; pt.ix = 2 * pt.x - q.x; pt.iy = 2 * pt.y - q.y; }
    } else {
      const [hx, hy, ox, oy] = d.kind === 'out' ? ['ox', 'oy', 'ix', 'iy'] as const : ['ix', 'iy', 'ox', 'oy'] as const;
      pt[hx] = q.x; pt[hy] = q.y;
      // A smooth point keeps its handles in line (the other keeps its length); Alt breaks them apart.
      const otherLen = Math.hypot(pt[ox] - pt.x, pt[oy] - pt.y);
      if (!d.alt && !p.alt && otherLen > 0) {
        const len = Math.hypot(q.x - pt.x, q.y - pt.y) || 1;
        pt[ox] = pt.x - ((q.x - pt.x) / len) * otherLen;
        pt[oy] = pt.y - ((q.y - pt.y) / len) * otherLen;
      }
    }
    this.changed = true;
    app.doc!.touch('meta');
  }

  hover() { if (this.open) view.requestOverlay(); }

  up() {
    if (this.drawn) { this.finishFreehand(); return; }
    const d = this.drag;
    this.drag = null;
    if (d && this.changed) app.doc!.commit(LABELS[d.kind]);
    this.changed = false;
  }

  /** Smooths the drawn line into a run of editable points on the current path (or a new one). */
  private finishFreehand() {
    const pts = this.drawn!;
    this.drawn = null;
    const doc = app.doc!;
    const len = pts.reduce((s, q, i) => (i ? s + Math.hypot(q.x - pts[i - 1].x, q.y - pts[i - 1].y) : 0), 0);
    if (pts.length < 2 || len * doc.zoom < 4) { view.requestOverlay(); return; }
    // Smoothness sets how far (in screen pixels) the curve may stray from the drawn line to save points.
    const eps = (0.6 + app.opts.pen.smooth * 0.08) / this.scale;
    const end = pts[pts.length - 1];
    const closed = len * doc.zoom > 40 && Math.hypot(end.x - pts[0].x, end.y - pts[0].y) * doc.zoom < 12;
    // The line was drawn in document pixels; an outline layer keeps its points in its own.
    const inv = this.target?.inv;
    const sub = fitPolyline(inv ? pts.map((q) => apply(inv, q.x, q.y)) : pts, eps, closed);
    if (sub.pts.length < 2) { view.requestOverlay(); return; }
    const path = this.path ?? newPath();
    if (!path) return;
    path.subs.push(sub);
    this.sel = null;
    this.open = null;
    doc.commit('Draw path');
  }

  keydown(e: KeyboardEvent) {
    const doc = app.doc, path = this.path;
    if (e.key === 'Enter' || e.key === 'Escape') {
      if (!this.open && !this.sel) return false;
      this.open = null; this.sel = null;
      view.requestOverlay();
      return true;
    }
    if ((e.key === 'Delete' || e.key === 'Backspace') && doc && path && this.sel) {
      const s = path.subs[this.sel.sub];
      if (!s) return false;
      s.pts.splice(this.sel.i, 1);
      if (!s.pts.length) { path.subs.splice(this.sel.sub, 1); this.open = null; }
      else if (s.pts.length < 3) s.closed = false;
      this.sel = null;
      doc.commit('Delete point');
      return true;
    }
    return false;
  }

  overlay(ctx: CanvasRenderingContext2D) {
    const m = this.target?.m ?? identity();
    const S = (x: number, y: number) => { const d = apply(m, x, y); return view.toScreen(d.x, d.y); };
    if (this.drawn && this.drawn.length > 1) {
      // The freehand line as it's being drawn (in document pixels).
      ctx.save();
      ctx.beginPath();
      this.drawn.forEach((q, i) => { const s = view.toScreen(q.x, q.y); if (i) ctx.lineTo(s.x, s.y); else ctx.moveTo(s.x, s.y); });
      ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(0,0,0,.5)'; ctx.stroke();
      ctx.lineWidth = 1.4; ctx.strokeStyle = '#2ee6be'; ctx.stroke();
      ctx.restore();
    }
    const path = this.path;
    if (!path) return;
    ctx.save();
    // The path itself, with a dark edge so it shows on any image.
    const line = new Path2D();
    for (const s of path.subs) {
      if (!s.pts.length) continue;
      const a0 = S(s.pts[0].x, s.pts[0].y);
      line.moveTo(a0.x, a0.y);
      for (const [a, b] of segments(s)) {
        const c1 = S(a.ox, a.oy), c2 = S(b.ix, b.iy), e = S(b.x, b.y);
        line.bezierCurveTo(c1.x, c1.y, c2.x, c2.y, e.x, e.y);
      }
      if (s.closed) line.closePath();
    }
    ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(0,0,0,.55)'; ctx.stroke(line);
    ctx.lineWidth = 1.4; ctx.strokeStyle = '#2ee6be'; ctx.stroke(line);
    // Where the next point will go.
    const hv = view.hover;
    if (this.open && hv && !this.drag) {
      const s = path.subs[this.open.sub];
      const last = s?.pts[s.pts.length - 1];
      if (last) {
        const a = S(last.x, last.y), c = S(last.ox, last.oy);
        ctx.setLineDash([4, 4]); ctx.lineWidth = 1; ctx.strokeStyle = 'rgba(46,230,190,.8)';
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.quadraticCurveTo(c.x, c.y, hv.sx, hv.sy); ctx.stroke();
        ctx.setLineDash([]);
      }
    }
    // Points and handles.
    path.subs.forEach((s, si) => s.pts.forEach((pt, i) => {
      const a = S(pt.x, pt.y);
      if (isSmooth(pt) && this.handlesShown(si, i)) {
        for (const [hx, hy] of [[pt.ix, pt.iy], [pt.ox, pt.oy]]) {
          if (hx === pt.x && hy === pt.y) continue;
          const q = S(hx, hy);
          ctx.strokeStyle = 'rgba(46,230,190,.9)'; ctx.lineWidth = 1;
          ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(q.x, q.y); ctx.stroke();
          ctx.fillStyle = '#111'; ctx.beginPath(); ctx.arc(q.x, q.y, 3.2, 0, 7); ctx.fill(); ctx.stroke();
        }
      }
      const on = this.sel?.sub === si && this.sel.i === i;
      ctx.fillStyle = on ? '#2ee6be' : '#fff';
      ctx.strokeStyle = '#111';
      ctx.lineWidth = 1;
      const r = i === 0 && !s.closed ? 4.5 : 3.5;
      ctx.fillRect(a.x - r, a.y - r, r * 2, r * 2);
      ctx.strokeRect(a.x - r + 0.5, a.y - r + 0.5, r * 2 - 1, r * 2 - 1);
    }));
    ctx.restore();
  }
}

export const penTool = new PenTool();
