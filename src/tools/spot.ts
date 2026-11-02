import { app } from '../app';
import { ctx2d, newCanvas } from '../core/layers';
import { apply, invert, xformMatrix, type Mat, type Pt } from '../core/math';
import type { PixelTarget } from '../core/types';
import { view } from '../ui/canvasview';
import { fillArea } from '../ui/dialogs';
import { slider } from '../ui/widgets';
import { paintableTarget } from './paint';
import type { PInfo, Tool } from './tool';

/**
 * Spot Removal: paint over a spot, speck, scratch or small object, and when you let go it's filled from what's around
 * it (the same as Content-Aware Fill, for the painted area). Nothing to set up: no source to pick, unlike the
 * Healing Brush.
 */
class SpotTool implements Tool {
  id = 'spot'; name = 'Spot Removal'; key = 'J'; icon = 'spot' as const;
  ownCursor = true;
  hint = 'Paint over a spot, speck or small object: when you let go it\'s filled from around it · [ ] size';
  private s: { target: PixelTarget; mask: HTMLCanvasElement; inv: Mat; last: Pt; path: Pt[] } | null = null;

  private get o() { return app.opts.spot; }

  options(bar: HTMLElement) {
    bar.append(slider({ label: 'Size', min: 2, max: 500, value: this.o.size, unit: 'px', compact: true, onInput: (v) => { this.o.size = v; view.requestOverlay(); }, onChange: () => app.saveOpts() }));
  }

  down(p: PInfo) {
    if (app.busy) return;
    const doc = app.doc!, pt = paintableTarget(doc);
    if (!pt) return;
    const c = doc.canvasOf(pt.target);
    const m = xformMatrix(pt.target.t), inv = invert(m);
    const mask = newCanvas(c.width, c.height);
    const x = ctx2d(mask);
    // The stroke in the layer's own pixels: as wide as the brush looks on the canvas.
    x.lineWidth = this.o.size / (Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2])) || 1);
    x.lineCap = x.lineJoin = 'round';
    x.strokeStyle = '#fff';
    const at = apply(inv, p.x, p.y);
    this.s = { target: pt.target, mask, inv, last: at, path: [{ x: p.x, y: p.y }] };
    this.line(at, at);
  }

  private line(a: Pt, b: Pt) {
    const x = ctx2d(this.s!.mask);
    x.beginPath(); x.moveTo(a.x, a.y); x.lineTo(b.x + 0.01, b.y); x.stroke();
  }

  move(p: PInfo) {
    const s = this.s;
    if (!s) return;
    const at = apply(s.inv, p.x, p.y);
    this.line(s.last, at);
    s.last = at;
    s.path.push({ x: p.x, y: p.y });
    view.requestOverlay();
  }

  up() {
    const s = this.s;
    if (!s) return;
    const doc = app.doc!;
    const data = ctx2d(s.mask, true).getImageData(0, 0, s.mask.width, s.mask.height).data;
    void fillArea(doc, s.target, data, 'Spot Removal').finally(() => { this.s = null; view.requestOverlay(); });
  }

  cancel() { this.s = null; view.requestOverlay(); }

  keydown(e: KeyboardEvent) {
    if (e.key !== '[' && e.key !== ']') return false;
    const o = this.o;
    const step = o.size < 10 ? 1 : o.size < 50 ? 5 : o.size < 200 ? 10 : 25;
    o.size = Math.max(2, Math.min(500, o.size + (e.key === ']' ? step : -step)));
    app.saveOpts();
    view.requestOverlay();
    return true;
  }

  overlay(ctx: CanvasRenderingContext2D) {
    const s = this.s;
    ctx.save();
    if (s && s.path.length) {
      // What's being painted over, in a see-through red until it's filled.
      ctx.strokeStyle = 'rgba(230,57,70,.45)';
      ctx.lineWidth = this.o.size * view.zoom;
      ctx.lineCap = ctx.lineJoin = 'round';
      ctx.beginPath();
      s.path.forEach((q, i) => { const sp = view.toScreen(q.x, q.y); if (i) ctx.lineTo(sp.x, sp.y); else ctx.moveTo(sp.x, sp.y); });
      if (s.path.length === 1) { const sp = view.toScreen(s.path[0].x, s.path[0].y); ctx.lineTo(sp.x + 0.01, sp.y); }
      ctx.stroke();
    }
    const hv = view.hover;
    if (hv) {
      const r = Math.max(1, (this.o.size / 2) * view.zoom);
      ctx.lineWidth = 1;
      ctx.strokeStyle = 'rgba(0,0,0,.7)';
      ctx.beginPath(); ctx.arc(hv.sx, hv.sy, r + 0.5, 0, Math.PI * 2); ctx.stroke();
      ctx.strokeStyle = 'rgba(255,255,255,.9)';
      ctx.beginPath(); ctx.arc(hv.sx, hv.sy, r - 0.5, 0, Math.PI * 2); ctx.stroke();
    }
    ctx.restore();
  }
}

export const spotTool = new SpotTool();
