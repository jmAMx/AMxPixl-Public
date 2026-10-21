import { app } from '../app';
import type { Pt, Rect } from '../core/math';
import { cropTo } from '../actions';
import { view } from '../ui/canvasview';
import { h } from '../ui/dom';
import type { PInfo, Tool } from './tool';

type Part = 'move' | 'new' | `${'n' | 's' | ''}${'w' | 'e' | ''}`;

class CropTool implements Tool {
  id = 'crop'; name = 'Crop'; key = 'C'; icon = 'crop' as const;
  hint = 'Drag the edges or draw a new box · Enter applies · Esc resets · pixels outside are kept, not deleted';
  private rect: Rect | null = null;
  private drag: { part: Part; p0: Pt; r0: Rect } | null = null;
  private ratio: number | null = null;
  private sizeLabel: HTMLElement | null = null;

  activate() { this.reset(); }
  deactivate() { this.rect = null; }

  private reset() {
    const d = app.doc;
    this.rect = d ? { x: 0, y: 0, w: d.width, h: d.height } : null;
    this.updateLabel();
    view.requestOverlay();
  }

  private updateLabel() {
    if (this.sizeLabel) this.sizeLabel.textContent = this.rect ? `${Math.round(this.rect.w)} × ${Math.round(this.rect.h)} px` : '';
  }

  options(bar: HTMLElement) {
    const ratio = h('select', {
      onchange: () => {
        const v = ratio.value;
        this.ratio = v === 'free' ? null : v === 'orig' ? app.doc!.width / app.doc!.height : Number(v.split(':')[0]) / Number(v.split(':')[1]);
        if (this.ratio && this.rect) {
          const r = this.rect;
          const w = Math.min(r.w, r.h * this.ratio);
          this.rect = { x: r.x + (r.w - w) / 2, y: r.y + (r.h - w / this.ratio) / 2, w, h: w / this.ratio };
          this.updateLabel();
          view.requestOverlay();
        }
      },
    }, ...[['free', 'Free ratio'], ['orig', 'Original'], ['1:1', '1 : 1 square'], ['4:5', '4 : 5 portrait'], ['3:2', '3 : 2'], ['4:3', '4 : 3'], ['16:9', '16 : 9'], ['9:16', '9 : 16 story']]
      .map(([v, l]) => h('option', { value: v }, l)));
    this.sizeLabel = h('span', { class: 'opt-value' });
    this.updateLabel();
    bar.append(
      h('label', { class: 'opt' }, h('span', { class: 'opt-label' }, 'Ratio'), ratio),
      this.sizeLabel,
      h('button', { class: 'btn small primary', type: 'button', onclick: () => this.apply() }, 'Apply crop'),
      h('button', { class: 'btn small', type: 'button', onclick: () => this.reset() }, 'Reset'),
    );
  }

  private partAt(p: PInfo): Part {
    const r = this.rect;
    if (!r) return 'new';
    const a = view.toScreen(r.x, r.y), b = view.toScreen(r.x + r.w, r.y + r.h);
    const tol = 8;
    const nearL = Math.abs(p.sx - a.x) < tol, nearR = Math.abs(p.sx - b.x) < tol;
    const nearT = Math.abs(p.sy - a.y) < tol, nearB = Math.abs(p.sy - b.y) < tol;
    const inX = p.sx > a.x - tol && p.sx < b.x + tol, inY = p.sy > a.y - tol && p.sy < b.y + tol;
    const v = nearT && inX ? 'n' : nearB && inX ? 's' : '';
    const hh = nearL && inY ? 'w' : nearR && inY ? 'e' : '';
    if (v || hh) return (v + hh) as Part;
    if (p.sx > a.x && p.sx < b.x && p.sy > a.y && p.sy < b.y) return 'move';
    return 'new';
  }

  cursor(p: PInfo | null) {
    if (!p) return 'crosshair';
    const part = this.drag?.part ?? this.partAt(p);
    if (part === 'move') return 'move';
    if (part === 'new') return 'crosshair';
    return ({ n: 'ns-resize', s: 'ns-resize', w: 'ew-resize', e: 'ew-resize', nw: 'nwse-resize', se: 'nwse-resize', ne: 'nesw-resize', sw: 'nesw-resize' } as Record<string, string>)[part];
  }

