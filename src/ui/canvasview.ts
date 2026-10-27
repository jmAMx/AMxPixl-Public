import { app } from '../app';
import { ctx2d, newCanvas } from '../core/layers';
import { intersect, invert, type Mat, type Pt } from '../core/math';
import { renderDoc } from '../core/render';
import type { PInfo, Tool } from '../tools/tool';
import { addGuide } from '../actions';
import { h } from './dom';
import { clearSnapLines, snapLines, snapPoint } from './snap';

const ZOOM_STEPS = [0.02, 0.03, 0.05, 0.0667, 0.0833, 0.125, 0.1667, 0.25, 0.3333, 0.5, 0.6667, 1, 1.5, 2, 3, 4, 5, 6, 8, 12, 16, 24, 32];

class CanvasView {
  readonly el = h('div', { class: 'workspace' });
  readonly canvas = h('canvas', { class: 'view' });
  private composite = document.createElement('canvas');
  private qmTint = document.createElement('canvas');
  private onionCanvas = document.createElement('canvas');
  private onion: HTMLCanvasElement | null = null;
  private compRect = { x: 0, y: 0, w: 0, h: 0 };
  private compScale = 1;
  /** A pointer/slider drag is in progress somewhere in the app. */
  private interacting = false;
  /** Recent full-quality frames took too long (measured as the gap between redraws while dragging). */
  private slowFrames = false;
  private lastPaint = 0;
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
    window.addEventListener('pointerdown', () => { this.interacting = true; this.lastPaint = 0; }, true);
    const release = () => {
      if (!this.interacting) return;
      this.interacting = false;
      if (this.compScale !== 1) this.requestRender();
    };
    window.addEventListener('pointerup', release, true);
    window.addEventListener('pointercancel', release, true);
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
  /** A drag is in progress (background work like autosave waits for it to finish). */
  get busy() { return this.interacting || this.down; }

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
      // While dragging something, drop to half resolution if full-quality frames are too slow; sharpen on release.
      const k = this.interacting && this.slowFrames ? 0.5 : 1;
      if (this.dirty || k !== this.compScale || vr.x !== this.compRect.x || vr.y !== this.compRect.y || vr.w !== this.compRect.w || vr.h !== this.compRect.h) {
        const cw = Math.max(1, Math.ceil(vr.w * k)), ch = Math.max(1, Math.ceil(vr.h * k));
        if (this.composite.width !== cw || this.composite.height !== ch) {
          this.composite.width = cw;
          this.composite.height = ch;
        }
        const t0 = performance.now();
        renderDoc(d, this.composite, [z * k, 0, 0, z * k, (dx - vr.x) * k, (dy - vr.y) * k], { screen: true });
        this.noteFrame(performance.now() - t0, k);
        // Onion skin: the frames either side, tinted (red before, green after), for lining up motion.
        const a = d.anim;
        this.onion = null;
        if (a && app.prefs.onion && !app.playing && a.frames.length > 1) {
          const oc = this.onionCanvas;
          if (oc.width !== this.composite.width || oc.height !== this.composite.height) { oc.width = this.composite.width; oc.height = this.composite.height; }
          const ox = ctx2d(oc);
          ox.clearRect(0, 0, oc.width, oc.height);
          const tmp = newCanvas(oc.width, oc.height);
          for (const [f, tint] of [[d.frame - 1, 'rgb(255,60,60)'], [d.frame + 1, 'rgb(40,220,120)']] as [number, string][]) {
            if (f < 0 || f >= a.frames.length) continue;
            // Only what that frame shows and this one doesn't, so the shared background isn't washed out.
            const only = d.layers.filter((l) => d.shows(l, f) && !d.shows(l));
            if (!only.length) continue;
            renderDoc(d, tmp, [z * k, 0, 0, z * k, (dx - vr.x) * k, (dy - vr.y) * k], { screen: true, frame: f, layers: only });
            const tx = ctx2d(tmp);
            tx.globalCompositeOperation = 'source-atop';
            tx.globalAlpha = 0.45;
            tx.fillStyle = tint;
            tx.fillRect(0, 0, tmp.width, tmp.height);
            tx.globalCompositeOperation = 'source-over';
            tx.globalAlpha = 1;
            ox.globalAlpha = 0.3;
            ox.drawImage(tmp, 0, 0);
          }
          this.onion = oc;
        }
        this.compRect = vr;
        this.compScale = k;
        this.dirty = false;
      }
      ctx.imageSmoothingEnabled = true;
      if (k === 1) ctx.drawImage(this.composite, vr.x, vr.y);
      else ctx.drawImage(this.composite, vr.x, vr.y, vr.w, vr.h);
      if (this.onion) ctx.drawImage(this.onion, vr.x, vr.y, vr.w, vr.h);
      // Pixel grid: one line per image pixel once each pixel is big enough to see (600% and up).
      if (app.prefs.pixelGrid && d.zoom >= 6) {
        const i0 = Math.max(0, Math.floor((vr.x - dx) / z)), i1 = Math.min(d.width, Math.ceil((vr.x + vr.w - dx) / z));
        const j0 = Math.max(0, Math.floor((vr.y - dy) / z)), j1 = Math.min(d.height, Math.ceil((vr.y + vr.h - dy) / z));
        ctx.beginPath();
        for (let i = i0; i <= i1; i++) { const x = Math.round(dx + i * z) + 0.5; ctx.moveTo(x, vr.y); ctx.lineTo(x, vr.y + vr.h); }
        for (let j = j0; j <= j1; j++) { const y = Math.round(dy + j * z) + 0.5; ctx.moveTo(vr.x, y); ctx.lineTo(vr.x + vr.w, y); }
        ctx.lineWidth = 1;
        ctx.strokeStyle = 'rgba(128, 128, 128, 0.45)';
        ctx.stroke();
      }
      ctx.restore();
    }

    // Quick Mask: everything not selected is tinted red, like Photoshop.
    const qm = d.quickMask ? d.pool.get(d.quickMask) : null;
    if (qm) {
      if (this.qmTint.width !== this.canvas.width || this.qmTint.height !== this.canvas.height) { this.qmTint.width = this.canvas.width; this.qmTint.height = this.canvas.height; }
      const t = ctx2d(this.qmTint);
      t.setTransform(1, 0, 0, 1, 0, 0);
      t.globalCompositeOperation = 'copy';
      t.fillStyle = 'rgba(255, 30, 30, 0.5)';
      t.fillRect(docR.x, docR.y, docR.w, docR.h);
      t.globalCompositeOperation = 'destination-out';
      t.setTransform(z, 0, 0, z, dx, dy);
      t.drawImage(qm, 0, 0);
      ctx.drawImage(this.qmTint, 0, 0);
    }

    // Selection outline ("marching ants").
    const outline = d.selectionOutline();
    if (outline) {
      ctx.save();
      ctx.setTransform(z, 0, 0, z, dx, dy);
      ctx.lineWidth = 1 / d.zoom;
      ctx.setLineDash([]);
      ctx.strokeStyle = '#000';
      ctx.stroke(outline);
      ctx.setLineDash([4 / d.zoom, 4 / d.zoom]);
      ctx.lineDashOffset = -this.antsOffset / d.zoom;
      ctx.strokeStyle = '#fff';
      ctx.stroke(outline);
      ctx.restore();
    }

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.paintGuides(ctx);
    app.tool?.overlay?.(ctx);
    if (app.prefs.rulers) this.paintRulers(ctx);
  }

  // ---------- guides & rulers ----------

  private guideDrag: { axis: 'x' | 'y'; index: number; pos: number; fromRuler: boolean } | null = null;

  private paintGuides(ctx: CanvasRenderingContext2D) {
    const d = this.doc!;
    const line = (axis: 'x' | 'y', pos: number, color: string) => {
      const s = this.toScreen(axis === 'x' ? pos : 0, axis === 'y' ? pos : 0);
      ctx.beginPath();
      if (axis === 'x') { ctx.moveTo(Math.round(s.x) + 0.5, 0); ctx.lineTo(Math.round(s.x) + 0.5, this.cssH); }
      else { ctx.moveTo(0, Math.round(s.y) + 0.5); ctx.lineTo(this.cssW, Math.round(s.y) + 0.5); }
      ctx.strokeStyle = color;
      ctx.stroke();
    };
    ctx.save();
    ctx.lineWidth = 1;
    if (app.prefs.guides) d.guides.forEach((g, i) => { if (!(this.guideDrag && this.guideDrag.index === i)) line(g.axis, g.pos, '#22c7f5'); });
    if (this.guideDrag) line(this.guideDrag.axis, this.guideDrag.pos, '#22c7f5');
    ctx.setLineDash([4, 3]);
    for (const x of snapLines.x) line('x', x, '#ff3dbb');
    for (const y of snapLines.y) line('y', y, '#ff3dbb');
    ctx.restore();
  }

  private paintRulers(ctx: CanvasRenderingContext2D) {
    const d = this.doc!;
    const R = RULER;
    const css = getComputedStyle(document.documentElement);
    const bg = css.getPropertyValue('--panel').trim() || '#171c1b';
    const fg = css.getPropertyValue('--text-dim').trim() || '#8b9a95';
    const border = css.getPropertyValue('--border').trim() || '#29312f';
    ctx.save();
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, this.cssW, R);
    ctx.fillRect(0, 0, R, this.cssH);
    ctx.strokeStyle = border;
    ctx.beginPath(); ctx.moveTo(0, R - 0.5); ctx.lineTo(this.cssW, R - 0.5); ctx.moveTo(R - 0.5, 0); ctx.lineTo(R - 0.5, this.cssH); ctx.stroke();
    // Label every `step` document pixels, with steps at least ~60 screen pixels apart.
    const steps = [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 2500, 5000, 10000];
    const step = steps.find((s) => s * d.zoom >= 60) ?? 20000;
    const minor = step * d.zoom >= 100 ? step / 10 : step / 5;
    ctx.fillStyle = fg;
    ctx.strokeStyle = fg;
    ctx.font = '10px "Segoe UI", sans-serif';
    ctx.textBaseline = 'top';
    const x0 = this.toDoc(R, 0).x, x1 = this.toDoc(this.cssW, 0).x;
    ctx.beginPath();
    for (let v = Math.floor(x0 / minor) * minor; v <= x1; v += minor) {
      const sx = Math.round(this.toScreen(v, 0).x) + 0.5;
      if (sx < R) continue;
      const major = Math.abs(v / step - Math.round(v / step)) < 1e-6;
      ctx.moveTo(sx, major ? 2 : R - 5); ctx.lineTo(sx, R);
      if (major) ctx.fillText(String(Math.round(v)), sx + 3, 2);
    }
    const y0 = this.toDoc(0, R).y, y1 = this.toDoc(0, this.cssH).y;
    for (let v = Math.floor(y0 / minor) * minor; v <= y1; v += minor) {
      const sy = Math.round(this.toScreen(0, v).y) + 0.5;
      if (sy < R) continue;
      const major = Math.abs(v / step - Math.round(v / step)) < 1e-6;
      ctx.moveTo(major ? 2 : R - 5, sy); ctx.lineTo(R, sy);
      if (major) {
        ctx.save();
        ctx.translate(2, sy + 3);
        ctx.rotate(Math.PI / 2);
        ctx.fillText(String(Math.round(v)), 0, -9);
        ctx.restore();
      }
    }
    ctx.stroke();
    // Mark the cursor position on both rulers.
    if (this.hover) {
      ctx.strokeStyle = css.getPropertyValue('--accent').trim() || '#2ee6be';
      ctx.beginPath();
      ctx.moveTo(Math.round(this.hover.sx) + 0.5, 0); ctx.lineTo(Math.round(this.hover.sx) + 0.5, R);
      ctx.moveTo(0, Math.round(this.hover.sy) + 0.5); ctx.lineTo(R, Math.round(this.hover.sy) + 0.5);
      ctx.stroke();
    }
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, R, R);
    ctx.restore();
  }

  private overRuler(sx: number, sy: number): 'x' | 'y' | null {
    if (!app.prefs.rulers) return null;
    if (sy < RULER && sx >= RULER) return 'y';
    if (sx < RULER && sy >= RULER) return 'x';
    return null;
  }

  /** Index of the guide under a screen point (Move tool only), or -1. */
  private guideAt(sx: number, sy: number): number {
    const d = this.doc;
    if (!d || !app.prefs.guides || app.tool?.id !== 'move') return -1;
    return d.guides.findIndex((g) => {
      const s = this.toScreen(g.axis === 'x' ? g.pos : 0, g.axis === 'y' ? g.pos : 0);
      return g.axis === 'x' ? Math.abs(s.x - sx) <= 4 : Math.abs(s.y - sy) <= 4;
    });
  }

  private startGuide(p: PInfo): boolean {
    const r = this.overRuler(p.sx, p.sy);
    if (r) {
      this.guideDrag = { axis: r, index: -1, pos: r === 'x' ? p.x : p.y, fromRuler: true };
      return true;
    }
    const i = this.guideAt(p.sx, p.sy);
    if (i >= 0) {
      const g = this.doc!.guides[i];
      this.guideDrag = { axis: g.axis, index: i, pos: g.pos, fromRuler: false };
      return true;
    }
    return false;
  }

  private moveGuide(p: PInfo) {
    const g = this.guideDrag!;
    const s = snapPoint(p.x, p.y);
    g.pos = g.axis === 'x' ? (p.ctrl ? p.x : s.x) : (p.ctrl ? p.y : s.y);
    clearSnapLines();
    this.requestOverlay();
  }

  private endGuide(p: PInfo) {
    const g = this.guideDrag!;
    this.guideDrag = null;
    const d = this.doc!;
    const dropped = this.overRuler(p.sx, p.sy) || p.sx < 0 || p.sy < 0 || p.sx > this.cssW || p.sy > this.cssH;
    if (g.index < 0) {
      if (!dropped) addGuide(g.axis, g.pos);
    } else if (dropped) {
      d.guides = d.guides.filter((_, i) => i !== g.index);
      d.commit('Remove guide');
    } else {
      d.guides = d.guides.map((x, i) => (i === g.index ? { ...x, pos: Math.round(g.pos) } : x));
      d.commit('Move guide');
    }
    this.requestOverlay();
  }

  /**
   * Tracks whether full-quality redraws keep up while dragging. CPU time alone misses GPU work, so the gap between
   * consecutive redraws counts too.
   */
  private noteFrame(cpuMs: number, k: number) {
    const now = performance.now();
    if (this.interacting && k === 1) {
      const gap = this.lastPaint ? now - this.lastPaint : 0;
      if (Math.max(cpuMs, gap > 200 ? 0 : gap) > 34) this.slowFrames = true;
    } else if (!this.interacting && k === 1 && cpuMs < 12) {
      this.slowFrames = false;
    }
    this.lastPaint = now;
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
    if (this.startGuide(p)) { this.updateCursor(); return; }
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
    if (this.guideDrag) { this.moveGuide(p); return; }
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
    if (this.guideDrag) { this.endGuide(this.info(e)); this.updateCursor(); return; }
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
    const hv = this.hover;
    const g = this.guideDrag ? this.guideDrag.axis : hv ? (this.overRuler(hv.sx, hv.sy) ?? (this.guideAt(hv.sx, hv.sy) >= 0 ? this.doc!.guides[this.guideAt(hv.sx, hv.sy)].axis : null)) : null;
    if (this.panning) c = 'grabbing';
    else if (g) c = g === 'x' ? 'col-resize' : 'row-resize';
    else if (this.spaceHeld || app.tool?.id === 'hand') c = 'grab';
    else if (app.tool?.ownCursor && this.hover) c = 'none';
    else if (app.tool?.cursor) c = app.tool.cursor(this.hover);
    if (this.canvas.style.cursor !== c) this.canvas.style.cursor = c;
  }

  /** Workspace position (CSS px) of the canvas element, for placing floating editors. */
  clientRect() { return this.canvas.getBoundingClientRect(); }

  invView(): Mat { return invert(this.viewMatrix); }
}

/** Ruler thickness in CSS pixels. */
const RULER = 18;

const isField = (t: EventTarget | null) => {
  const el = t as HTMLElement | null;
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);
};

export const view = new CanvasView();
