import { app } from '../app';
import { ctx2d } from '../core/layers';
import { intersect, invert, type Mat, type Pt } from '../core/math';
import { renderDoc } from '../core/render';
import { opPath } from '../core/selection';
import type { PInfo, Tool } from '../tools/tool';
import { h } from './dom';

const ZOOM_STEPS = [0.02, 0.03, 0.05, 0.0667, 0.0833, 0.125, 0.1667, 0.25, 0.3333, 0.5, 0.6667, 1, 1.5, 2, 3, 4, 5, 6, 8, 12, 16, 24, 32];

class CanvasView {
  readonly el = h('div', { class: 'workspace' });
  readonly canvas = h('canvas', { class: 'view' });
  private composite = document.createElement('canvas');
  private compRect = { x: 0, y: 0, w: 0, h: 0 };
  private dirty = true;
  private raf = 0;
  private dpr = 1;
  private cssW = 1;
  private cssH = 1;
  private checker: CanvasPattern | null = null;
  private antsOffset = 0;
  private antsTimer = 0;
  private panning: { x: number; y: number; px: number; py: number } | null = null;
  private down = false;
  private spaceHeld = false;
  private activeTool: Tool | null = null;
  hover: PInfo | null = null;
  onCursor: (p: Pt | null) => void = () => {};

  constructor() {
    this.el.append(this.canvas);
    new ResizeObserver(() => this.resize()).observe(this.el);
    this.canvas.addEventListener('pointerdown', (e) => this.onDown(e));
    this.canvas.addEventListener('pointermove', (e) => this.onMove(e));
    this.canvas.addEventListener('pointerup', (e) => this.onUp(e));
    this.canvas.addEventListener('pointercancel', (e) => this.onUp(e));
    this.canvas.addEventListener('pointerleave', () => { if (!this.down) { this.hover = null; this.onCursor(null); this.requestOverlay(); } });
    this.canvas.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    this.canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('keydown', (e) => {
      if (e.code === 'Space' && !e.repeat && !isField(e.target)) { this.spaceHeld = true; this.updateCursor(); e.preventDefault(); }
    });
    window.addEventListener('keyup', (e) => { if (e.code === 'Space') { this.spaceHeld = false; this.updateCursor(); } });
    window.addEventListener('blur', () => { this.spaceHeld = false; });
    app.on('change', ({ doc }) => { if (doc === app.doc) { this.requestRender(); this.syncAnts(); } });
    app.on('docs', () => { this.ensureFitted(); this.requestRender(); this.syncAnts(); });
    app.on('tool', () => { this.updateCursor(); this.requestOverlay(); });
    app.on('prefs', () => { this.checker = null; this.requestRender(); });
  }

  get doc() { return app.doc; }
  get zoom() { return this.doc?.zoom ?? 1; }

  /** Document -> workspace CSS pixels. */
  get viewMatrix(): Mat {
    const d = this.doc;
    return d ? [d.zoom, 0, 0, d.zoom, d.panX, d.panY] : [1, 0, 0, 1, 0, 0];
  }

  toScreen(x: number, y: number): Pt {
    const d = this.doc!;
    return { x: x * d.zoom + d.panX, y: y * d.zoom + d.panY };
  }

  toDoc(sx: number, sy: number): Pt {
    const d = this.doc!;
    return { x: (sx - d.panX) / d.zoom, y: (sy - d.panY) / d.zoom };
  }

  get size() { return { w: this.cssW, h: this.cssH }; }

  requestRender() { this.dirty = true; this.schedule(); }
  requestOverlay() { this.schedule(); }

  private schedule() {
    if (!this.raf) this.raf = requestAnimationFrame(() => { this.raf = 0; this.paint(); });
  }

  private resize() {
    const r = this.el.getBoundingClientRect();
    this.dpr = window.devicePixelRatio || 1;
    this.cssW = Math.max(1, Math.round(r.width));
    this.cssH = Math.max(1, Math.round(r.height));
    this.canvas.width = Math.round(this.cssW * this.dpr);
    this.canvas.height = Math.round(this.cssH * this.dpr);
    this.canvas.style.width = `${this.cssW}px`;
    this.canvas.style.height = `${this.cssH}px`;
    this.ensureFitted();
    this.requestRender();
  }

  private ensureFitted() {
    const d = this.doc;
    if (d && !d.fitted && this.cssW > 10) { this.fit(); d.fitted = true; }
  }

