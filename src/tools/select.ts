import { app } from '../app';
import { opPath } from '../core/selection';
import type { SelOp } from '../core/types';
import { view } from '../ui/canvasview';
import { h } from '../ui/dom';
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
    bar.append(h('span', { class: 'opt-note' }, 'Shift: add to selection · Alt: subtract · Select menu: All / Invert / Deselect'));
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
    doc.setSelection({ ops: [...base, op] });
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

  move(p: PInfo) {
    let w = p.x - this.start.x, h = p.y - this.start.y;
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

export const rectSelectTool = new MarqueeTool('marquee', 'Rectangle Select', 'M', 'marquee', 'rect');
export const ellipseSelectTool = new MarqueeTool('ellipse', 'Ellipse Select', 'M', 'ellipse', 'ellipse');
export const lassoTool = new LassoTool();
