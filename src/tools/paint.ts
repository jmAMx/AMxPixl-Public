import { app } from '../app';
import { Stroke } from '../core/brush';
import type { Doc } from '../core/document';
import { lumOf } from '../actions';
import { ctx2d, newCanvas } from '../core/layers';
import { apply, invert, mapRect, setT, xformMatrix, type Pt, type Rect } from '../core/math';
import { sampleDoc } from '../core/render';
import type { PixelTarget } from '../core/types';
import { hexToRgb, rgbToHex } from '../ui/color';
import { view } from '../ui/canvasview';
import { h } from '../ui/dom';
import { checkbox, icon, seg, slider, toast } from '../ui/widgets';
import { brushDialog } from '../ui/brushpanel';
import { listTips } from '../core/tips';
import { drawSymmetryGuides, symmetryControl, symmetryCopies, symmetryDown, symmetryMove, symmetryUp } from './symmetry';
import type { PInfo, Tool } from './tool';

/** What painting should go to (the active layer's pixels or its mask), or null after explaining why not. */
export function paintableTarget(doc: Doc): { target: PixelTarget; isMask: boolean } | null {
  const a = doc.active;
  if (!a) { toast('Add a layer first (Layer › New Layer).'); return null; }
  const pt = doc.paintTarget();
  if (pt) {
    if (!doc.shows(a)) { toast(doc.anim ? 'That layer is hidden in this frame. Show it before painting.' : 'That layer is hidden. Show it before painting.'); return null; }
    return pt;
  }
  if (a.type === 'raster' && a.model) toast('This is a 3D layer. Rasterize it first (Properties › 3D › Rasterize) to paint on it.');
  else if (a.type === 'raster' && a.warp) toast('This layer is warped. Apply the warp first (Layer › Transform › Apply Warp) to paint on it.');
  else if (a.type === 'text' || a.type === 'shape') toast(`"${a.name}" is a ${a.type} layer. Rasterize it first (Layer › Rasterize), or add a new layer to paint on.`);
  else toast(`${a.type === 'group' ? 'Groups' : a.type === 'effect' ? 'Effect layers' : 'Adjustment layers'} have no pixels. Add a mask (Layer › Add Layer Mask) to paint where it applies.`);
  return null;
}

/** On a mask, light colours reveal and dark colours hide (like Photoshop's white/black). */
const maskHides = () => lumOf(app.fg) < 0.5;

function pickColor(p: PInfo, toBg = false) {
  const doc = app.doc!;
  const [r, g, b, a] = sampleDoc(doc, p.x, p.y, app.opts.picker.sample);
  if (!a) return;
  app.setColor(toBg ? 'bg' : 'fg', rgbToHex(r, g, b));
}

function drawBrushCursor(ctx: CanvasRenderingContext2D, size: number) {
  const hv = view.hover;
  if (!hv) return;
  const r = Math.max(1, (size / 2) * view.zoom);
  ctx.save();
  ctx.lineWidth = 1;
  ctx.strokeStyle = 'rgba(0,0,0,.7)';
  ctx.beginPath(); ctx.arc(hv.sx, hv.sy, r + 0.5, 0, Math.PI * 2); ctx.stroke();
  ctx.strokeStyle = 'rgba(255,255,255,.9)';
  ctx.beginPath(); ctx.arc(hv.sx, hv.sy, r - 0.5, 0, Math.PI * 2); ctx.stroke();
  if (r < 6) {
    ctx.beginPath();
    ctx.moveTo(hv.sx - 6, hv.sy); ctx.lineTo(hv.sx + 6, hv.sy);
    ctx.moveTo(hv.sx, hv.sy - 6); ctx.lineTo(hv.sx, hv.sy + 6);
    ctx.stroke();
  }
  ctx.restore();
}

class PaintTool implements Tool {
  ownCursor = true;
  hint: string;
  private stroke: Stroke | null = null;
  private last: Pt | null = null;
  private onMask = false;

  constructor(public id: 'brush' | 'eraser', public name: string, public key: string, public icon: Tool['icon']) {
    this.hint = id === 'brush'
      ? 'Paint · Shift+click draws a straight line · Alt+click picks a colour · [ ] change size'
      : 'Erase to transparency · Shift+click erases a straight line · [ ] change size';
  }

  private get o() { return app.opts[this.id]; }