  fit() {
    const d = this.doc;
    if (!d) return;
    const pad = 40;
    const z = Math.min((this.cssW - pad * 2) / d.width, (this.cssH - pad * 2) / d.height, 1);
    this.setZoom(Math.max(0.01, z));
    this.center();
  }

  center() {
    const d = this.doc;
    if (!d) return;
    d.panX = Math.round((this.cssW - d.width * d.zoom) / 2);
    d.panY = Math.round((this.cssH - d.height * d.zoom) / 2);
    this.changed();
  }

  setZoom(z: number, ax = this.cssW / 2, ay = this.cssH / 2) {
    const d = this.doc;
    if (!d) return;
    z = Math.max(0.01, Math.min(64, z));
    const p = this.toDoc(ax, ay);
    d.zoom = z;
    d.panX = ax - p.x * z;
    d.panY = ay - p.y * z;
    this.changed();
  }

  zoomStep(dir: 1 | -1, ax?: number, ay?: number) {
    const z = this.zoom;
    const next = dir > 0 ? ZOOM_STEPS.find((s) => s > z * 1.001) ?? 64 : [...ZOOM_STEPS].reverse().find((s) => s < z / 1.001) ?? 0.01;
    this.setZoom(next, ax, ay);
  }

  panBy(dx: number, dy: number) {
    const d = this.doc;
    if (!d) return;
    d.panX += dx;
    d.panY += dy;
    this.changed();
  }

  private changed() {
    this.requestRender();
    app.emit('view');
  }

  // ---------- painting ----------

  private paint() {
    const ctx = ctx2d(this.canvas);
    const dpr = this.dpr;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    const d = this.doc;
    if (!d) return;
    const z = d.zoom * dpr;
    const dx = d.panX * dpr, dy = d.panY * dpr;
    const docR = { x: dx, y: dy, w: d.width * z, h: d.height * z };
    const vis = intersect(docR, { x: 0, y: 0, w: this.canvas.width, h: this.canvas.height });

    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,.45)';
    ctx.shadowBlur = 18 * dpr;
    ctx.fillStyle = '#808080';
    ctx.fillRect(docR.x, docR.y, docR.w, docR.h);
    ctx.restore();
    if (vis) {
      const vr = { x: Math.floor(vis.x), y: Math.floor(vis.y), w: Math.ceil(vis.x + vis.w) - Math.floor(vis.x), h: Math.ceil(vis.y + vis.h) - Math.floor(vis.y) };
      ctx.save();
      ctx.beginPath();
      ctx.rect(docR.x, docR.y, docR.w, docR.h);
      ctx.clip();
      ctx.fillStyle = this.checkerPattern(ctx);
      ctx.fillRect(vr.x, vr.y, vr.w, vr.h);
      if (this.dirty || vr.x !== this.compRect.x || vr.y !== this.compRect.y || vr.w !== this.compRect.w || vr.h !== this.compRect.h) {
        if (this.composite.width !== vr.w || this.composite.height !== vr.h) {
          this.composite.width = vr.w;
          this.composite.height = vr.h;
        }
        renderDoc(d, this.composite, [z, 0, 0, z, dx - vr.x, dy - vr.y]);
        this.compRect = vr;
        this.dirty = false;
      }
      ctx.drawImage(this.composite, vr.x, vr.y);
      ctx.restore();
    }

