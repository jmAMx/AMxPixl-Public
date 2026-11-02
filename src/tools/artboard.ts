import { app } from '../app';
import {
  alignArtboards, artboardToTab, deleteArtboard, distributeArtboards, duplicateArtboard, lineUpArtboards, newArtboard, pickArtboard, renameArtboard,
  resizeArtboard, resizeArtboards,
} from '../actions';
import type { IconName } from '../ui/icons';
import type { Doc } from '../core/document';
import { MAX_SIDE, pickSize } from '../core/sizes';
import { sizePicker } from '../ui/dialogs';
import { union, type Pt, type Rect } from '../core/math';
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

/** How close (CSS px) an artboard's edge snaps to another's while moving or resizing it. */
const SNAP = 6;

/** What a moved or resized artboard snapped to, for showing: a line (an edge or centre it's in line with) or a gap. */
type Guide = { axis: 'x' | 'y'; pos: number } | { axis: 'x' | 'y'; gap: [number, number]; at: number };

/** One axis of an artboard (or of several moved together): where it starts, how long, and where it spans across. */
interface Span { pos: number; size: number; across: [number, number] }

/**
 * Snapping along one axis: the moving span's sides `which` (0 start, 0.5 middle, 1 end) to the other artboards' starts,
 * middles and ends, or beside one of them at a gap the others already have between them (so they come out evenly
 * spaced). The nearest within `tol` wins; returns how far to shift and what it lined up with.
 */
function snapAxis(m: Span, others: Span[], which: number[], tol: number, axis: 'x' | 'y'): { d: number; guide: Guide | null } {
  let best = { d: 0, dist: tol, guide: null as Guide | null };
  const take = (target: number, from: number, guide: Guide) => {
    const dist = Math.abs(target - from);
    if (dist < best.dist) best = { d: target - from, dist, guide };
  };
  for (const o of others) for (const t of [0, 0.5, 1]) for (const k of which) {
    const target = o.pos + o.size * t;
    take(target, m.pos + m.size * k, { axis, pos: target });
  }
  // Gaps the others already have between neighbours: two that face each other (overlapping across) with nothing
  // facing them in between.
  const overlaps = (a: Span, b: Span) => a.across[0] < b.across[1] && b.across[0] < a.across[1];
  const gaps = new Set<number>();
  for (const a of others) for (const b of others) {
    const g = b.pos - (a.pos + a.size);
    if (a === b || g <= 0 || !overlaps(a, b)) continue;
    const between = others.some((c) => c !== a && c !== b && c.pos < b.pos && c.pos + c.size > a.pos + a.size && overlaps(c, a) && overlaps(c, b));
    if (!between) gaps.add(Math.round(g));
  }
  for (const o of others) {
    if (!overlaps(o, m)) continue;
    const mid = (Math.max(o.across[0], m.across[0]) + Math.min(o.across[1], m.across[1])) / 2;
    for (const g of gaps) {
      if (which.includes(0) && o.pos + o.size < m.pos + m.size / 2) take(o.pos + o.size + g, m.pos, { axis, gap: [o.pos + o.size, o.pos + o.size + g], at: mid });
      if (which.includes(1) && o.pos > m.pos + m.size / 2) take(o.pos - g, m.pos + m.size, { axis, gap: [o.pos - g, o.pos], at: mid });
    }
  }
  return best;
}

