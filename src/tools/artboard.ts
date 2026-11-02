import { app } from '../app';
import { artboardToTab, deleteArtboard, duplicateArtboard, newArtboard, renameArtboard, resizeArtboard } from '../actions';
import type { Pt, Rect } from '../core/math';
import type { Board, Layout } from '../core/project';
import { view } from '../ui/canvasview';
import { h } from '../ui/dom';
import type { PInfo, Tool } from './tool';

type Edge = `${'n' | 's' | ''}${'w' | 'e' | ''}`;
type Drag =
  | { kind: 'move'; b: Board; x0: number; y0: number; s0: Pt; before: Layout; toTab: boolean; at: Pt }
  | { kind: 'resize'; edge: Edge; r0: Rect; s0: Pt; r: Rect }
  | { kind: 'new'; s0: Pt; r: Rect };

/** How close (CSS px) an artboard's edge snaps to another's while moving it. */
const SNAP = 6;

/**
 * Artboard tool: moves artboards (by their name or anywhere on them), resizes the one worked on by its edges, and
 * draws new ones on the empty space around them. Moving and resizing leave the artboards' pictures where they are on
 * the spread; each is one undo step.
 */
class ArtboardTool implements Tool {
  id = 'artboard'; name = 'Artboard'; key = 'V'; icon = 'artboard' as const;
  hint = 'Drag an artboard or its name to move it (up to the tabs: its own tab) · drag its edges to resize · drag on empty space for a new one · Shift keeps it in line';
  private drag: Drag | null = null;
  private nameField: HTMLInputElement | null = null;
  private sizeLabel: HTMLElement | null = null;

  /** A screen point (CSS px) in the artboards' shared space. */
  private spread(p: PInfo): Pt {
    const o = app.project!.origin;
    return { x: (p.sx - o.x) / o.zoom, y: (p.sy - o.y) / o.zoom };
  }

  private activeBoard(): Board | null { return app.doc && app.project ? app.project.boardOf(app.doc) : null; }

  /** The edge or corner of the artboard worked on under a point, if any. */
  private edgeAt(p: PInfo): Edge | '' {
    const b = this.activeBoard();
    if (!b) return '';
    const r = view.boardRect(b), tol = 6;
    const inX = p.sx > r.x - tol && p.sx < r.x + r.w + tol, inY = p.sy > r.y - tol && p.sy < r.y + r.h + tol;
    const v = Math.abs(p.sy - r.y) < tol && inX ? 'n' : Math.abs(p.sy - (r.y + r.h)) < tol && inX ? 's' : '';
    const hh = Math.abs(p.sx - r.x) < tol && inY ? 'w' : Math.abs(p.sx - (r.x + r.w)) < tol && inY ? 'e' : '';
    return (v + hh) as Edge;
  }

  /** Whether a point is on an artboard (with one artboard, on the image). */
  private onBoard(p: PInfo): Board | null {
    const hit = view.boardAt(p.sx, p.sy);
    if (hit) return hit.b;
    const b = this.activeBoard();
    if (!b) return null;
    const r = view.boardRect(b);
    return p.sx >= r.x && p.sx <= r.x + r.w && p.sy >= r.y && p.sy <= r.y + r.h ? b : null;
  }

  cursor(p: PInfo | null) {
    if (!p) return 'default';
    const d = this.drag;
    const edge = d?.kind === 'resize' ? d.edge : d ? '' : this.edgeAt(p);
    if (edge) return ({ n: 'ns-resize', s: 'ns-resize', w: 'ew-resize', e: 'ew-resize', nw: 'nwse-resize', se: 'nwse-resize', ne: 'nesw-resize', sw: 'nesw-resize' } as Record<string, string>)[edge];
    if (d?.kind === 'move' || (!d && (app.project?.boards.length ?? 0) > 1 && this.onBoard(p))) return 'move';
    return d?.kind === 'new' || !this.onBoard(p) ? 'crosshair' : 'default';
  }

  down(p: PInfo) {
    const proj = app.project, b0 = this.activeBoard();
    if (!proj || !b0) return;
    const s = this.spread(p);
    const edge = this.edgeAt(p);
    if (edge) {
      const r0 = { x: b0.x, y: b0.y, w: b0.doc.width, h: b0.doc.height };
      this.drag = { kind: 'resize', edge, r0, s0: s, r: { ...r0 } };
      return;
    }
    const b = this.onBoard(p);
    if (b) {
      // (A file with one artboard has nothing to move it relative to.)
      if (proj.boards.length < 2) return;
      if (b.doc !== app.doc) app.setDoc(b.doc);
      this.drag = { kind: 'move', b, x0: b.x, y0: b.y, s0: s, before: proj.layout(), toTab: false, at: { x: p.sx, y: p.sy } };
      return;
    }
    this.drag = { kind: 'new', s0: s, r: { x: s.x, y: s.y, w: 0, h: 0 } };
  }