  down(p: PInfo) {
    const part = this.partAt(p);
    const r0 = part === 'new' ? { x: p.x, y: p.y, w: 0, h: 0 } : { ...this.rect! };
    this.drag = { part, p0: { x: p.x, y: p.y }, r0 };
  }

  move(p: PInfo) {
    const d = this.drag;
    if (!d) return;
    const dx = p.x - d.p0.x, dy = p.y - d.p0.y;
    let { x, y, w, h: hh } = d.r0;
    if (d.part === 'move') { x += dx; y += dy; }
    else if (d.part === 'new') {
      w = dx; hh = dy;
      if (this.ratio) hh = Math.sign(dy || 1) * Math.abs(w) / this.ratio;
      if (w < 0) { x += w; w = -w; }
      if (hh < 0) { y += hh; hh = -hh; }
    } else {
      if (d.part.includes('w')) { x += dx; w -= dx; }
      if (d.part.includes('e')) w += dx;
      if (d.part.includes('n')) { y += dy; hh -= dy; }
      if (d.part.includes('s')) hh += dy;
      if (this.ratio) {
        if (d.part === 'n' || d.part === 's') w = hh * this.ratio; else hh = w / this.ratio;
        if (d.part.includes('n') && d.part !== 'n') y = d.r0.y + d.r0.h - hh;
      }
      if (w < 0) { x += w; w = -w; }
      if (hh < 0) { y += hh; hh = -hh; }
    }
    this.rect = { x, y, w, h: hh };
    this.updateLabel();
    view.requestOverlay();
  }

  up() {
    this.drag = null;
    if (this.rect && (this.rect.w < 1 || this.rect.h < 1)) this.reset();
  }

  keydown(e: KeyboardEvent) {
    if (e.key === 'Enter') { this.apply(); return true; }
    if (e.key === 'Escape') { this.reset(); return true; }
    return false;
  }

  private apply() {
    const r = this.rect;
    if (!r || !app.doc) return;
    const x = Math.round(r.x), y = Math.round(r.y);
    const rr = { x, y, w: Math.max(1, Math.round(r.x + r.w) - x), h: Math.max(1, Math.round(r.y + r.h) - y) };
    if (rr.x === 0 && rr.y === 0 && rr.w === app.doc.width && rr.h === app.doc.height) return;
    cropTo(rr);
    this.reset();
    view.fit();
  }

  overlay(ctx: CanvasRenderingContext2D) {
    const r = this.rect;
    if (!r) return;
    const a = view.toScreen(r.x, r.y), b = view.toScreen(r.x + r.w, r.y + r.h);
    const { w, h: hh } = view.size;
    ctx.save();
    ctx.fillStyle = 'rgba(0,0,0,.55)';
    ctx.beginPath();
    ctx.rect(0, 0, w, hh);
    ctx.rect(a.x, a.y, b.x - a.x, b.y - a.y);
    ctx.fill('evenodd');
    ctx.strokeStyle = 'rgba(255,255,255,.35)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 1; i < 3; i++) {
      const x = a.x + ((b.x - a.x) * i) / 3, y = a.y + ((b.y - a.y) * i) / 3;
      ctx.moveTo(x, a.y); ctx.lineTo(x, b.y);
      ctx.moveTo(a.x, y); ctx.lineTo(b.x, y);
    }
    ctx.stroke();
    ctx.strokeStyle = '#fff';
    ctx.strokeRect(a.x + 0.5, a.y + 0.5, b.x - a.x - 1, b.y - a.y - 1);
    ctx.lineWidth = 3;
    const L = 14;
    for (const [cx, cy, sx, sy] of [[a.x, a.y, 1, 1], [b.x, a.y, -1, 1], [b.x, b.y, -1, -1], [a.x, b.y, 1, -1]]) {
      ctx.beginPath();
      ctx.moveTo(cx, cy + sy * L); ctx.lineTo(cx, cy); ctx.lineTo(cx + sx * L, cy);
      ctx.stroke();
    }
    ctx.restore();
  }
}

export const cropTool = new CropTool();