/** The artboards' spans along x (across y) or along y (across x). */
const spanX = (r: Rect): Span => ({ pos: r.x, size: r.w, across: [r.y, r.y + r.h] });
const spanY = (r: Rect): Span => ({ pos: r.y, size: r.h, across: [r.x, r.x + r.w] });

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
    spot.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }
  const text = state === 'over' ? `Let go: ${name} ${copy ? '(a copy) ' : ''}in its own tab` : `Drag up here: ${name} in its own tab`;
  if (spot.textContent !== text) spot.replaceChildren(icon('artboard'), h('span', null, text));
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
      if (d.toTab) { this.guides = []; proj.place(d.b, d.x0, d.y0); view.requestRender(); view.requestOverlay(); return; }
      let lock: 'x' | 'y' | null = null;
      if (p.shift) { if (Math.abs(dx) > Math.abs(dy)) { dy = 0; lock = 'y'; } else { dx = 0; lock = 'x'; } }
      // Everything being moved snaps as one box: its edges and middle to the others', or to their spacing.
      const box = d.all.map((x) => ({ x: x.x0 + dx, y: x.y0 + dy, w: x.b.doc.width, h: x.b.doc.height })).reduce((a, b) => union(a, b));
      const snapped = this.snapBox(box, d.all.map((x) => x.b), [0, 0.5, 1], [0, 0.5, 1], p.ctrl, lock);
      dx = Math.round(dx + snapped.dx); dy = Math.round(dy + snapped.dy);
      for (const x of d.all) proj.place(x.b, x.x0 + dx, x.y0 + dy);
      view.requestRender();
    } else if (d.kind === 'resize') {
      let { x, y, w, h: hh } = d.r0;
      if (d.edge.includes('w')) { x += dx; w -= dx; }
      if (d.edge.includes('e')) w += dx;
      if (d.edge.includes('n')) { y += dy; hh -= dy; }
      if (d.edge.includes('s')) hh += dy;
      // The sides being dragged snap to the others' edges and middles (and their spacing).
      const bx = d.edge.includes('w') ? [0] : d.edge.includes('e') ? [1] : [], by = d.edge.includes('n') ? [0] : d.edge.includes('s') ? [1] : [];
      const s = this.snapBox({ x, y, w, h: hh }, [this.activeBoard()!], bx, by, p.ctrl, null);
      if (bx[0] === 0) { x += s.dx; w -= s.dx; } else if (bx[0] === 1) w += s.dx;
      if (by[0] === 0) { y += s.dy; hh -= s.dy; } else if (by[0] === 1) hh += s.dy;
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

  /** What the drag in progress snapped to (spread px), shown as guides. */
  private guides: Guide[] = [];

  /**
   * How far to shift `box` (spread px) so its sides `bx` and `by` (0 start, 0.5 middle, 1 end) line up with the other
   * artboards (not those in `moving`), or sit at their spacing; nothing with View › Snap off, with Ctrl, or along a
   * locked axis. Sets the guides to show.
   */
  private snapBox(box: Rect, moving: Board[], bx: number[], by: number[], off: boolean, lock: 'x' | 'y' | null): { dx: number; dy: number } {
    this.guides = [];
    const proj = app.project!;
    if (off || !app.prefs.snap) return { dx: 0, dy: 0 };
    const others = proj.boards.filter((o) => !moving.includes(o)).map((o) => ({ x: o.x, y: o.y, w: o.doc.width, h: o.doc.height }));
    if (!others.length) return { dx: 0, dy: 0 };
    const tol = SNAP / proj.origin.zoom;
    const sx = bx.length && lock !== 'x' ? snapAxis(spanX(box), others.map(spanX), bx, tol, 'x') : { d: 0, guide: null };
    const sy = by.length && lock !== 'y' ? snapAxis(spanY(box), others.map(spanY), by, tol, 'y') : { d: 0, guide: null };
    this.guides = [sx.guide, sy.guide].filter((g): g is Guide => !!g);
    return { dx: sx.d, dy: sy.d };
  }

  up(p: PInfo) {
    const d = this.drag, proj = app.project;
    this.drag = null;
    this.guides = [];
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
    this.guides = [];
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
    this.drawGuides(ctx, o);
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

  /**
   * Snap guides: a dashed line across the view where edges or middles line up, and for a matched gap, a bar between the
   * two artboards with its size (the same as a gap the others already have).
   */
  private drawGuides(ctx: CanvasRenderingContext2D, o: { x: number; y: number; zoom: number }) {
    if (!this.drag || !this.guides.length) return;
    const { w: vw, h: vh } = view.size;
    const sx = (x: number) => Math.round(o.x + x * o.zoom) + 0.5, sy = (y: number) => Math.round(o.y + y * o.zoom) + 0.5;
    ctx.save();
    ctx.strokeStyle = '#ff3dbb';
    ctx.fillStyle = '#ff3dbb';
    ctx.lineWidth = 1;
    ctx.font = '11px "Segoe UI", sans-serif';
    for (const g of this.guides) {
      ctx.beginPath();
      if ('pos' in g) {
        ctx.setLineDash([4, 3]);
        if (g.axis === 'x') { ctx.moveTo(sx(g.pos), 0); ctx.lineTo(sx(g.pos), vh); } else { ctx.moveTo(0, sy(g.pos)); ctx.lineTo(vw, sy(g.pos)); }
        ctx.stroke();
        continue;
      }
      // A gap: a bar with end ticks, and its size.
      ctx.setLineDash([]);
      const [a, b] = g.gap, label = `${Math.round(b - a)}`;
      if (g.axis === 'x') {
        const y = sy(g.at), x0 = sx(a), x1 = sx(b);
        ctx.moveTo(x0, y); ctx.lineTo(x1, y); ctx.moveTo(x0, y - 5); ctx.lineTo(x0, y + 5); ctx.moveTo(x1, y - 5); ctx.lineTo(x1, y + 5);
        ctx.stroke();
        ctx.fillText(label, (x0 + x1) / 2 - ctx.measureText(label).width / 2, y - 6);
      } else {
        const x = sx(g.at), y0 = sy(a), y1 = sy(b);
        ctx.moveTo(x, y0); ctx.lineTo(x, y1); ctx.moveTo(x - 5, y0); ctx.lineTo(x + 5, y0); ctx.moveTo(x - 5, y1); ctx.lineTo(x + 5, y1);
        ctx.stroke();
        ctx.fillText(label, x + 7, (y0 + y1) / 2 + 4);
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
    // (Escape puts the name back before leaving the field, so leaving it doesn't rename.)
    name.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') name.blur(); if (e.key === 'Escape') { name.value = app.doc?.name ?? ''; name.blur(); } });
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
    // Lining up the selected artboards (two or more; three to distribute), or all of them in a row or column.
    const ib = (ic: IconName, title: string, run: () => void) => h('button', { class: 'icon-btn', type: 'button', title, onclick: run }, icon(ic));
    const gap = numField('Gap', app.opts.artboard.gap, (v) => { app.opts.artboard.gap = v; app.saveOpts(); }, { unit: 'px', min: 0, max: 10000 });
    gap.title = 'The space between artboards put in a row or a column';
    const align = h('span', { class: 'opt align-btns' },
      ib('alignLeft', 'Align left edges (the selected artboards)', () => alignArtboards('left')),
      ib('alignHCenter', 'Align centres across', () => alignArtboards('hcenter')),
      ib('alignRight', 'Align right edges', () => alignArtboards('right')),
      ib('alignTop', 'Align top edges', () => alignArtboards('top')),
      ib('alignVCenter', 'Align middles', () => alignArtboards('vcenter')),
      ib('alignBottom', 'Align bottom edges', () => alignArtboards('bottom')),
      ib('distH', 'Distribute across: equal gaps between three or more', () => distributeArtboards('h')),
      ib('distV', 'Distribute down: equal gaps between three or more', () => distributeArtboards('v')),
      ib('lineRow', 'In a row, the gap apart (the selected ones, or all with one selected)', () => lineUpArtboards('row', app.opts.artboard.gap)),
      ib('lineCol', 'In a column, the gap apart (the selected ones, or all with one selected)', () => lineUpArtboards('column', app.opts.artboard.gap)),
      gap);
    bar.append(
      h('label', { class: 'opt' }, h('span', { class: 'opt-label' }, 'Name'), name),
      this.countLabel,
      h('div', { class: 'opt board-size' }, pick, this.wField, this.hField, swap),
      h('span', { class: 'opt-sep' }),
      align,
      h('span', { class: 'opt-sep' }),
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
