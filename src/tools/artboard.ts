import { app } from '../app';
import { artboardToTab, deleteArtboard, duplicateArtboard, newArtboard, pickArtboard, renameArtboard, resizeArtboard, resizeArtboards } from '../actions';
import type { Doc } from '../core/document';
import { MAX_SIDE, pickSize } from '../core/sizes';
import { sizePicker } from '../ui/dialogs';
import type { Pt, Rect } from '../core/math';
import type { Board, Layout } from '../core/project';
import { view } from '../ui/canvasview';
import { h } from '../ui/dom';
import { icon, numField } from '../ui/widgets';
import type { PInfo, Tool } from './tool';

type Edge = `${'n' | 's' | ''}${'w' | 'e' | ''}`;
type Drag =
  | { kind: 'move'; b: Board; x0: number; y0: number; s0: Pt; before: Layout; toTab: boolean; at: Pt; all: { b: Board; x0: number; y0: number }[] }
  | { kind: 'resize'; edge: Edge; r0: Rect; s0: Pt; r: Rect }
  | { kind: 'new'; s0: Pt; r: Rect };

/** How close (CSS px) an artboard's edge snaps to another's while moving it. */
const SNAP = 6;

/**
 * While an artboard is dragged, the tab bar shows where it can go to get a tab of its own: a dashed spot after the tabs
 * ('near'), lit up with the pointer over the bar ('over'). 'off' takes it away.
 */
