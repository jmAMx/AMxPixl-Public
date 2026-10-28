import { apply, invert, mapRect, roundOut, union, xformMatrix, type Rect } from './math';
import { cropCanvas, ctx2d, layerMatrix, localBounds, newCanvas, type Pool } from './layers';
import { pixelsChanged } from './bounds';
import { invalidate } from './pyramid';
import { buildMask, selOutline } from './selection';
import type { Anim, GroupLayer, Guide, Layer, Meta, PixelTarget, PlacedLayer, RasterLayer, Selection, VPath } from './types';
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

/** Every layer in a tree, bottom to top; a group's children come just before the group itself. */
export function flatLayers(list: Layer[], out: Layer[] = []): Layer[] {
  for (const l of list) {
    if (l.type === 'group') flatLayers(l.children, out);
    out.push(l);
  }
  return out;
}

/** Visible pixel-carrying layers in the order they're drawn (hidden groups hide their children). */
export function visiblePlaced(list: Layer[], out: PlacedLayer[] = []): PlacedLayer[] {
  for (const l of list) {
    if (!l.visible) continue;
    if (l.type === 'group') visiblePlaced(l.children, out);
    else if (isPlaced(l)) out.push(l);
  }
  return out;
}

export interface Located { list: Layer[]; index: number; parent: GroupLayer | null }

export class Doc {
  name: string;
  width: number;
  height: number;
  layers: Layer[] = [];
  activeId: string | null = null;
  selection: Selection | null = null;
  counter = 1;
  guides: Guide[] = [];
  /** Pool key of the Quick Mask being painted, or null when not in Quick Mask mode. */
  quickMask: string | null = null;
  /** How layers are resampled when scaled: smooth, or nearest neighbour for blocky pixel art. */
  resample: 'smooth' | 'nearest' = 'smooth';
  /** Frame animation, or null for a still image. */
  anim: Anim | null = null;
  /** The animation frame being shown and edited (UI state, not part of history). */
  frame = 0;
  /** Pen paths and the one being worked on. */
  paths: VPath[] = [];
  activePath: string | null = null;

  /** Painting goes to the active layer's mask instead of its pixels (UI state, not part of history). */
  maskEdit = false;