    // Selection outline ("marching ants").
    if (d.selection) {
      ctx.save();
      ctx.setTransform(z, 0, 0, z, dx, dy);
      ctx.lineWidth = 1 / d.zoom;
      for (const op of d.selection.ops) {
        const path = opPath(op);
        ctx.setLineDash([]);
        ctx.strokeStyle = '#000';
        ctx.stroke(path);
        ctx.setLineDash([4 / d.zoom, 4 / d.zoom]);
        ctx.lineDashOffset = -this.antsOffset / d.zoom;
        ctx.strokeStyle = '#fff';
        ctx.stroke(path);
      }
      ctx.restore();
    }

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    app.tool?.overlay?.(ctx);
  }

  private checkerPattern(ctx: CanvasRenderingContext2D) {
    if (this.checker) return this.checker;
    const s = Math.round(8 * this.dpr);
    const c = document.createElement('canvas');
    c.width = c.height = s * 2;
    const x = ctx2d(c);
    const light = document.documentElement.dataset.theme === 'light';
    x.fillStyle = light ? '#ffffff' : '#5a5f5e';
    x.fillRect(0, 0, s * 2, s * 2);
    x.fillStyle = light ? '#e3e3e3' : '#4a4f4e';
    x.fillRect(0, 0, s, s);
    x.fillRect(s, s, s, s);
    this.checker = ctx.createPattern(c, 'repeat');
    return this.checker!;
  }

  /** Animates the selection outline only while there is one. */
  syncAnts() {
    const want = !!this.doc?.selection;
    if (want && !this.antsTimer) {
      this.antsTimer = window.setInterval(() => {
        if (!this.doc?.selection) { this.syncAnts(); return; }
        this.antsOffset = (this.antsOffset + 1) % 8;
        this.requestOverlay();
      }, 90);
    } else if (!want && this.antsTimer) {
      clearInterval(this.antsTimer);
      this.antsTimer = 0;
      this.requestOverlay();
    }
  }

  // ---------- input ----------

  private info(e: PointerEvent): PInfo {
    const r = this.canvas.getBoundingClientRect();
    const sx = e.clientX - r.left, sy = e.clientY - r.top;
    const p = this.doc ? this.toDoc(sx, sy) : { x: 0, y: 0 };
    const pen = e.pointerType === 'pen';
    return { x: p.x, y: p.y, sx, sy, pressure: pen ? e.pressure || 0.5 : 1, pen, shift: e.shiftKey, alt: e.altKey, ctrl: e.ctrlKey || e.metaKey, button: e.button };
  }

  private onDown(e: PointerEvent) {
    if (!this.doc) return;
    // Stop the browser moving focus to <body> after this handler, so tools can focus their own editors.
    e.preventDefault();
    (document.activeElement as HTMLElement | null)?.blur?.();
    this.canvas.setPointerCapture(e.pointerId);
    const p = this.info(e);
    if (e.button === 1 || (e.button === 0 && (this.spaceHeld || app.tool.id === 'hand'))) {
      this.panning = { x: p.sx, y: p.sy, px: this.doc.panX, py: this.doc.panY };
      this.updateCursor();
      return;
    }
    if (e.button !== 0 || app.busy) return;
    this.down = true;
    this.activeTool = app.tool;
    app.tool.down?.(p);
    this.requestOverlay();
  }

  private onMove(e: PointerEvent) {
    if (!this.doc) return;
    const p = this.info(e);
    this.hover = p;
    this.onCursor({ x: p.x, y: p.y });
    if (this.panning) {
      this.doc.panX = this.panning.px + (p.sx - this.panning.x);
      this.doc.panY = this.panning.py + (p.sy - this.panning.y);
      this.changed();
      return;
    }
    if (this.down && this.activeTool) {
      const evs = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : [];
      if (evs.length > 1) for (const ce of evs) this.activeTool.move?.(this.info(ce));
      else this.activeTool.move?.(p);
    } else {
      app.tool.hover?.(p);
      this.updateCursor();
    }
    this.requestOverlay();
  }

  private onUp(e: PointerEvent) {
    if (this.panning) { this.panning = null; this.updateCursor(); return; }
    if (!this.down) return;
    this.down = false;
    const t = this.activeTool;
    this.activeTool = null;
    t?.up?.(this.info(e));
    this.updateCursor();
    this.requestOverlay();
  }

  private onWheel(e: WheelEvent) {
    if (!this.doc) return;
    e.preventDefault();
    const r = this.canvas.getBoundingClientRect();
    const ax = e.clientX - r.left, ay = e.clientY - r.top;
    const scaleDelta = e.deltaMode === 1 ? 30 : 1;
    if (e.ctrlKey || e.metaKey || e.altKey) {
      const f = Math.exp(-e.deltaY * scaleDelta * 0.0018);
      this.setZoom(this.zoom * f, ax, ay);
    } else if (e.shiftKey) {
      this.panBy(-(e.deltaY || e.deltaX) * scaleDelta, 0);
    } else {
      this.panBy(-e.deltaX * scaleDelta, -e.deltaY * scaleDelta);
    }
  }

  updateCursor() {
    let c = 'default';
    if (this.panning) c = 'grabbing';
    else if (this.spaceHeld || app.tool?.id === 'hand') c = 'grab';
    else if (app.tool?.ownCursor && this.hover) c = 'none';
    else if (app.tool?.cursor) c = app.tool.cursor(this.hover);
    if (this.canvas.style.cursor !== c) this.canvas.style.cursor = c;
  }

  /** Workspace position (CSS px) of the canvas element, for placing floating editors. */
  clientRect() { return this.canvas.getBoundingClientRect(); }

  invView(): Mat { return invert(this.viewMatrix); }
}

const isField = (t: EventTarget | null) => {
  const el = t as HTMLElement | null;
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);
};

export const view = new CanvasView();
