import { selectSimilar } from '../actions';
import { app } from '../app';
import { glops } from '../core/glops';
import { ctx2d, newCanvas } from '../core/layers';
import { opPath } from '../core/selection';
import { combine } from '../core/selops';
import type { SelOp } from '../core/types';
import { view } from '../ui/canvasview';
import { h } from '../ui/dom';
import { checkbox, slider } from '../ui/widgets';
import { clearSnapLines, snapPoint } from '../ui/snap';
import type { PInfo, Tool } from './tool';

type Mode = 'replace' | 'add' | 'sub';

/** Shared behaviour for marquee + lasso: Shift adds, Alt subtracts, a plain click deselects. */
abstract class SelectTool implements Tool {
  abstract id: string; abstract name: string; abstract key: string; abstract icon: Tool['icon'];
  hint = 'Drag to select · Shift adds · Alt subtracts · click to deselect · Ctrl+D deselect';
  protected mode: Mode = 'replace';
  protected op: SelOp | null = null;
  protected start = { x: 0, y: 0 };
  protected moved = false;

  cursor() { return 'crosshair'; }

  options(bar: HTMLElement) {
    const o = app.opts.select;
    bar.append(
      checkbox('Anti-alias', o.antiAlias, (v) => { o.antiAlias = v; app.saveOpts(); }, 'Turn off for hard-edged selections that take whole pixels only (pixel art)'),
      h('span', { class: 'opt-note' }, 'Shift: add to selection · Alt: subtract · Select menu: All / Invert / Deselect'),
    );
  }

  down(p: PInfo) {
    this.mode = p.shift ? 'add' : p.alt ? 'sub' : 'replace';
    this.start = { x: p.x, y: p.y };
    this.moved = false;
    this.op = null;
  }

  up() {
    const doc = app.doc!;
    const op = this.op;
    this.op = null;
    if (!this.moved || !op) {
      if (this.mode === 'replace' && doc.selection) { doc.setSelection(null); doc.commit('Deselect'); }
      return;
    }
    const base = this.mode === 'replace' ? [] : doc.selection?.ops ?? [];
    if (this.mode === 'sub' && !base.length) return;
    if (!app.opts.select.antiAlias && op.shape !== 'rect') {
      // Curved edges with whole pixels only: rasterize the shape and snap its edge pixels on or off.
      const c = newCanvas(doc.width, doc.height);
      const x = ctx2d(c);
      x.fillStyle = '#fff';
      x.fill(opPath(op));
      const hard = glops.hardEdge(c);
      if (hard) { x.globalCompositeOperation = 'copy'; x.drawImage(hard, 0, 0); }
      doc.setSelection(combine(doc, c, this.mode));
    } else doc.setSelection({ ops: [...base, op] });
    doc.commit(this.mode === 'replace' ? 'Select' : this.mode === 'add' ? 'Add to selection' : 'Subtract from selection');
  }

  overlay(ctx: CanvasRenderingContext2D) {
    if (!this.op) return;
    const d = app.doc!;
    ctx.save();
    ctx.setTransform(devicePixelRatio * d.zoom, 0, 0, devicePixelRatio * d.zoom, devicePixelRatio * d.panX, devicePixelRatio * d.panY);
    ctx.lineWidth = 1 / d.zoom;
    const path = opPath(this.op);
    ctx.strokeStyle = '#000';
    ctx.stroke(path);
    ctx.setLineDash([4 / d.zoom, 4 / d.zoom]);
    ctx.strokeStyle = '#fff';
    ctx.stroke(path);
    ctx.restore();
  }
}

class MarqueeTool extends SelectTool {
  constructor(public id: string, public name: string, public key: string, public icon: Tool['icon'], private shape: 'rect' | 'ellipse') { super(); }

  down(p: PInfo) {
    super.down(p);
    this.start = snapPoint(p.x, p.y);
  }

  up() {
    clearSnapLines();
    super.up();
  }

  move(p: PInfo) {
    const sp = snapPoint(p.x, p.y);
    let w = sp.x - this.start.x, h = sp.y - this.start.y;
    if (Math.abs(w) < 1 && Math.abs(h) < 1 && !this.moved) return;
    this.moved = true;
    // Shift during a fresh selection keeps it square/circular; Alt draws from the centre.
    if (p.shift && this.mode === 'replace') { const s = Math.max(Math.abs(w), Math.abs(h)); w = Math.sign(w || 1) * s; h = Math.sign(h || 1) * s; }
    let x = this.start.x, y = this.start.y;
    if (p.alt && this.mode === 'replace') { x -= w; y -= h; w *= 2; h *= 2; }
    const x0 = Math.round(Math.min(x, x + w)), y0 = Math.round(Math.min(y, y + h));
    const x1 = Math.round(Math.max(x, x + w)), y1 = Math.round(Math.max(y, y + h));
    this.op = { mode: this.mode === 'sub' ? 'sub' : 'add', shape: this.shape, pts: [x0, y0, x1 - x0, y1 - y0] };
    view.requestOverlay();
  }
}

class LassoTool extends SelectTool {
  id = 'lasso'; name = 'Lasso'; key = 'L'; icon = 'lasso' as const;
  hint = 'Drag around an area to select it freehand · Shift adds · Alt subtracts';
  private pts: number[] = [];

  down(p: PInfo) {
    super.down(p);
    this.pts = [p.x, p.y];
  }

  move(p: PInfo) {
    const n = this.pts.length;
    if (Math.hypot(p.x - this.pts[n - 2], p.y - this.pts[n - 1]) * app.doc!.zoom < 2) return;
    this.pts.push(p.x, p.y);
    this.moved = this.pts.length >= 6;
    this.op = { mode: this.mode === 'sub' ? 'sub' : 'add', shape: 'poly', pts: [...this.pts] };
    view.requestOverlay();
  }
}

/** Magic Wand: click to select similar colours. Shift adds, Alt subtracts. */
class WandTool implements Tool {
  id = 'wand'; name = 'Magic Wand'; key = 'W'; icon = 'wand' as const;
  hint = 'Click to select similar colour · Shift adds · Alt subtracts · higher Tolerance takes in more';

  cursor() { return 'crosshair'; }

  options(bar: HTMLElement) {
    const o = app.opts.wand;
    bar.append(
      slider({ label: 'Tolerance', min: 0, max: 255, value: o.tolerance, compact: true, onInput: (v) => { o.tolerance = v; }, onChange: () => app.saveOpts() }),
      checkbox('Contiguous', o.contiguous, (v) => { o.contiguous = v; app.saveOpts(); }, 'Only connected areas; turn off to take matching colour from the whole image'),
      checkbox('Sample all layers', o.sampleAll, (v) => { o.sampleAll = v; app.saveOpts(); }, 'Look at everything you see instead of just the active layer'),
      checkbox('Anti-alias', o.antiAlias, (v) => { o.antiAlias = v; app.saveOpts(); }, 'Soften the selection edge slightly'),
    );
  }

  down(p: PInfo) {
    const doc = app.doc!;
    if (p.x < 0 || p.y < 0 || p.x >= doc.width || p.y >= doc.height) return;
    selectSimilar(Math.floor(p.x), Math.floor(p.y), p.shift ? 'add' : p.alt ? 'sub' : 'replace');
  }
}

export const wandTool = new WandTool();
export const rectSelectTool =new MarqueeTool('marquee', 'Rectangle Select', 'M', 'marquee', 'rect');
export const ellipseSelectTool = new MarqueeTool('ellipse', 'Ellipse Select', 'M', 'ellipse', 'ellipse');
export const lassoTool = new LassoTool();