  move(p: PInfo) {
    const d = this.drag, proj = app.project;
    if (!d || !proj) return;
    const s = this.spread(p);
    let dx = s.x - d.s0.x, dy = s.y - d.s0.y;
    if (d.kind === 'move') {
      // Over the tabs: let go there and the artboard opens in a tab of its own (it waits where it was meanwhile).
      const c = view.clientRect();
      d.toTab = proj.boards.length > 1 && !!document.elementFromPoint(c.left + p.sx, c.top + p.sy)?.closest('.tabs');
      d.at = { x: p.sx, y: p.sy };
      if (d.toTab) { proj.place(d.b, d.x0, d.y0); view.requestRender(); view.requestOverlay(); return; }
      if (p.shift) { if (Math.abs(dx) > Math.abs(dy)) dy = 0; else dx = 0; }
      const at = this.snap(d.b, Math.round(d.x0 + dx), Math.round(d.y0 + dy), proj.origin.zoom, p.ctrl);
      proj.place(d.b, at.x, at.y);
      view.requestRender();
    } else if (d.kind === 'resize') {
      let { x, y, w, h: hh } = d.r0;
      if (d.edge.includes('w')) { x += dx; w -= dx; }
      if (d.edge.includes('e')) w += dx;
      if (d.edge.includes('n')) { y += dy; hh -= dy; }
      if (d.edge.includes('s')) hh += dy;
      if (w < 1) { if (d.edge.includes('w')) x = d.r0.x + d.r0.w - 1; w = 1; }
      if (hh < 1) { if (d.edge.includes('n')) y = d.r0.y + d.r0.h - 1; hh = 1; }
      d.r = { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(hh) };
    } else {
      if (p.shift) { const m = Math.max(Math.abs(dx), Math.abs(dy)); dx = Math.sign(dx || 1) * m; dy = Math.sign(dy || 1) * m; }
      const x = Math.round(Math.min(d.s0.x, d.s0.x + dx)), y = Math.round(Math.min(d.s0.y, d.s0.y + dy));
      d.r = { x, y, w: Math.round(Math.abs(dx)), h: Math.round(Math.abs(dy)) };
    }
    this.syncOptions();
    view.requestOverlay();
  }

  /** A moved artboard's place, its edges snapped to the other artboards' edges when close (not with Ctrl). */
  private snap(b: Board, x: number, y: number, zoom: number, off: boolean): Pt {
    if (off) return { x, y };
    const tol = SNAP / zoom, w = b.doc.width, hh = b.doc.height;
    let bx = x, by = y, best = { x: tol, y: tol };
    for (const o of app.project!.boards) {
      if (o === b) continue;
      for (const [mine, theirs] of [[0, 0], [0, o.doc.width], [w, 0], [w, o.doc.width]]) {
        const dd = Math.abs(x + mine - (o.x + theirs));
        if (dd < best.x) { best.x = dd; bx = o.x + theirs - mine; }
      }
      for (const [mine, theirs] of [[0, 0], [0, o.doc.height], [hh, 0], [hh, o.doc.height]]) {
        const dd = Math.abs(y + mine - (o.y + theirs));
        if (dd < best.y) { best.y = dd; by = o.y + theirs - mine; }
      }
    }
    return { x: bx, y: by };
  }

  up(p: PInfo) {
    const d = this.drag, proj = app.project;
    this.drag = null;
    if (!d || !proj) return;
    if (d.kind === 'move') {
      if (d.toTab) artboardToTab(d.b.doc, p.alt);
      else if (d.b.x !== d.x0 || d.b.y !== d.y0) proj.commitLayout('Move artboard', d.before, d.b.doc);
    } else if (d.kind === 'resize') resizeArtboard(d.r);
    // (A press without much of a drag isn't a new artboard.)
    else if (d.r.w * proj.origin.zoom >= 4 && d.r.h * proj.origin.zoom >= 4) newArtboard(d.r.w, d.r.h, '#ffffff', d.r);
    this.syncOptions();
    view.requestRender();
  }

  /** Escape mid-drag: a moved artboard goes back; a resize or a new one is dropped. */
  cancel() {
    const d = this.drag;
    this.drag = null;
    if (d?.kind === 'move') app.project?.place(d.b, d.x0, d.y0);
    this.syncOptions();
    view.requestRender();
  }