  options(bar: HTMLElement) {
    const o = this.o;
    const tipName = listTips().find((t) => t.id === o.tip)?.label ?? 'Round';
    bar.append(
      h('button', { class: 'btn small', type: 'button', title: 'Brush presets, tip shape, spacing, jitter and scatter', onclick: () => brushDialog(this.id) }, icon('brush'), tipName),
      slider({ label: 'Size', min: 1, max: 1000, value: o.size, unit: 'px', compact: true, onInput: (v) => { o.size = v; view.requestOverlay(); }, onChange: () => app.saveOpts() }),
      slider({ label: 'Hardness', min: 0, max: 1, step: 1, display: 100, value: o.hardness, unit: '%', compact: true, onInput: (v) => { o.hardness = v; }, onChange: () => app.saveOpts() }),
      slider({ label: 'Opacity', min: 0.01, max: 1, step: 1, display: 100, value: o.opacity, unit: '%', compact: true, onInput: (v) => { o.opacity = v; }, onChange: () => app.saveOpts() }),
      slider({ label: 'Flow', min: 0.01, max: 1, step: 1, display: 100, value: o.flow, unit: '%', compact: true, onInput: (v) => { o.flow = v; }, onChange: () => app.saveOpts() }),
      checkbox('Pen pressure', o.pressure, (v) => { o.pressure = v; app.saveOpts(); }, 'Pressure controls size when using a drawing tablet'),
      checkbox('Anti-alias', o.antiAlias, (v) => { o.antiAlias = v; app.saveOpts(); }, 'Turn off to paint whole pixels with hard edges, like a pencil (pixel art)'),
      symmetryControl(),
    );
  }

  down(p: PInfo) {
    if (p.alt && this.id === 'brush') { pickColor(p); return; }
    if (symmetryDown(p)) return;
    const doc = app.doc!;
    const pt = paintableTarget(doc);
    if (!pt) return;
    const o = this.o;
    this.onMask = pt.isMask;
    const erase = pt.isMask ? this.id === 'eraser' || maskHides() : this.id === 'eraser';
    this.stroke = new Stroke(doc, pt.target, { color: pt.isMask ? '#ffffff' : app.fg, size: o.size, hardness: o.hardness, opacity: o.opacity, flow: o.flow, erase, pressure: o.pressure, aliased: !o.antiAlias,
      tip: o.tip, spacing: o.spacing / 100, jitter: o.jitter, scatter: o.scatter, copies: symmetryCopies(doc) });
    if (p.shift && this.last) this.stroke.add({ x: this.last.x, y: this.last.y, pressure: p.pressure });
    this.stroke.add({ x: p.x, y: p.y, pressure: p.pressure });
  }

  move(p: PInfo) {
    if (symmetryMove(p)) return;
    if (p.alt && this.id === 'brush' && !this.stroke) { pickColor(p); return; }
    this.stroke?.add({ x: p.x, y: p.y, pressure: p.pressure });
  }

  up(p: PInfo) {
    if (symmetryUp()) return;
    if (!this.stroke) return;
    this.stroke.end(this.onMask ? 'Paint mask' : this.id === 'brush' ? 'Brush' : 'Eraser');
    this.stroke = null;
    this.last = { x: p.x, y: p.y };
    if (this.id === 'brush' && !this.onMask) app.useColor(app.fg);
  }

  keydown(e: KeyboardEvent) {
    if (e.key !== '[' && e.key !== ']') return false;
    const o = this.o;
    const step = o.size < 10 ? 1 : o.size < 50 ? 5 : o.size < 200 ? 10 : 50;
    o.size = Math.max(1, Math.min(1000, o.size + (e.key === ']' ? step : -step)));
    app.saveOpts();
    view.requestOverlay();
    return true;
  }

  overlay(ctx: CanvasRenderingContext2D) { drawSymmetryGuides(ctx); drawBrushCursor(ctx, this.o.size); }
}

// ---------- paint bucket ----------

function subImage(src: ImageData, r: Rect) {
  const out = new ImageData(r.w, r.h);
  for (let y = 0; y < r.h; y++) {
    const s = ((r.y + y) * src.width + r.x) * 4;
    out.data.set(src.data.subarray(s, s + r.w * 4), y * r.w * 4);
  }
  return out;
}

class FillTool implements Tool {
  id = 'fill'; name = 'Paint Bucket'; key = 'G'; icon = 'fill' as const;
  hint = 'Click to fill similar colours with the foreground colour';
  cursor() { return 'crosshair'; }

  options(bar: HTMLElement) {
    const o = app.opts.fill;
    bar.append(
      slider({ label: 'Tolerance', min: 0, max: 255, value: o.tolerance, compact: true, onInput: (v) => { o.tolerance = v; }, onChange: () => app.saveOpts() }),
      slider({ label: 'Opacity', min: 0.01, max: 1, display: 100, value: o.opacity, unit: '%', compact: true, onInput: (v) => { o.opacity = v; }, onChange: () => app.saveOpts() }),
      checkbox('Contiguous', o.contiguous, (v) => { o.contiguous = v; app.saveOpts(); }, 'Only fill connected pixels'),
    );
  }