function tabDropSpot(state: 'off' | 'near' | 'over', name = '', copy = false) {
  const bar = document.querySelector<HTMLElement>('.tabs');
  if (!bar) return;
  bar.classList.toggle('board-drag', state !== 'off');
  bar.classList.toggle('board-drop', state === 'over');
  let spot = bar.querySelector<HTMLElement>('.tab-drop-spot');
  if (state === 'off') { spot?.remove(); return; }
  if (!spot) {
    spot = h('div', { class: 'tab-drop-spot' });
    bar.insertBefore(spot, bar.querySelector('.tab-new'));
  }
  const text = state === 'over' ? `Let go: ${name} ${copy ? '(a copy) ' : ''}in its own tab` : `Drag up here: ${name} in its own tab`;
  if (spot.textContent !== text) spot.replaceChildren(icon('artboard'), h('span', null, text));
  spot.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

/**
 * Artboard tool: moves artboards (by their name or anywhere on them), resizes the one worked on by its edges, and
 * draws new ones on the empty space around them. Moving and resizing leave the artboards' pictures where they are on
 * the spread; each is one undo step.
 */
class ArtboardTool implements Tool {
  id = 'artboard'; name = 'Artboard'; key = 'V'; icon = 'artboard' as const;
  hint = 'Drag an artboard or its name to move it (up to the tabs: its own tab) · Shift/Ctrl+click picks several · drag its edges to resize · drag on empty space for a new one';
  private drag: Drag | null = null;
  private nameField: HTMLInputElement | null = null;

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
      // Shift or Ctrl+click adds it to the selection or takes it out; a press on one of several selected drags them all.
      pickArtboard(b.doc, p.shift || p.ctrl ? 'toggle' : 'keep');
      if (!proj.selection().includes(b.doc)) return;
      const all = proj.selection().map((d) => proj.boardOf(d)!).map((x) => ({ b: x, x0: x.x, y0: x.y }));
      this.drag = { kind: 'move', b, x0: b.x, y0: b.y, s0: s, before: proj.layout(), toTab: false, at: { x: p.sx, y: p.sy }, all };
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
      // (One artboard at a time: several selected just move.)
      const one = d.all.length === 1 && proj.boards.length > 1;
      const c = view.clientRect();
      d.toTab = one && !!document.elementFromPoint(c.left + p.sx, c.top + p.sy)?.closest('.tabs');
      d.at = { x: p.sx, y: p.sy };
      if (one) tabDropSpot(d.toTab ? 'over' : 'near', d.b.doc.name, p.alt);
      if (d.toTab) { proj.place(d.b, d.x0, d.y0); view.requestRender(); view.requestOverlay(); return; }
      if (p.shift) { if (Math.abs(dx) > Math.abs(dy)) dy = 0; else dx = 0; }
      // The one grabbed snaps to the others' edges; the rest of the selection moves with it.
      const at = this.snap(d.b, Math.round(d.x0 + dx), Math.round(d.y0 + dy), proj.origin.zoom, p.ctrl, d.all.map((x) => x.b));
      for (const x of d.all) proj.place(x.b, x.x0 + at.x - d.x0, x.y0 + at.y - d.y0);
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
  private snap(b: Board, x: number, y: number, zoom: number, off: boolean, moving: Board[] = [b]): Pt {
    if (off) return { x, y };
    const tol = SNAP / zoom, w = b.doc.width, hh = b.doc.height;
    let bx = x, by = y, best = { x: tol, y: tol };
    for (const o of app.project!.boards) {
      if (moving.includes(o)) continue;
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
    tabDropSpot('off');
    if (!d || !proj) return;
    if (d.kind === 'move') {
      if (d.toTab) artboardToTab(d.b.doc, p.alt);
      else if (d.b.x !== d.x0 || d.b.y !== d.y0) proj.commitLayout(d.all.length > 1 ? 'Move artboards' : 'Move artboard', d.before, d.b.doc);
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
    tabDropSpot('off');
    if (d?.kind === 'move') for (const x of d.all) app.project?.place(x.b, x.x0, x.y0);
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

  /** The selected artboards (just the one worked on, or several picked with Shift/Ctrl+click). */
  private selected(): Doc[] { return app.project?.selection() ?? []; }

  options(bar: HTMLElement) {
    const name = h('input', { type: 'text', class: 'opt-text', spellcheck: false, title: 'The artboard\'s name (also shown above it)' }) as HTMLInputElement;
    const commit = () => { const d = app.doc; if (d) renameArtboard(d, name.value); this.syncOptions(); };
    name.addEventListener('change', commit);
    name.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') name.blur(); if (e.key === 'Escape') { this.syncOptions(); name.blur(); } });
    this.nameField = name;
    // Size: typed, picked from the sizes and ratios, or turned (W and H swapped), for every selected artboard; each keeps
    // its top-left corner, and a ratio keeps each one's width.
    const sizeAll = (f: (d: Doc) => { w: number; h: number }) => { resizeArtboards(this.selected(), f); this.syncOptions(); };
    this.wField = numField('W', 1, (v) => sizeAll((d) => ({ w: v, h: d.height })), { unit: 'px', min: 1, max: MAX_SIDE });
    this.hField = numField('H', 1, (v) => sizeAll((d) => ({ w: d.width, h: v })), { unit: 'px', min: 1, max: MAX_SIDE });
    const pick = sizePicker((v) => { sizeAll((d) => pickSize(v, d.width, d.height)); pick.custom(); });
    const swap = h('button', { class: 'btn small', type: 'button', title: 'Turn it: swap width and height', onclick: () => sizeAll((d) => ({ w: d.height, h: d.width })) }, '⇄');
    this.countLabel = h('span', { class: 'opt-value' });
    const btn = (label: string, title: string, fn: () => void) => h('button', { class: 'btn small', type: 'button', title, onclick: fn }, label);
    bar.append(
      h('label', { class: 'opt' }, h('span', { class: 'opt-label' }, 'Name'), name),
      this.countLabel,
      h('div', { class: 'opt board-size' }, pick, this.wField, this.hField, swap),
      btn('New', 'A new artboard the same size, to the right of the others', () => { const d = app.doc; if (d) newArtboard(d.width, d.height); }),
      btn('Duplicate', 'Copies of the selected artboards, with their layers', duplicateArtboard),
      btn('Delete', 'Remove the selected artboards (Undo brings them back)', deleteArtboard),
    );
    this.syncOptions();
  }

  private wField: ReturnType<typeof numField> | null = null;
  private hField: ReturnType<typeof numField> | null = null;
  private countLabel: HTMLElement | null = null;

  /** Brings the name and size shown up to date (unless being typed); while resizing or drawing, the size being made. */
  syncOptions() {
    const d = app.doc, dr = this.drag, n = this.selected().length;
    if (this.nameField && document.activeElement !== this.nameField) {
      this.nameField.value = n > 1 ? '' : d?.name ?? '';
      this.nameField.placeholder = n > 1 ? `${n} artboards` : '';
      this.nameField.disabled = !d || n > 1;
    }
    const w = dr && dr.kind !== 'move' ? dr.r.w : d?.width ?? 0, hh = dr && dr.kind !== 'move' ? dr.r.h : d?.height ?? 0;
    this.wField?.set(w);
    this.hField?.set(hh);
    if (this.countLabel) { this.countLabel.textContent = n > 1 ? `${n} selected · sizes apply to all` : ''; this.countLabel.hidden = n < 2; }
  }
}

export const artboardTool = new ArtboardTool();
app.on('docs', () => artboardTool.syncOptions());
app.on('change', ({ doc }) => { if (doc === app.doc) artboardTool.syncOptions(); });
