import { app } from '../app';
import { Stroke } from '../core/brush';
import { view } from '../ui/canvasview';
import { checkbox, seg, slider } from '../ui/widgets';
import { paintableTarget } from './paint';
import { drawSymmetryGuides, symmetryControl, symmetryCopies, symmetryDown, symmetryMove, symmetryUp } from './symmetry';
import type { PInfo, Tool } from './tool';

type Kind = 'dodge' | 'burn' | 'blur' | 'sharpen' | 'smudge';

const HINTS: Record<Kind, string> = {
  dodge: 'Paint to lighten · choose shadows, midtones or highlights · Alt switches to Burn',
  burn: 'Paint to darken · choose shadows, midtones or highlights · Alt switches to Dodge',
  blur: 'Paint to soften detail · Alt switches to Sharpen',
  sharpen: 'Paint to crisp up detail (go gently) · Alt switches to Blur',
  smudge: 'Drag to push colour along, like a finger in wet paint',
};
const LABELS: Record<Kind, string> = { dodge: 'Dodge', burn: 'Burn', blur: 'Blur', sharpen: 'Sharpen', smudge: 'Smudge' };
/** Alt flips to the opposite tool for the stroke, like Photoshop. */
const OPPOSITE: Partial<Record<Kind, Kind>> = { dodge: 'burn', burn: 'dodge', blur: 'sharpen', sharpen: 'blur' };

/** Dodge/Burn (O), Blur/Sharpen/Smudge (R): brushes that change the pixels already there. */
class RetouchTool implements Tool {
  ownCursor = true;
  hint: string;
  private stroke: Stroke | null = null;
  private label = '';

  constructor(public id: Kind, public name: string, public key: string, public icon: Tool['icon']) {
    this.hint = HINTS[id];
  }

  private get o() { return app.opts[this.id]; }

  options(bar: HTMLElement) {
    const o = this.o;
    bar.append(
      slider({ label: 'Size', min: 1, max: 1000, value: o.size, unit: 'px', compact: true, onInput: (v) => { o.size = v; view.requestOverlay(); }, onChange: () => app.saveOpts() }),
      slider({ label: 'Hardness', min: 0, max: 1, display: 100, value: o.hardness, unit: '%', compact: true, onInput: (v) => { o.hardness = v; }, onChange: () => app.saveOpts() }),
      slider({ label: this.id === 'dodge' || this.id === 'burn' ? 'Exposure' : 'Strength', min: 0.01, max: 1, display: 100, value: o.strength, unit: '%', compact: true, onInput: (v) => { o.strength = v; }, onChange: () => app.saveOpts() }),
    );
    if (this.id === 'dodge' || this.id === 'burn') {
      bar.append(seg([{ v: '0', label: 'Shadows' }, { v: '1', label: 'Midtones' }, { v: '2', label: 'Highlights' }], String(o.range), (v) => { o.range = Number(v); app.saveOpts(); }));
    }
    bar.append(checkbox('Pen pressure', o.pressure, (v) => { o.pressure = v; app.saveOpts(); }, 'Pressure controls size when using a drawing tablet'));
    // Smudge carries paint along the stroke, which a mirrored copy can't share, so it has no symmetry.
    if (this.id !== 'smudge') bar.append(symmetryControl());
  }

  down(p: PInfo) {
    if (this.id !== 'smudge' && symmetryDown(p)) return;
    const doc = app.doc!;
    const pt = paintableTarget(doc);
    if (!pt) return;
    const kind = p.alt && OPPOSITE[this.id] ? OPPOSITE[this.id]! : this.id;
    const o = app.opts[kind];
    this.label = LABELS[kind];
    this.stroke = new Stroke(doc, pt.target, {
      color: '#ffffff', size: o.size, hardness: o.hardness, opacity: 1, flow: 1, erase: false, pressure: o.pressure,
      spacing: kind === 'smudge' ? 0.08 : 0.12, retouch: { mode: kind, strength: o.strength, range: o.range },
      copies: kind === 'smudge' ? undefined : symmetryCopies(doc),
    });
    this.stroke.add({ x: p.x, y: p.y, pressure: p.pressure });
  }

  move(p: PInfo) {
    if (symmetryMove(p)) return;
    this.stroke?.add({ x: p.x, y: p.y, pressure: p.pressure });
  }

  up() {
    if (symmetryUp()) return;
    if (!this.stroke) return;
    this.stroke.end(this.label);
    this.stroke = null;
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

  overlay(ctx: CanvasRenderingContext2D) {
    if (this.id !== 'smudge') drawSymmetryGuides(ctx);
    const hv = view.hover;
    if (!hv) return;
    const r = Math.max(1, (this.o.size / 2) * view.zoom);
    ctx.save();
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(0,0,0,.7)';
    ctx.beginPath(); ctx.arc(hv.sx, hv.sy, r + 0.5, 0, Math.PI * 2); ctx.stroke();
    ctx.strokeStyle = 'rgba(255,255,255,.9)';
    ctx.beginPath(); ctx.arc(hv.sx, hv.sy, r - 0.5, 0, Math.PI * 2); ctx.stroke();
    ctx.restore();
  }
}

export const dodgeTool = new RetouchTool('dodge', 'Dodge', 'O', 'dodge');
export const burnTool = new RetouchTool('burn', 'Burn', 'O', 'burn');
export const blurTool = new RetouchTool('blur', 'Blur', 'R', 'blurTool');
export const sharpenTool = new RetouchTool('sharpen', 'Sharpen', 'R', 'sharpen');
export const smudgeTool = new RetouchTool('smudge', 'Smudge', 'R', 'smudge');