  readonly pool: Pool = new Map();
  entries: Entry[] = [];
  /** Number of entries currently applied (entries past it are redo-able). */
  index = 0;
  private last: Meta;
  savedIndex = 0;
  /** Where this document was opened from / last saved to as .pixl (for Save and Recent Files). */
  file: { name: string; path?: string | null; handle?: FileSystemFileHandle | null } | null = null;
  /** Stable id for crash-recovery storage. */
  readonly uid = `D${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
  /** Pixel buffers changed since the last autosave, and those already autosaved. */
  readonly dirtyKeys = new Set<string>();
  readonly storedKeys = new Set<string>();
  /** Things an import couldn't bring across exactly (shown once after opening). */
  importNotes: string[] = [];

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
  get active(): Layer | null { return this.activeId ? this.layer(this.activeId) : null; }
  get activePlaced(): PlacedLayer | null { const a = this.active; return isPlaced(a) ? a : null; }
  get activeRaster(): RasterLayer | null { const a = this.active; return a?.type === 'raster' ? a : null; }

  get path(): VPath | null { return this.paths.find((p) => p.id === this.activePath) ?? null; }

  /** Whether a layer shows in animation frame `frame` (its eye, unless that frame says otherwise). */
  shows(l: Layer, frame = this.frame): boolean {
    const o = this.anim?.frames[frame]?.vis[l.id];
    return o ?? l.visible;
  }

  /** All layers, depth-first, bottom to top. */
  all(): Layer[] { return flatLayers(this.layers); }

  layer(id: string): Layer | null { return this.all().find((l) => l.id === id) ?? null; }

  /** Where a layer lives in the tree: its sibling list, its index there, and its group (if any). */
  locate(id: string, list: Layer[] = this.layers, parent: GroupLayer | null = null): Located | null {
    for (let i = 0; i < list.length; i++) {
      const l = list[i];
      if (l.id === id) return { list, index: i, parent };
      if (l.type === 'group') { const r = this.locate(id, l.children, l); if (r) return r; }
    }
    return null;
  }

  snapshot(): Meta {
    return structuredClone({
      width: this.width, height: this.height, layers: this.layers, activeId: this.activeId,
      selection: this.selection, counter: this.counter, guides: this.guides, quickMask: this.quickMask, resample: this.resample, anim: this.anim,
      paths: this.paths, activePath: this.activePath,
    });
  }

  private restore(m: Meta) {
    const c = structuredClone(m);
    this.width = c.width; this.height = c.height; this.layers = c.layers;
    this.activeId = c.activeId; this.selection = c.selection; this.counter = c.counter; this.guides = c.guides ?? []; this.quickMask = c.quickMask ?? null;
    this.resample = c.resample ?? 'smooth';
    this.anim = c.anim ?? null;
    this.paths = c.paths ?? [];
    this.activePath = c.activePath ?? null;
    this.frame = this.anim ? Math.min(this.frame, this.anim.frames.length - 1) : 0;
    if (!this.active?.mask) this.maskEdit = false;
  }

  /** Something changed that isn't (yet) a history step, e.g. a slider being dragged. */
  touch(kind: ChangeKind = 'meta') {
    this.version++;
    this.onChange(this, kind);
  }

  /** A pixel buffer changed (painting, filters, undo); `r` limits it to a region of that buffer. */
  markPixels(key: string, notify = true, r?: Rect) {
    invalidate(this.pool.get(key), r);
    pixelsChanged(key);
    this.dirtyKeys.add(key);
    this.noteDirty(r ? this.docRectOf(key, r) : null);
    if (notify) this.touch('pixels');
  }

  /** The area of the image changed since the view last drew ('all' when it can't be narrowed down). */
  private pendingDirty: Rect | 'all' | null = null;

  private noteDirty(r: Rect | null) {
    if (this.pendingDirty === 'all') return;
    this.pendingDirty = !r ? 'all' : this.pendingDirty ? union(this.pendingDirty, r) : r;
  }

  /** Hands the changed area to the view (and forgets it). */
  takeDirty(): Rect | 'all' | null {
    const d = this.pendingDirty;
    this.pendingDirty = null;
    return d;
  }

  /** Where a region of a pixel buffer lands in the image, or null if that can't be worked out simply. */
  private docRectOf(key: string, r: Rect): Rect | null {
    if (key === this.quickMask) return r;
    for (const l of this.all()) {
      if (l.type === 'raster' && l.key === key) return l.warp ? null : mapRect(xformMatrix(l.t), r);
      if (l.mask?.key === key) return mapRect(xformMatrix(l.mask.t), r);
    }
    return null;
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
    const scan = (m: Pick<Meta, 'layers' | 'selection' | 'quickMask'>) => {
      flatLayers(m.layers).forEach((l) => {
        if (l.type === 'raster') live.add(l.key);
        if (l.mask) live.add(l.mask.key);
        if (l.type === 'adjust' && l.adj.kind === 'lut' && l.adj.key) live.add(l.adj.key);
      });
      for (const op of m.selection?.ops ?? []) if (op.key) live.add(op.key);
      if (m.quickMask) live.add(m.quickMask);
    };
    scan(this);
    for (const e of this.entries) { scan(e.before); scan(e.after); e.pixels.forEach((p) => live.add(p.key)); }
    for (const k of [...this.pool.keys()]) if (!live.has(k)) this.pool.delete(k);
  }

  // ---------- pixels ----------

  addCanvas(c: HTMLCanvasElement) {
    const k = newKey();
    this.pool.set(k, c);
    this.dirtyKeys.add(k);
    return k;
  }

  canvasOf(t: PixelTarget) { return this.pool.get(t.key)!; }

  /** What painting tools should draw on: the active layer's mask (in mask mode) or its pixels. */
  paintTarget(): { target: PixelTarget; isMask: boolean; layer: Layer } | null {
    const a = this.active;
    const qm = this.quickMaskTarget;
    if (qm && a) return { target: qm, isMask: true, layer: a };
    if (!a) return null;
    if (this.maskEdit && a.mask) return { target: a.mask, isMask: true, layer: a };
    // A warped layer's pixels don't line up with the canvas until the warp is applied.
    if (a.type === 'raster' && !a.warp) return { target: a, isMask: false, layer: a };
    return null;
  }

  /**
   * Grows a pixel buffer so it covers `docRect`, keeping existing pixels in place. Lets you paint past a pasted
   * image's edges. Returns false when the target is scaled so far down that covering would be huge.
   */
  ensureCovers(t: PixelTarget, docRect: Rect = { x: 0, y: 0, w: this.width, h: this.height }) {
    const src = this.canvasOf(t);
    const need = roundOut(mapRect(invert(xformMatrix(t.t)), docRect));
    const cur = { x: 0, y: 0, w: src.width, h: src.height };
    const u = roundOut(union(cur, need));
    if (u.x >= 0 && u.y >= 0 && u.x + u.w <= cur.w && u.y + u.h <= cur.h) return true;
    if (u.w > 12000 || u.h > 12000 || u.w * u.h > 80e6) return false;
    const c = newCanvas(u.w, u.h);
    ctx2d(c).drawImage(src, -u.x, -u.y);
    const m = xformMatrix({ ...t.t, x: 0, y: 0 });
    const shift = apply(m, u.x, u.y);
    t.t = { ...t.t, x: t.t.x + shift.x, y: t.t.y + shift.y };
    t.key = this.addCanvas(c);
    return true;
  }

  /** Runs `fn` on a pixel buffer and records the change (limited to `rect` in buffer pixels if given). */
  editPixels(t: PixelTarget, label: string, fn: (ctx: CanvasRenderingContext2D, c: HTMLCanvasElement) => void, rect?: Rect) {
    const c = this.canvasOf(t);
    const r = rect ?? { x: 0, y: 0, w: c.width, h: c.height };
    const ctx = ctx2d(c);
    const before = cropCanvas(c, r);
    ctx.save();
    fn(ctx, c);
    ctx.restore();
    this.commit(label, [{ key: t.key, rect: r, before, after: null }]);
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
    const canvas = buildMask(this.selection, this.width, this.height, this.pool);
    this.maskCache = { sel: this.selection, canvas };
    return canvas;
  }

  private outlineCache: { sel: Selection; path: Path2D } | null = null;

  /** The selection's outline in document coordinates (cached), for drawing marching ants. */
  selectionOutline(): Path2D | null {
    if (!this.selection) return null;
    if (this.outlineCache?.sel === this.selection) return this.outlineCache.path;
    const path = selOutline(this.selection, this.width, this.height, this.pool);
    this.outlineCache = { sel: this.selection, path };
    return path;
  }

  /** A quick-mask target: painting it edits the selection-to-be (document space). */
  get quickMaskTarget(): PixelTarget | null {
    return this.quickMask ? { key: this.quickMask, t: { x: 0, y: 0, sx: 1, sy: 1, rot: 0 } } : null;
  }

  /** The selection mask mapped into a pixel buffer's own grid. */
  maskForLayer(t: PixelTarget): HTMLCanvasElement | null {
    const mask = this.selectionMask();
    if (!mask) return null;
    const src = this.canvasOf(t);
    const c = newCanvas(src.width, src.height);
    const ctx = ctx2d(c);
    const m = invert(xformMatrix(t.t));
    ctx.setTransform(m[0], m[1], m[2], m[3], m[4], m[5]);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(mask, 0, 0);
    return c;
  }

  // ---------- layers ----------

  /** "Layer 3", "Group 2"...: one more than the highest number already used with that name. */
  nextName(base = 'Layer') {
    const re = new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} (\\d+)$`);
    let n = 1;
    for (const l of this.all()) { const m = re.exec(l.name); if (m) n = Math.max(n, Number(m[1]) + 1); }
    return `${base} ${n}`;
  }

  /** Inserts above `aboveId` in the same group (or at the top of the document). */
  insertLayer(l: Layer, aboveId: string | null = this.activeId) {
    const at = aboveId ? this.locate(aboveId) : null;
    if (at) at.list.splice(at.index + 1, 0, l);
    else this.layers.push(l);
    this.activeId = l.id;
    this.maskEdit = false;
  }

  removeLayer(id: string) {
    const at = this.locate(id);
    if (!at) return;
    at.list.splice(at.index, 1);
    if (this.activeId === id || !this.layer(this.activeId ?? '')) {
      this.activeId = at.list[Math.min(at.index, at.list.length - 1)]?.id ?? at.parent?.id ?? this.layers[this.layers.length - 1]?.id ?? null;
    }
    this.maskEdit = false;
  }

  /** Moves a layer to `index` within `list` (which may be a group's children). */
  moveLayerTo(id: string, list: Layer[], index: number) {
    const at = this.locate(id);
    if (!at) return;
    const [l] = at.list.splice(at.index, 1);
    if (at.list === list && at.index < index) index--;
    list.splice(Math.max(0, Math.min(list.length, index)), 0, l);
  }

  setActive(id: string | null, mask = false) {
    this.activeId = id;
    this.maskEdit = mask && !!this.active?.mask;
    this.alsoSelected = [];
  }

  /** Layers selected along with the active one (Ctrl/Shift+click), moved and transformed together. UI state. */
  alsoSelected: string[] = [];

  /** The active layer and any others selected with it, bottom to top. */
  selectedIds(): string[] {
    const want = new Set([this.activeId, ...this.alsoSelected]);
    return this.all().filter((l) => want.has(l.id)).map((l) => l.id);
  }

  /**
   * The selected layers that have a place on the canvas, with a selected group standing for every image, text and
   * shape layer inside it (so moving a group moves its contents). Bottom to top, each once; hidden ones skipped.
   */
  selectedPlaced(): PlacedLayer[] {
    const out = new Map<string, PlacedLayer>();
    const add = (l: Layer) => {
      if (!this.shows(l)) return;
      if (l.type === 'group') l.children.forEach(add);
      else if (isPlaced(l)) out.set(l.id, l);
    };
    for (const id of this.selectedIds()) { const l = this.layer(id); if (l) add(l); }
    return this.all().filter((l): l is PlacedLayer => out.has(l.id));
  }

  /** Ctrl+click: adds a layer to the selection, or takes it out (the active layer moves to another selected one). */
  toggleSelected(id: string) {
    const sel = this.selectedIds();
    if (!sel.includes(id)) { this.alsoSelected = sel; this.activeId = id; this.maskEdit = false; return; }
    if (sel.length === 1) return;
    const rest = sel.filter((x) => x !== id);
    if (this.activeId === id) this.activeId = rest[rest.length - 1];
    this.alsoSelected = rest.filter((x) => x !== this.activeId);
  }

  /** Shift+click: selects every layer from the active one to `id` in the Layers panel's order. */
  selectRange(id: string) {
    const order = this.all().map((l) => l.id);
    const a = order.indexOf(this.activeId ?? id), b = order.indexOf(id);
    if (a < 0 || b < 0) return;
    const [lo, hi] = a < b ? [a, b] : [b, a];
    const anchor = this.activeId;
    this.activeId = id;
    this.maskEdit = false;
    this.alsoSelected = order.slice(lo, hi + 1).filter((x) => x !== id);
    if (anchor && !this.alsoSelected.includes(anchor) && anchor !== id) this.alsoSelected.push(anchor);
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