  overlay(ctx: CanvasRenderingContext2D) {
    const b = this.activeBoard(), proj = app.project;
    if (!b || !proj) return;
    const d = this.drag, o = proj.origin;
    const toScreen = (r: Rect): Rect => ({ x: o.x + r.x * o.zoom, y: o.y + r.y * o.zoom, w: r.w * o.zoom, h: r.h * o.zoom });
    ctx.save();
    if (d?.kind === 'move' && d.toTab) {
      ctx.font = '12px "Segoe UI", sans-serif';
      const text = `Let go to open ${d.b.doc.name} in its own tab (Alt: a copy)`;
      const tw = ctx.measureText(text).width;
      ctx.fillStyle = 'rgba(0,0,0,.75)';
      ctx.fillRect(d.at.x + 14, Math.max(4, d.at.y + 8), tw + 12, 20);
      ctx.fillStyle = '#fff';
      ctx.fillText(text, d.at.x + 20, Math.max(4, d.at.y + 8) + 14);
    } else if (d && d.kind !== 'move') {
      const r = toScreen(d.r);
      ctx.setLineDash([5, 4]);
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 1;
      ctx.strokeRect(Math.round(r.x) + 0.5, Math.round(r.y) + 0.5, Math.round(r.w), Math.round(r.h));
      ctx.setLineDash([]);
      ctx.font = '12px "Segoe UI", sans-serif';
      const text = `${d.r.w} × ${d.r.h}`;
      const tw = ctx.measureText(text).width;
      ctx.fillStyle = 'rgba(0,0,0,.7)';
      ctx.fillRect(r.x + r.w / 2 - tw / 2 - 5, r.y + r.h + 6, tw + 10, 18);
      ctx.fillStyle = '#fff';
      ctx.fillText(text, r.x + r.w / 2 - tw / 2, r.y + r.h + 19);
    } else {
      // Handles on the artboard worked on: its corners and the middle of each side.
      const r = view.boardRect(b);
      ctx.fillStyle = '#fff';
      ctx.strokeStyle = 'rgba(0,0,0,.6)';
      for (const fx of [0, 0.5, 1]) for (const fy of [0, 0.5, 1]) {
        if (fx === 0.5 && fy === 0.5) continue;
        const x = Math.round(r.x + r.w * fx) - 3.5, y = Math.round(r.y + r.h * fy) - 3.5;
        ctx.fillRect(x, y, 7, 7);
        ctx.strokeRect(x, y, 7, 7);
      }
    }
    ctx.restore();
  }

  options(bar: HTMLElement) {
    const name = h('input', { type: 'text', class: 'opt-text', spellcheck: false, title: 'The artboard\'s name (also shown above it)' }) as HTMLInputElement;
    const commit = () => { const d = app.doc; if (d) renameArtboard(d, name.value); this.syncOptions(); };
    name.addEventListener('change', commit);
    name.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') name.blur(); if (e.key === 'Escape') { this.syncOptions(); name.blur(); } });
    this.nameField = name;
    this.sizeLabel = h('span', { class: 'opt-value' });
    const btn = (label: string, title: string, fn: () => void) => h('button', { class: 'btn small', type: 'button', title, onclick: fn }, label);
    bar.append(
      h('label', { class: 'opt' }, h('span', { class: 'opt-label' }, 'Name'), name),
      this.sizeLabel,
      btn('New', 'A new artboard the same size, to the right of the others', () => { const d = app.doc; if (d) newArtboard(d.width, d.height); }),
      btn('Duplicate', 'A copy of this artboard, with its layers', duplicateArtboard),
      btn('Delete', 'Remove this artboard (Undo brings it back)', deleteArtboard),
    );
    this.syncOptions();
  }

  /** Brings the name and size shown up to date (unless the name is being typed). */
  syncOptions() {
    const d = app.doc, dr = this.drag;
    if (this.nameField && document.activeElement !== this.nameField) { this.nameField.value = d?.name ?? ''; this.nameField.disabled = !d; }
    if (this.sizeLabel) this.sizeLabel.textContent = dr && dr.kind !== 'move' ? `${dr.r.w} × ${dr.r.h} px` : d ? `${d.width} × ${d.height} px` : '';
  }
}

export const artboardTool = new ArtboardTool();
app.on('docs', () => artboardTool.syncOptions());
app.on('change', ({ doc }) => { if (doc === app.doc) artboardTool.syncOptions(); });
