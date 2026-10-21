import { apply, invert, mapRect, roundOut, union, xformMatrix, type Rect } from './math';
import { cloneCanvas, cropCanvas, ctx2d, layerMatrix, localBounds, newCanvas, type Pool } from './layers';
import { invalidate } from './pyramid';
import { buildMask } from './selection';
import type { Layer, Meta, PlacedLayer, RasterLayer, Selection } from './types';
import { isPlaced } from './types';

/**
 * Pixels a step changed, kept as GPU canvases (reading pixels back to the CPU is very slow on integrated GPUs).
 * `after` is captured lazily the first time the step is undone, which halves undo memory.
 */
export interface PixelDiff { key: string; rect: Rect; before: HTMLCanvasElement; after: HTMLCanvasElement | null }
interface Entry { label: string; before: Meta; after: Meta; pixels: PixelDiff[]; bytes: number }

const MAX_ENTRIES = 80;
/** Undo pixel budget. Integrated GPUs share system RAM, so stay well clear of exhausting it. */
const MAX_BYTES = 700 * 1024 * 1024;

let keySeq = 0;
const newKey = () => `px${Date.now().toString(36)}${(keySeq++).toString(36)}`;
let idSeq = 0;
export const newId = () => `L${Date.now().toString(36)}${(idSeq++).toString(36)}`;

export type ChangeKind = 'pixels' | 'meta' | 'history';

export class Doc {
  name: string;
  width: number;
  height: number;
  layers: Layer[] = [];
  activeId: string | null = null;
  selection: Selection | null = null;
  counter = 1;

  readonly pool: Pool = new Map();
  entries: Entry[] = [];
  /** Number of entries currently applied (entries past it are redo-able). */
  index = 0;
  private last: Meta;
  savedIndex = 0;
  fileHandle: FileSystemFileHandle | null = null;

  /** View state, kept per document. */
  zoom = 1;
  panX = 0;
  panY = 0;
  fitted = false;

  version = 0;
  onChange: (doc: Doc, kind: ChangeKind) => void = () => {};

  private maskCache: { sel: Selection; canvas: HTMLCanvasElement } | null = null;

  constructor(name: string, width: number, height: number) {
    this.name = name;
    this.width = width;
    this.height = height;
    this.last = this.snapshot();
  }

  get dirty() { return this.index !== this.savedIndex; }
  get active(): Layer | null { return this.layers.find((l) => l.id === this.activeId) ?? null; }
  get activePlaced(): PlacedLayer | null { const a = this.active; return isPlaced(a) ? a : null; }
  get activeRaster(): RasterLayer | null { const a = this.active; return a?.type === 'raster' ? a : null; }

  layer(id: string) { return this.layers.find((l) => l.id === id) ?? null; }
  indexOf(id: string) { return this.layers.findIndex((l) => l.id === id); }

  snapshot(): Meta {
    return structuredClone({
      width: this.width, height: this.height, layers: this.layers, activeId: this.activeId,
      selection: this.selection, counter: this.counter,
    });
  }

  private restore(m: Meta) {
    const c = structuredClone(m);
    this.width = c.width; this.height = c.height; this.layers = c.layers;
    this.activeId = c.activeId; this.selection = c.selection; this.counter = c.counter;
  }

  /** Something changed that isn't (yet) a history step, e.g. a slider being dragged. */
  touch(kind: ChangeKind = 'meta') {
    this.version++;
    this.onChange(this, kind);
  }

  /** A raster buffer's pixels changed (painting, filters, undo); `r` limits it to a region of that buffer. */
  markPixels(key: string, notify = true, r?: Rect) {
    invalidate(this.pool.get(key), r);
    if (notify) this.touch('pixels');
  }

  /** Records everything changed since the last commit as one undoable step. */
  commit(label: string, pixels: PixelDiff[] = []) {
    const after = this.snapshot();
    if (!pixels.length && JSON.stringify(after) === JSON.stringify(this.last)) return;
    for (const p of pixels) this.markPixels(p.key, false, p.rect);
    const bytes = pixels.reduce((n, p) => n + p.rect.w * p.rect.h * 8, 0) + 4096;
    if (this.savedIndex > this.index) this.savedIndex = -1;
    this.entries.length = this.index;
    this.entries.push({ label, before: this.last, after, pixels, bytes });
    this.index = this.entries.length;
    this.last = after;
    this.trim();
    this.touch('history');
  }