  down(p: PInfo) {
    const doc = app.doc!;
    const pt = paintableTarget(doc);
    if (!pt) return;
    if (pt.isMask) { toast('The paint bucket works on image pixels. To fill a mask, select an area and use Edit › Fill.'); return; }
    const layer = pt.target;
    doc.ensureCovers(layer);
    const c = doc.canvasOf(layer);
    const lp = apply(invert(xformMatrix(layer.t)), p.x, p.y);
    const sx = Math.floor(lp.x), sy = Math.floor(lp.y);
    const W = c.width, H = c.height;
    if (sx < 0 || sy < 0 || sx >= W || sy >= H) return;
    const ctx = ctx2d(c, true);
    const img = ctx.getImageData(0, 0, W, H);
    const d = img.data;
    const orig = new Uint8ClampedArray(d);
    const si = (sy * W + sx) * 4;
    const tr = d[si], tg = d[si + 1], tb = d[si + 2], ta = d[si + 3];
    const tol = app.opts.fill.tolerance;
    const match = (i: number) => Math.abs(d[i] - tr) <= tol && Math.abs(d[i + 1] - tg) <= tol && Math.abs(d[i + 2] - tb) <= tol && Math.abs(d[i + 3] - ta) <= tol;
    const hit = new Uint8Array(W * H);
    if (app.opts.fill.contiguous) {
      const stack = [sx, sy];
      while (stack.length) {
        const y = stack.pop()!, x0 = stack.pop()!;
        let x = x0;
        while (x >= 0 && !hit[y * W + x] && match((y * W + x) * 4)) x--;
        x++;
        let up = false, dn = false;
        while (x < W && !hit[y * W + x] && match((y * W + x) * 4)) {
          hit[y * W + x] = 1;
          if (y > 0) { const m = !hit[(y - 1) * W + x] && match(((y - 1) * W + x) * 4); if (m && !up) { stack.push(x, y - 1); up = true; } else if (!m) up = false; }
          if (y < H - 1) { const m = !hit[(y + 1) * W + x] && match(((y + 1) * W + x) * 4); if (m && !dn) { stack.push(x, y + 1); dn = true; } else if (!m) dn = false; }
          x++;
        }
      }
    } else {
      for (let i = 0; i < W * H; i++) if (match(i * 4)) hit[i] = 1;
    }
    const maskC = doc.maskForLayer(layer);
    const mask = maskC ? ctx2d(maskC, true).getImageData(0, 0, W, H).data : null;
    const [cr, cg, cb] = hexToRgb(app.fg);
    const op = app.opts.fill.opacity;
    let x0 = W, y0 = H, x1 = -1, y1 = -1;
    for (let i = 0; i < W * H; i++) {
      if (!hit[i]) continue;
      const a = op * (mask ? mask[i * 4 + 3] / 255 : 1);
      if (a <= 0) continue;
      const j = i * 4, pa = d[j + 3] / 255;
      const oa = a + pa * (1 - a);
      d[j] = (cr * a + d[j] * pa * (1 - a)) / oa;
      d[j + 1] = (cg * a + d[j + 1] * pa * (1 - a)) / oa;
      d[j + 2] = (cb * a + d[j + 2] * pa * (1 - a)) / oa;
      d[j + 3] = oa * 255;
      const x = i % W, y = (i / W) | 0;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
    if (x1 < 0) return;
    const r = { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
    const before = newCanvas(r.w, r.h);
    ctx2d(before).putImageData(subImage(new ImageData(orig, W, H), r), 0, 0);
    ctx.putImageData(subImage(img, r), r.x, r.y);
    doc.commit('Paint Bucket', [{ key: layer.key, rect: r, before, after: null }]);
    app.useColor(app.fg);
  }
}

// ---------- gradient ----------

class GradientTool implements Tool {
  id = 'gradient'; name = 'Gradient'; key = 'G'; icon = 'gradient' as const;
  hint = 'Drag to draw a gradient from the foreground to the background colour · Shift snaps to 45°';
  private p0: Pt | null = null;
  private p1: Pt | null = null;
  cursor() { return 'crosshair'; }

  options(bar: HTMLElement) {
    const o = app.opts.gradient;
    bar.append(
      seg([{ v: 'linear', label: 'Linear' }, { v: 'radial', label: 'Radial' }], o.kind, (v) => { o.kind = v; app.saveOpts(); }),
      seg([{ v: 'bg', label: 'FG → BG' }, { v: 'clear', label: 'FG → Transparent' }], o.toTransparent ? 'clear' : 'bg', (v) => { o.toTransparent = v === 'clear'; app.saveOpts(); }),
      slider({ label: 'Opacity', min: 0.01, max: 1, display: 100, value: o.opacity, unit: '%', compact: true, onInput: (v) => { o.opacity = v; }, onChange: () => app.saveOpts() }),
    );
  }

  down(p: PInfo) { this.p0 = { x: p.x, y: p.y }; this.p1 = { ...this.p0 }; }

  move(p: PInfo) {
    if (!this.p0) return;
    let x = p.x, y = p.y;
    if (p.shift) {
      const a = Math.round(Math.atan2(y - this.p0.y, x - this.p0.x) / (Math.PI / 4)) * (Math.PI / 4);
      const len = Math.hypot(x - this.p0.x, y - this.p0.y);
      x = this.p0.x + Math.cos(a) * len; y = this.p0.y + Math.sin(a) * len;
    }
    this.p1 = { x, y };
    view.requestOverlay();
  }

  up() {
    const p0 = this.p0, p1 = this.p1;
    this.p0 = this.p1 = null;
    view.requestOverlay();
    if (!p0 || !p1 || Math.hypot(p1.x - p0.x, p1.y - p0.y) < 1) return;
    const doc = app.doc!;
    const pt = paintableTarget(doc);
    if (!pt) return;
    const layer = pt.target;
    doc.ensureCovers(layer);
    const o = app.opts.gradient;
    const mask = doc.maskForLayer(layer);
    const m = xformMatrix(layer.t);
    doc.editPixels(layer, pt.isMask ? 'Mask gradient' : 'Gradient', (ctx, c) => {
      const tmp = newCanvas(c.width, c.height);
      const t = ctx2d(tmp);
      setT(t, invert(m));
      const g = o.kind === 'linear'
        ? t.createLinearGradient(p0.x, p0.y, p1.x, p1.y)
        : t.createRadialGradient(p0.x, p0.y, 0, p0.x, p0.y, Math.hypot(p1.x - p0.x, p1.y - p0.y));
      if (pt.isMask) {
        // On a mask the gradient sets visibility: light = shown, dark = hidden.
        g.addColorStop(0, `rgba(255,255,255,${lumOf(app.fg)})`);
        g.addColorStop(1, `rgba(255,255,255,${o.toTransparent ? 0 : lumOf(app.bg)})`);
      } else {
        g.addColorStop(0, app.fg);
        g.addColorStop(1, o.toTransparent ? app.fg + '00' : app.bg);
      }
      t.fillStyle = g;
      const cover = mapRect(m, { x: 0, y: 0, w: c.width, h: c.height });
      t.fillRect(cover.x - 2, cover.y - 2, cover.w + 4, cover.h + 4);
      t.setTransform(1, 0, 0, 1, 0, 0);
      if (mask) { t.globalCompositeOperation = 'destination-in'; t.drawImage(mask, 0, 0); }
      ctx.globalAlpha = o.opacity;
      if (pt.isMask) {
        ctx.globalCompositeOperation = 'destination-out';
        if (mask) ctx.drawImage(mask, 0, 0); else ctx.fillRect(0, 0, c.width, c.height);
        ctx.globalCompositeOperation = 'source-over';
      }
      ctx.drawImage(tmp, 0, 0);
    });
  }

  overlay(ctx: CanvasRenderingContext2D) {
    if (!this.p0 || !this.p1) return;
    const a = view.toScreen(this.p0.x, this.p0.y), b = view.toScreen(this.p1.x, this.p1.y);
    ctx.save();
    ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(0,0,0,.6)';
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    ctx.lineWidth = 1.5; ctx.strokeStyle = '#fff';
    ctx.stroke();
    for (const [pt, col] of [[a, app.fg], [b, app.opts.gradient.toTransparent ? '#ffffff' : app.bg]] as const) {
      ctx.fillStyle = col; ctx.beginPath(); ctx.arc(pt.x, pt.y, 5, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    }
    ctx.restore();
  }
}

// ---------- eyedropper ----------

class PickerTool implements Tool {
  id = 'picker'; name = 'Eyedropper'; key = 'I'; icon = 'picker' as const;
  hint = 'Click to pick the foreground colour from the image · Alt+click sets the background colour';
  cursor() { return 'crosshair'; }
  options(bar: HTMLElement) {
    const o = app.opts.picker;
    bar.append(h('label', { class: 'opt' }, h('span', { class: 'opt-label' }, 'Sample'),
      seg([{ v: '1', label: 'Point' }, { v: '3', label: '3×3' }, { v: '5', label: '5×5' }], String(o.sample) as '1' | '3' | '5', (v) => { o.sample = Number(v); app.saveOpts(); })));
  }
  down(p: PInfo) { pickColor(p, p.alt); }
  move(p: PInfo) { pickColor(p, p.alt); }
  up() { app.useColor(app.fg); }
}

export const brushTool = new PaintTool('brush', 'Brush', 'B', 'brush');
export const eraserTool = new PaintTool('eraser', 'Eraser', 'E', 'eraser');
export const fillTool = new FillTool();
export const gradientTool = new GradientTool();
export const pickerTool = new PickerTool();
