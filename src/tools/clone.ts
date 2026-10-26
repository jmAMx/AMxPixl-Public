import { app } from '../app';
import { Stroke } from '../core/brush';
import type { Pt } from '../core/math';
import { view } from '../ui/canvasview';
import { checkbox, slider, toast } from '../ui/widgets';
import { paintableTarget } from './paint';
import type { PInfo, Tool } from './tool';

/**
 * Clone Stamp and Healing Brush. Alt+click picks where to copy from, then paint. "Aligned" keeps the same offset
 * between strokes; otherwise each stroke starts again from the source point. Healing then blends the copied
 * texture into the surrounding colour and light when you let go.
 */
class CloneTool implements Tool {
  ownCursor = true;
  hint: string;
  private source: Pt | null = null;
  private offset: { dx: number; dy: number } | null = null;
  private stroke: Stroke | null = null;
  private onMask = false;

  constructor(public id: 'clone' | 'heal', public name: string, public key: string, public icon: Tool['icon']) {
    this.hint = id === 'clone'
      ? 'Alt+click to choose where to copy from, then paint · [ ] change size'
      : 'Alt+click a clean area to copy from, then paint over the flaw · blends into its surroundings when you let go';
  }

  private get o() { return app.opts[this.id]; }

  activate() { if (app.doc) this.offset = null; }

  options(bar: HTMLElement) {
    const o = this.o;
    bar.append(
      slider({ label: 'Size', min: 1, max: 1000, value: o.size, unit: 'px', compact: true, onInput: (v) => { o.size = v; view.requestOverlay(); }, onChange: () => app.saveOpts() }),
      slider({ label: 'Hardness', min: 0, max: 1, display: 100, value: o.hardness, unit: '%', compact: true, onInput: (v) => { o.hardness = v; }, onChange: () => app.saveOpts() }),
      slider({ label: 'Opacity', min: 0.01, max: 1, display: 100, value: o.opacity, unit: '%', compact: true, onInput: (v) => { o.opacity = v; }, onChange: () => app.saveOpts() }),
      checkbox('Aligned', o.aligned, (v) => { o.aligned = v; this.offset = null; app.saveOpts(); }, 'Keep the same source offset from stroke to stroke'),
      checkbox('Pen pressure', o.pressure, (v) => { o.pressure = v; app.saveOpts(); }),
    );
  }

  down(p: PInfo) {
    if (p.alt) {
      this.source = { x: p.x, y: p.y };
      this.offset = null;
      view.requestOverlay();
      return;
    }
    if (!this.source) { toast('Alt+click first to choose where to copy from.'); return; }
    const doc = app.doc!;
    const pt = paintableTarget(doc);
    if (!pt) return;
    if (!this.o.aligned || !this.offset) this.offset = { dx: this.source.x - p.x, dy: this.source.y - p.y };
    const o = this.o;
    this.onMask = pt.isMask;
    this.stroke = new Stroke(doc, pt.target, {
      color: '#ffffff', size: o.size, hardness: o.hardness, opacity: o.opacity, flow: o.flow, erase: false, pressure: o.pressure,
      clone: this.offset, heal: this.id === 'heal',
    });
    this.stroke.add({ x: p.x, y: p.y, pressure: p.pressure });
  }

  move(p: PInfo) { this.stroke?.add({ x: p.x, y: p.y, pressure: p.pressure }); }

  up() {
    if (!this.stroke) return;
    this.stroke.end(this.onMask ? 'Clone mask' : this.id === 'heal' ? 'Healing Brush' : 'Clone Stamp');
    this.stroke = null;
    if (!this.o.aligned) this.offset = null;
  }

  keydown(e: KeyboardEvent) {
    if (e.key !== '[' && e.key !== ']') return false;
    const o = this.o;
    const step = o.size < 10 ? 1 : o.size < 50 ? 5 : o.size < 200 ? 10 : 50;
    o.size = Math.max(1, Math.min(1000, o.size + (e.key === ']' ? step : -step)));
    app.saveOpts();
    return true;
  }

  overlay(ctx: CanvasRenderingContext2D) {
    const hv = view.hover;
    const r = Math.max(1, (this.o.size / 2) * view.zoom);
    ctx.save();
    ctx.lineWidth = 1;
    if (hv) {
      ctx.strokeStyle = 'rgba(0,0,0,.7)';
      ctx.beginPath(); ctx.arc(hv.sx, hv.sy, r + 0.5, 0, Math.PI * 2); ctx.stroke();
      ctx.strokeStyle = 'rgba(255,255,255,.9)';
      ctx.beginPath(); ctx.arc(hv.sx, hv.sy, r - 0.5, 0, Math.PI * 2); ctx.stroke();
    }
    // Where pixels are being copied from: follows the brush once a stroke has set the offset.
    const src = hv && this.offset ? { x: hv.x + this.offset.dx, y: hv.y + this.offset.dy } : this.source;
    if (src) {
      const s = view.toScreen(src.x, src.y);
      ctx.strokeStyle = '#2ee6be';
      ctx.setLineDash([3, 3]);
      ctx.beginPath(); ctx.arc(s.x, s.y, r, 0, Math.PI * 2); ctx.stroke();
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.moveTo(s.x - 6, s.y); ctx.lineTo(s.x + 6, s.y);
      ctx.moveTo(s.x, s.y - 6); ctx.lineTo(s.x, s.y + 6);
      ctx.stroke();
    }
    ctx.restore();
  }
}

export const cloneTool = new CloneTool('clone', 'Clone Stamp', 'S', 'stamp');
export const healTool = new CloneTool('heal', 'Healing Brush', 'J', 'heal');