  /** Starts history fresh (after New/Open). */
  resetHistory(label: string) {
    this.entries = [];
    this.last = this.snapshot();
    this.entries.push({ label, before: this.last, after: this.last, pixels: [], bytes: 0 });
    this.index = this.savedIndex = 1;
    this.gc();
  }

  get canUndo() { return this.index > 1; }
  get canRedo() { return this.index < this.entries.length; }

  undo() {
    if (!this.canUndo) return;
    const e = this.entries[--this.index];
    for (const p of [...e.pixels].reverse()) {
      const c = this.pool.get(p.key);
      if (!p.after && c) p.after = cropCanvas(c, p.rect);
      this.putPixels(p.key, p.rect, p.before);
    }
    this.restore(e.before);
    this.last = e.before;
    this.maskCache = null;
    this.touch('history');
  }

  redo() {
    if (!this.canRedo) return;
    const e = this.entries[this.index++];
    for (const p of e.pixels) if (p.after) this.putPixels(p.key, p.rect, p.after);
    this.restore(e.after);
    this.last = e.after;
    this.maskCache = null;
    this.touch('history');
  }

  goTo(index: number) {
    while (this.index > index && this.canUndo) this.undo();
    while (this.index < index && this.canRedo) this.redo();
  }

  /** Drops whatever was changed since the last commit (used when a dialog is cancelled). */
  revert() {
    this.restore(this.last);
    this.maskCache = null;
    this.touch('meta');
  }

  private putPixels(key: string, r: Rect, img: HTMLCanvasElement) {
    const c = this.pool.get(key);
    if (!c) return;
    const x = ctx2d(c);
    x.save();
    x.setTransform(1, 0, 0, 1, 0, 0);
    x.beginPath();
    x.rect(r.x, r.y, r.w, r.h);
    x.clip();
    x.globalCompositeOperation = 'copy';
    x.globalAlpha = 1;
    x.drawImage(img, r.x, r.y);
    x.restore();
    this.markPixels(key, false, r);
  }

  private trim() {
    let total = this.entries.reduce((n, e) => n + e.bytes, 0);
    let dropped = false;
    while (this.entries.length > 2 && (this.entries.length > MAX_ENTRIES || total > MAX_BYTES)) {
      const e = this.entries.splice(1, 1)[0];
      total -= e.bytes;
      this.index--;
      this.savedIndex--;
      dropped = true;
    }
    if (dropped) {
      // The oldest kept step now starts from where the dropped one began.
      this.entries[0] = { ...this.entries[0], after: this.entries[1].before };
    }
    this.gc();
  }

  /** Frees pixel buffers no longer reachable from the document or any history step. */
  gc() {
    const live = new Set<string>();
    const scan = (ls: Layer[]) => ls.forEach((l) => l.type === 'raster' && live.add(l.key));
    scan(this.layers);
    for (const e of this.entries) { scan(e.before.layers); scan(e.after.layers); e.pixels.forEach((p) => live.add(p.key)); }
    for (const k of [...this.pool.keys()]) if (!live.has(k)) this.pool.delete(k);
  }

  // ---------- pixels ----------

  addCanvas(c: HTMLCanvasElement) {
    const k = newKey();
    this.pool.set(k, c);
    return k;
  }

  canvasOf(l: RasterLayer) { return this.pool.get(l.key)!; }

  /** Gives a raster layer its own copy of its pixels under a new key (so edits can't reach shared history buffers). */
  forkPixels(l: RasterLayer) {
    l.key = this.addCanvas(cloneCanvas(this.canvasOf(l)));
  }

  /**
   * Grows a raster layer's pixel buffer so it covers `docRect`, keeping existing pixels in place. Lets you paint
   * past a pasted image's edges. Returns false when the layer is scaled so far down that covering would be huge.
   */
  ensureCovers(l: RasterLayer, docRect: Rect = { x: 0, y: 0, w: this.width, h: this.height }) {
    const src = this.canvasOf(l);
    const need = roundOut(mapRect(invert(layerMatrix(l)), docRect));
    const cur = { x: 0, y: 0, w: src.width, h: src.height };
    const u = roundOut(union(cur, need));
    if (u.x >= 0 && u.y >= 0 && u.x + u.w <= cur.w && u.y + u.h <= cur.h) return true;
    if (u.w > 12000 || u.h > 12000 || u.w * u.h > 80e6) return false;
    const c = newCanvas(u.w, u.h);
    ctx2d(c).drawImage(src, -u.x, -u.y);
    const m = xformMatrix({ ...l.t, x: 0, y: 0 });
    const shift = apply(m, u.x, u.y);
    l.t = { ...l.t, x: l.t.x + shift.x, y: l.t.y + shift.y };
    l.key = this.addCanvas(c);
    return true;
  }

  /** Runs `fn` on a raster layer's pixels and records the change (limited to `rect` in layer pixels if given). */
  editPixels(l: RasterLayer, label: string, fn: (ctx: CanvasRenderingContext2D, c: HTMLCanvasElement) => void, rect?: Rect) {
    const c = this.canvasOf(l);
    const r = rect ?? { x: 0, y: 0, w: c.width, h: c.height };
    const ctx = ctx2d(c);
    const before = cropCanvas(c, r);
    ctx.save();
    fn(ctx, c);
    ctx.restore();
    this.commit(label, [{ key: l.key, rect: r, before, after: null }]);
  }

  // ---------- selection ----------

  setSelection(sel: Selection | null) {
    this.selection = sel && sel.ops.length ? sel : null;
    this.maskCache = null;
  }

  /** Document-sized alpha mask of the selection (cached), or null when nothing is selected. */
  selectionMask(): HTMLCanvasElement | null {
    if (!this.selection) return null;
    if (this.maskCache && this.maskCache.sel === this.selection) return this.maskCache.canvas;
    const canvas = buildMask(this.selection, this.width, this.height);
    this.maskCache = { sel: this.selection, canvas };
    return canvas;
  }

  /** The selection mask mapped into a raster layer's own pixel grid. */
  maskForLayer(l: RasterLayer): HTMLCanvasElement | null {
    const mask = this.selectionMask();
    if (!mask) return null;
    const src = this.canvasOf(l);
    const c = newCanvas(src.width, src.height);
    const ctx = ctx2d(c);
    const m = invert(layerMatrix(l));
    ctx.setTransform(m[0], m[1], m[2], m[3], m[4], m[5]);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(mask, 0, 0);
    return c;
  }

  // ---------- layers ----------

  nextName(base = 'Layer') { return `${base} ${this.counter++}`; }

  insertLayer(l: Layer, aboveId: string | null = this.activeId) {
    const i = aboveId ? this.indexOf(aboveId) : -1;
    this.layers.splice(i >= 0 ? i + 1 : this.layers.length, 0, l);
    this.activeId = l.id;
  }

  removeLayer(id: string) {
    const i = this.indexOf(id);
    if (i < 0) return;
    this.layers.splice(i, 1);
    if (this.activeId === id) this.activeId = this.layers[Math.min(i, this.layers.length - 1)]?.id ?? (this.layers[i - 1]?.id ?? null);
  }

  newRasterLayer(name = this.nextName(), fill?: string): RasterLayer {
    const c = newCanvas(this.width, this.height);
    if (fill) { const x = ctx2d(c); x.fillStyle = fill; x.fillRect(0, 0, c.width, c.height); }
    return { id: newId(), type: 'raster', name, visible: true, opacity: 1, blend: 'normal', key: this.addCanvas(c), t: { x: 0, y: 0, sx: 1, sy: 1, rot: 0 } };
  }

  /** Document-space bounding box of a placed layer. */
  layerBounds(l: PlacedLayer): Rect {
    return mapRect(layerMatrix(l), localBounds(l, this.pool));
  }
}
