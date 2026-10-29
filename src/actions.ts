import { app } from './app';
import { defaultAdj, ADJ_LABELS } from './core/adjustments';
import { Doc, flatLayers, newId } from './core/document';
import { defaultFx, fxDef } from './core/effects';
import { baseName, canvasBlob, decodeImage, decodePixl, docFromCanvas, encodePixl, extOf, PIXL_ACCEPT, saveBlob, type Picked } from './core/fileio';
import { importPsd } from './core/import/psd';
import { importXcf } from './core/import/xcfimport';
import { addRecent, openRecent, removeRecent, type RecentEntry } from './core/recent';
import { clearRecovery } from './core/recovery';
import { cloneCanvas, ctx2d, drawPlaced, follow, layerMatrix, localBounds, newCanvas } from './core/layers';
import { savedLooks, storeLooks, type Look, type LookItem } from './core/looks';
import { parseCube } from './core/lut';
import { apply, decompose, intersect, invert, mapRect, matScale, mul, roundOut, setT, tidy, union, xformMatrix, type Mat, type Pt, type Rect, type Xform } from './core/math';
import { flatten, renderDoc } from './core/render';
import { layerBoxReady, trimRect } from './core/bounds';
import { Stroke } from './core/brush';
import { glops } from './core/glops';
import { ellipseSub, flattenSub, mapSubs, maskToSubs, polySub, rectSub, toPath2D } from './core/paths';
import { shapePoints } from './core/layers';
import { invertSel, mapSel, maskSelection, selBounds } from './core/selection';
import { colorRangeMask, combine, layerAlphaMask, modifyMask, sampleSource, wandMask, type Modify, type SelMode } from './core/selops';
import { defaultStyles } from './core/styles';
import type { AdjKind, AdjParams, Anim, AnimFrame, BlendIf, GroupLayer, Guide, Layer, LayerStyles, Mask, PathPoint, PlacedLayer, RasterLayer, ShapeLayer, SubPath, TextLayer, VPath, Warp } from './core/types';
import { initWarp, warpBounds } from './core/warp';
import { envelopeMesh, shapeFit, type Envelope } from './core/envelope';
import { loadFont, outlineText } from './core/outline';
import { defaultModel, renderModel, type Model3D } from './core/model3d';
import { alphaBox } from './core/alphabox';
import { isFilter, isPlaced } from './core/types';
import { view } from './ui/canvasview';
import { ask, toast } from './ui/widgets';

const need = (): Doc | null => app.doc;

// ---------- documents ----------

export function createDoc(name: string, w: number, h: number, bg: string | null) {
  const doc = new Doc(name, w, h);
  const l = doc.newRasterLayer(bg ? 'Background' : 'Layer 1', bg ?? undefined);
  if (!bg) doc.counter = 2;
  doc.layers.push(l);
  doc.activeId = l.id;
  doc.resetHistory('New');
  app.addDoc(doc);
}

let untitled = 1;
export const nextUntitled = () => `Untitled-${untitled++}`;

/** A small JPEG preview of a document for the Recent Files list. */
export function thumbOf(doc: Doc): string | undefined {
  try {
    const s = 160 / Math.max(doc.width, doc.height);
    return flatten(doc, Math.min(1, s)).toDataURL('image/jpeg', 0.7);
  } catch { return undefined; }
}

export async function openFiles(files: Picked[]) {
  for (const { file, ref } of files) {
    try {
      const ext = extOf(file.name);
      let doc: Doc;
      if (ext === 'pixl') {
        doc = await decodePixl(file, baseName(file.name));
        doc.name = file.name;
        doc.file = ref.path || ref.handle ? ref : null;
      } else if (ext === 'psd' || ext === 'psb') {
        doc = await importPsd(await file.arrayBuffer(), file.name);
      } else if (ext === 'xcf') {
        doc = await importXcf(await file.arrayBuffer(), file.name);
      } else {
        doc = docFromCanvas(file.name, await decodeImage(file));
      }
      app.addDoc(doc);
      if (doc.importNotes.length) toast(`Imported ${file.name}. ${doc.importNotes.join(' ')}`);
      addRecent(ref, thumbOf(doc));
    } catch (e) {
      console.error(e);
      toast(`Couldn't open ${file.name}: ${(e as Error).message || 'unsupported file'}`, 'error');
    }
  }
  app.emit('recent');
}

export async function openRecentEntry(e: RecentEntry) {
  try {
    await openFiles([await openRecent(e)]);
  } catch (err) {
    const r = await ask('Can\'t open file', `${e.name}: ${(err as Error).message} Remove it from Recent Files?`, [{ id: 'keep', label: 'Keep' }, { id: 'remove', label: 'Remove', primary: true }]);
    if (r === 'remove') { removeRecent(e.id); app.emit('recent'); }
  }
}

/** Adds images to the current document as new layers, centred (scaled down to fit if larger). */
export async function placeFiles(files: File[]) {
  const doc = need();
  if (!doc) return openFiles(files.map((f) => ({ file: f, ref: { name: f.name } })));
  for (const f of files) {
    try {
      if (['pixl', 'psd', 'xcf'].includes(extOf(f.name))) { await openFiles([{ file: f, ref: { name: f.name } }]); continue; }
      placeCanvas(await decodeImage(f), baseName(f.name), null, true);
    } catch (e) {
      toast(`Couldn't place ${f.name}: ${(e as Error).message}`, 'error');
    }
  }
}

export function placeCanvas(c: HTMLCanvasElement, name: string, at: Pt | null, fit = false) {
  const doc = app.doc!;
  let s = 1;
  if (fit && (c.width > doc.width || c.height > doc.height)) s = Math.min(doc.width / c.width, doc.height / c.height);
  const pos = at ?? { x: Math.round((doc.width - c.width * s) / 2), y: Math.round((doc.height - c.height * s) / 2) };
  const l: RasterLayer = { id: newId(), type: 'raster', name, visible: true, opacity: 1, blend: 'normal', key: doc.addCanvas(c), t: { x: pos.x, y: pos.y, sx: s, sy: s, rot: 0 } };
  doc.insertLayer(l);
  doc.commit(`Place ${name}`);
  if (s < 1) toast(`Placed at ${Math.round(s * 100)}% to fit. The full-size original is kept, so scaling it up later loses nothing.`);
}

export async function saveDoc(doc: Doc | null = app.doc, saveAs = false) {
  if (!doc) return false;
  const isPixl = doc.name.toLowerCase().endsWith('.pixl');
  const existing = !saveAs && isPixl ? doc.file : null;
  try {
    const blob = await encodePixl(doc);
    const ref = await saveBlob(blob, `${baseName(doc.name)}.pixl`, existing, PIXL_ACCEPT);
    if (ref === undefined) return false;
    const stored = ref.path || ref.handle;
    doc.file = stored ? ref : null;
    doc.name = stored ? ref.name : `${baseName(doc.name)}.pixl`;
    doc.savedIndex = doc.index;
    app.emit('docs');
    toast(`Saved ${doc.name}`);
    if (stored) { addRecent(ref, thumbOf(doc)); app.emit('recent'); }
    clearRecovery(doc).catch(() => {});
    return true;
  } catch (e) {
    toast(`Save failed: ${(e as Error).message}`, 'error');
    return false;
  }
}

export async function exportImage(doc: Doc, o: { format: 'png' | 'jpeg' | 'webp'; quality: number; scale: number; nearest?: boolean }) {
  let c = flatten(doc, o.scale, { nearest: o.nearest });
  if (o.format === 'jpeg') {
    const bgc = newCanvas(c.width, c.height);
    const x = ctx2d(bgc);
    x.fillStyle = '#ffffff';
    x.fillRect(0, 0, c.width, c.height);
    x.drawImage(c, 0, 0);
    c = bgc;
  }
  const blob = await canvasBlob(c, `image/${o.format}`, o.format === 'png' ? undefined : o.quality);
  const ext = o.format === 'jpeg' ? 'jpg' : o.format;
  const accept = { [`image/${o.format}`]: [`.${ext}`] };
  const ref = await saveBlob(blob, `${baseName(doc.name)}.${ext}`, null, accept);
  if (ref !== undefined) toast(`Exported ${c.width} × ${c.height} ${ext.toUpperCase()} (${(blob.size / 1024 / 1024).toFixed(2)} MB)`);
}

export async function closeDoc(doc: Doc | null = app.doc) {
  if (!doc) return;
  if (doc.dirty) {
    const r = await ask('Unsaved changes', `Save changes to "${doc.name}" before closing?`, [
      { id: 'cancel', label: 'Cancel' }, { id: 'discard', label: "Don't save", danger: true }, { id: 'save', label: 'Save', primary: true },
    ]);
    if (r === 'cancel') return;
    if (r === 'save' && !(await saveDoc(doc))) return;
  }
  clearRecovery(doc).catch(() => {});
  app.removeDoc(doc);
}

export const undo = () => app.doc?.undo();
export const redo = () => app.doc?.redo();

// ---------- layers ----------

export function newLayer() {
  const doc = need(); if (!doc) return;
  doc.insertLayer(doc.newRasterLayer());
  doc.commit('New layer');
}

export function newAdjustment(kind: AdjKind) {
  const doc = need(); if (!doc) return;
  doc.insertLayer({ id: newId(), type: 'adjust', name: ADJ_LABELS[kind], visible: true, opacity: 1, blend: 'normal', adj: defaultAdj(kind) });
  doc.commit(`New ${ADJ_LABELS[kind]} layer`);
}

export function newEffect(kind: string) {
  const doc = need(); const def = fxDef(kind); if (!doc || !def) return;
  doc.insertLayer({ id: newId(), type: 'effect', name: def.label, visible: true, opacity: 1, blend: 'normal', fx: defaultFx(kind) });
  doc.commit(`New ${def.label} layer`);
}

export function newGroup() {
  const doc = need(); if (!doc) return;
  doc.insertLayer({ id: newId(), type: 'group', name: doc.nextName('Group'), visible: true, opacity: 1, blend: 'pass-through', children: [], open: true });
  doc.commit('New group');
}

/**
 * The selected layers, bottom to top, leaving out any inside another selected group (they go along with it). What
 * Group, Duplicate and Delete act on when several layers are selected.
 */
function selectedRoots(doc: Doc): string[] {
  const sel = new Set(doc.selectedIds());
  const inside = (id: string) => { for (let p = doc.locate(id)?.parent; p; p = doc.locate(p.id)?.parent) if (sel.has(p.id)) return true; return false; };
  return [...sel].filter((id) => !inside(id));
}

/** Puts the selected layers into a new group, where the top one was. */
export function groupLayer() {
  const doc = need(); if (!doc) return;
  const ids = selectedRoots(doc);
  if (!ids.length) return;
  const g: GroupLayer = { id: newId(), type: 'group', name: doc.nextName('Group'), visible: true, opacity: 1, blend: 'pass-through', children: [], open: true };
  const top = doc.locate(ids[ids.length - 1])!;
  top.list.splice(top.index + 1, 0, g);
  for (const id of ids) {
    const at = doc.locate(id)!;
    g.children.push(...at.list.splice(at.index, 1));
  }
  doc.setActive(g.id);
  doc.commit(ids.length > 1 ? 'Group layers' : 'Group layer');
}

export function ungroup() {
  const doc = need(); const a = doc?.active; if (!doc || !a) return;
  const g = a.type === 'group' ? a : doc.locate(a.id)?.parent;
  if (!g) { toast('Select a group to ungroup.'); return; }
  const at = doc.locate(g.id)!;
  at.list.splice(at.index, 1, ...g.children);
  doc.setActive(g.children[g.children.length - 1]?.id ?? null);
  doc.commit('Ungroup');
}

/** Copies a layer (and a group's whole contents) with fresh ids and its own pixel buffers. */
function cloneLayer(doc: Doc, l: Layer): Layer {
  const c = structuredClone(l) as Layer;
  const fix = (x: Layer) => {
    x.id = newId();
    if (x.type === 'raster') x.key = doc.addCanvas(cloneCanvas(doc.pool.get(x.key)!));
    if (x.mask) x.mask.key = doc.addCanvas(cloneCanvas(doc.pool.get(x.mask.key)!));
    if (x.type === 'group') x.children.forEach(fix);
  };
  fix(c);
  return c;
}

/** Duplicates the selected layers, each copy just above its original; the copies end up selected. */
export function duplicateLayer() {
  const doc = need(); if (!doc) return;
  const ids = selectedRoots(doc);
  if (!ids.length) return;
  const copies: string[] = [];
  for (const id of ids) {
    const l = doc.layer(id)!;
    const copy = cloneLayer(doc, l);
    copy.name = `${l.name} copy`;
    doc.insertLayer(copy, l.id);
    copies.push(copy.id);
  }
  doc.setActive(copies[copies.length - 1]);
  doc.alsoSelected = copies.slice(0, -1);
  doc.commit(ids.length > 1 ? 'Duplicate layers' : 'Duplicate layer');
}

/** Deletes one layer, or with no id, every selected layer. */
export function deleteLayer(id?: string) {
  const doc = need(); if (!doc) return;
  const ids = id ? [id] : selectedRoots(doc);
  if (!ids.length) return;
  for (const x of ids) doc.removeLayer(x);
  doc.commit(ids.length > 1 ? 'Delete layers' : 'Delete layer');
}

// ---------- align & distribute ----------

export type AlignEdge = 'left' | 'hcenter' | 'right' | 'top' | 'vcenter' | 'bottom';

/** Each selected layer, or group as a whole, with the box around what it shows (the Move tool's Box setting). */
async function selectedUnits(doc: Doc): Promise<{ layers: PlacedLayer[]; box: Rect }[]> {
  const units: { layers: PlacedLayer[]; box: Rect }[] = [];
  for (const id of selectedRoots(doc)) {
    const l = doc.layer(id)!;
    const layers = (l.type === 'group' ? flatLayers(l.children) : [l]).filter((x): x is PlacedLayer => isPlaced(x) && doc.shows(x));
    if (!layers.length) continue;
    let box: Rect | null = null;
    for (const x of layers) box = union(box, mapRect(layerMatrix(x), await layerBoxReady(x, doc.pool, app.opts.move.box)));
    units.push({ layers, box: box! });
  }
  return units;
}

const shiftUnit = (layers: PlacedLayer[], dx: number, dy: number) => {
  for (const l of layers) setPlacedTransform(l, { ...l.t, x: l.t.x + dx, y: l.t.y + dy });
};

/** Lines the selected layers up by an edge or centre: with each other, or with the canvas when there's just one. */
export async function alignLayers(edge: AlignEdge) {
  const doc = need(); if (!doc) return;
  const units = await selectedUnits(doc);
  if (!app.docs.includes(doc)) return;
  if (!units.length) { toast('Select a layer to align.'); return; }
  const ref = units.length > 1 ? units.reduce<Rect | null>((r, u) => union(r, u.box), null)! : { x: 0, y: 0, w: doc.width, h: doc.height };
  for (const { layers, box: b } of units) {
    const dx = edge === 'left' ? ref.x - b.x : edge === 'right' ? ref.x + ref.w - b.x - b.w : edge === 'hcenter' ? ref.x + (ref.w - b.w) / 2 - b.x : 0;
    const dy = edge === 'top' ? ref.y - b.y : edge === 'bottom' ? ref.y + ref.h - b.y - b.h : edge === 'vcenter' ? ref.y + (ref.h - b.h) / 2 - b.y : 0;
    shiftUnit(layers, dx, dy);
  }
  doc.commit(units.length > 1 ? 'Align layers' : 'Align to canvas');
}

/** Spaces three or more selected layers evenly between the outermost two (equal gaps). */
export async function distributeLayers(axis: 'h' | 'v') {
  const doc = need(); if (!doc) return;
  const units = await selectedUnits(doc);
  if (!app.docs.includes(doc)) return;
  if (units.length < 3) { toast('Select three or more layers to distribute.'); return; }
  const pos = (b: Rect) => (axis === 'h' ? b.x : b.y), size = (b: Rect) => (axis === 'h' ? b.w : b.h);
  units.sort((a, b) => pos(a.box) - pos(b.box));
  const first = units[0].box, last = units[units.length - 1].box;
  const gap = (pos(last) + size(last) - pos(first) - units.reduce((s, u) => s + size(u.box), 0)) / (units.length - 1);
  let at = pos(first);
  for (const u of units) {
    const d = at - pos(u.box);
    shiftUnit(u.layers, axis === 'h' ? d : 0, axis === 'v' ? d : 0);
    at += size(u.box) + gap;
  }
  doc.commit(axis === 'h' ? 'Distribute horizontally' : 'Distribute vertically');
}

/**
 * Layer › Trim to Content: shrinks the selected image layers' pixels to the area that has something in it. Nothing
 * moves or changes on the canvas; the layers just stop carrying empty space (smaller files, less memory).
 */
export async function trimLayers() {
  const doc = need(); if (!doc) return;
  const layers = doc.selectedPlaced().filter((l): l is RasterLayer => l.type === 'raster' && !l.warp && !l.model);
  if (!layers.length) { toast('Select an image layer to trim (warped layers can\'t be trimmed until the warp is applied).'); return; }
  const boxes = await Promise.all(layers.map((l) => layerBoxReady(l, doc.pool, 'content')));
  if (!app.docs.includes(doc)) return;
  let saved = 0, trimmed = 0;
  layers.forEach((l, i) => {
    const src = doc.pool.get(l.key);
    if (!src) return;
    // A 2px transparent border stays, so a turned or scaled layer's edges blend exactly as they did before.
    const b = roundOut(boxes[i]);
    const r = intersect({ x: b.x - 2, y: b.y - 2, w: b.w + 4, h: b.h + 4 }, { x: 0, y: 0, w: src.width, h: src.height });
    if (!r || (r.x <= 0 && r.y <= 0 && r.w >= src.width && r.h >= src.height)) return;
    const c = newCanvas(r.w, r.h);
    ctx2d(c).drawImage(src, -r.x, -r.y);
    // The new top-left is the old (r.x, r.y): same place on the canvas, same turn and scale.
    const p = apply(layerMatrix(l), r.x, r.y);
    saved += src.width * src.height - r.w * r.h;
    l.key = doc.addCanvas(c);
    l.t = { ...l.t, x: p.x, y: p.y };
    if (l.box) l.box = { ...l.box, x: l.box.x - r.x, y: l.box.y - r.y };
    trimmed++;
  });
  if (!trimmed) { toast('Nothing to trim: the layer has no empty edges.'); return; }
  doc.commit(trimmed > 1 ? 'Trim layers' : 'Trim layer');
  toast(`Trimmed ${trimmed} layer${trimmed > 1 ? 's' : ''}, ${Math.round(saved / 1e4) / 100} megapixels lighter.`);
}

/** Shows or hides several layers in one step (the eye of a layer that's part of a multiple selection). */
export function setLayersVisible(ids: string[], visible: boolean) {
  const doc = need(); if (!doc) return;
  for (const id of ids) setLayerProp(id, { visible });
  doc.commit(visible ? 'Show layers' : 'Hide layers');
}

export function setLayerProp(id: string, patch: Partial<Pick<Layer, 'name' | 'visible' | 'opacity' | 'blend' | 'clip'>>, label?: string) {
  const doc = need(); const l = doc?.layer(id); if (!doc || !l) return;
  // In an animation the eye belongs to the current frame.
  const f = doc.anim?.frames[doc.frame];
  if (f && patch.visible !== undefined) {
    const { visible, ...rest } = patch;
    f.vis[id] = visible;
    patch = rest;
  }
  Object.assign(l, patch);
  if (label) doc.commit(label); else doc.touch('meta');
}

// ---------- paths ----------

const pathId = () => `p${Math.random().toString(36).slice(2, 9)}`;

/** Starts an empty path (the Paths tool adds points to it) and makes it the active one. */
export function newPath(subs: SubPath[] = [], name?: string): VPath | null {
  const doc = need(); if (!doc) return null;
  const p: VPath = { id: pathId(), name: name ?? `Path ${doc.paths.length + 1}`, subs };
  doc.paths.push(p);
  doc.activePath = p.id;
  if (subs.length) doc.commit(`New path`); else doc.touch('meta');
  return p;
}

export function selectPath(id: string | null) {
  const doc = app.doc; if (!doc) return;
  doc.activePath = id;
  doc.touch('meta');
}

export function renamePath(id: string, name: string) {
  const doc = need(); const p = doc?.paths.find((x) => x.id === id); if (!doc || !p) return;
  p.name = name;
  doc.commit('Rename path');
}

export function deletePath(id = app.doc?.activePath) {
  const doc = need(); if (!doc || !id) return;
  doc.paths = doc.paths.filter((p) => p.id !== id);
  if (doc.activePath === id) doc.activePath = doc.paths[doc.paths.length - 1]?.id ?? null;
  doc.commit('Delete path');
}

function needPath(doc: Doc): VPath | null {
  const p = doc.path;
  if (!p || !p.subs.some((s) => s.pts.length > 1)) { toast('Draw a path with the Paths tool (P) first.'); return null; }
  return p;
}

/** Fills the active path on the current layer with the foreground colour. */
export function fillPath() {
  const doc = need(); if (!doc) return;
  const path = needPath(doc); if (!path) return;
  const pt = needTarget(doc, 'fill'); if (!pt) return;
  doc.ensureCovers(pt.target);
  const color = pt.isMask ? '#ffffff' : app.fg;
  doc.editPixels(pt.target, pt.isMask ? 'Fill path on mask' : 'Fill path', (ctx) => {
    setT(ctx, invert(xformMatrix(pt.target.t)));
    ctx.fillStyle = color;
    ctx.fill(toPath2D(path), 'evenodd');
  });
  if (!pt.isMask) app.useColor(app.fg);
}

/**
 * Strokes the active path on the current layer: 'brush' paints along it with the Brush's settings (tip, size,
 * pressure tapering off), 'line' draws a plain line `width` pixels wide in the foreground colour.
 */
export function strokePath(mode: 'brush' | 'line', width = 4) {
  const doc = need(); if (!doc) return;
  const path = needPath(doc); if (!path) return;
  const pt = needTarget(doc, 'paint'); if (!pt) return;
  if (mode === 'line') {
    doc.ensureCovers(pt.target);
    doc.editPixels(pt.target, 'Stroke path', (ctx) => {
      setT(ctx, invert(xformMatrix(pt.target.t)));
      ctx.strokeStyle = pt.isMask ? '#ffffff' : app.fg;
      ctx.lineWidth = width;
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.stroke(toPath2D(path));
    });
    return;
  }
  const o = app.opts.brush;
  const s = new Stroke(doc, pt.target, {
    color: pt.isMask ? '#ffffff' : app.fg, size: o.size, hardness: o.hardness, opacity: o.opacity, flow: o.flow, erase: false, pressure: false,
    aliased: !o.antiAlias, tip: o.tip, spacing: o.spacing / 100, jitter: o.jitter, scatter: o.scatter,
  });
  for (const sub of path.subs) {
    for (const q of flattenSub(sub, 1)) s.add({ x: q.x, y: q.y, pressure: 1 });
    s.lift();
  }
  s.end('Stroke path');
  if (!pt.isMask) app.useColor(app.fg);
}

/** The active path as a selection (inside = selected; overlapping parts cancel out, like holes in letters). */
export function pathToSelection(mode: SelMode = 'replace') {
  const doc = need(); if (!doc) return;
  const path = needPath(doc); if (!path) return;
  const c = newCanvas(doc.width, doc.height);
  const x = ctx2d(c);
  x.fillStyle = '#fff';
  x.fill(toPath2D(path), 'evenodd');
  if (!app.opts.select.antiAlias) { const h = glops.hardEdge(c); if (h) { x.globalCompositeOperation = 'copy'; x.drawImage(h, 0, 0); } }
  doc.setSelection(combine(doc, c, mode));
  doc.commit('Path to selection');
}

/** Traces the selection's edge into a new path. */
export function selectionToPath() {
  const doc = need(); if (!doc) return;
  const m = doc.selectionMask();
  if (!m) { toast('Make a selection first.'); return; }
  const subs = maskToSubs(m);
  if (!subs.length) { toast('The selection is too small to trace.'); return; }
  newPath(subs, 'Path from selection');
}

/** The selected shape layer's outline as a new path (in document coordinates). */
/** A shape layer's outline as paths, in document coordinates. */
function shapeOutline(l: ShapeLayer): SubPath[] {
  const s = l.shape;
  let subs: SubPath[];
  if (s.kind === 'path') subs = s.subs ?? [];
  else if (s.kind === 'line') subs = [polySub([{ x: 0, y: 0 }, { x: s.w, y: s.h }], false)];
  else {
    const x = Math.min(0, s.w), y = Math.min(0, s.h), w = Math.abs(s.w), h = Math.abs(s.h);
    if (s.kind === 'ellipse') subs = [ellipseSub(x + w / 2, y + h / 2, w / 2, h / 2)];
    else if (s.kind === 'polygon' || s.kind === 'star') subs = [polySub(shapePoints(s))];
    else subs = [s.radius > 0 ? roundRectSub(x, y, w, h, Math.min(s.radius, w / 2, h / 2)) : rectSub(x, y, w, h)];
  }
  const m = layerMatrix(l);
  return mapSubs(subs, (px, py) => apply(m, px, py));
}

export function shapeToPath() {
  const doc = need(); const l = doc?.active;
  if (!doc || l?.type !== 'shape') { toast('Select a shape layer first.'); return; }
  newPath(shapeOutline(l), `${l.name} path`);
}

// ---------- 3D layers ----------

/**
 * Layer › 3D › Inflate, Extrude or Revolve: makes a 3D layer from the active layer (image, text or shape). Its
 * picture, as it looks on the canvas without layer styles, becomes the 3D object's front and silhouette (for
 * Revolve, its profile); the original is kept, hidden.
 */
export function make3D(kind: Model3D['kind'] = 'inflate') {
  const doc = need(); const l = doc?.activePlaced;
  if (!doc || !l) { toast('Select an image, text or shape layer to make 3D.'); return; }
  if (l.type === 'raster' && l.model) { toast('This is already a 3D layer: change it in Properties › 3D.'); return; }
  const b = roundOut(doc.layerBounds(l));
  if (b.w * b.h > 6000 * 6000) { toast('That layer is too big to make 3D. Scale it down first.'); return; }
  const c = newCanvas(Math.max(1, b.w), Math.max(1, b.h));
  renderDoc(doc, c, [1, 0, 0, 1, -b.x, -b.y], { layers: [{ ...l, visible: true, opacity: 1, blend: 'normal', mask: null, clip: false, styles: null, blendIf: null }], includeHidden: true, clip: false });
  const r = alphaBox(ctx2d(c, true).getImageData(0, 0, c.width, c.height).data, c.width, c.height);
  if (!r) { toast('That layer is empty, so there\'s nothing to make 3D.'); return; }
  const pic = newCanvas(r.w, r.h);
  ctx2d(pic).drawImage(c, -r.x, -r.y);
  const layer: RasterLayer = {
    id: newId(), type: 'raster', name: `${l.name} 3D`, visible: true, opacity: l.opacity, blend: l.blend,
    key: doc.addCanvas(pic), t: { x: b.x + r.x, y: b.y + r.y, sx: 1, sy: 1, rot: 0 }, model: defaultModel(kind),
  };
  doc.insertLayer(layer, l.id);
  setLayerProp(l.id, { visible: false });
  doc.setActive(layer.id);
  doc.commit(kind === 'extrude' ? 'Extrude' : kind === 'revolve' ? 'Revolve' : 'Inflate');
}

/** Changes the active 3D layer's settings; `label` records it as a step (otherwise it's a live preview). */
export function setModel(patch: Partial<Model3D>, label?: string) {
  const doc = need(); const l = doc?.activeRaster;
  if (!doc || !l?.model) return;
  l.model = { ...l.model, ...patch };
  if (label) doc.commit(label); else doc.touch('meta');
}

/** Bakes the active 3D layer, as it looks now, into ordinary pixels you can paint on. */
export function rasterize3D() {
  const doc = need(); const l = doc?.activeRaster;
  if (!doc || !l?.model) return;
  const r = renderModel(doc.canvasOf(l), l.model, l.key, 1);
  if (!r) { toast('3D needs WebGL2, which isn\'t available here.', 'error'); return; }
  const p = apply(layerMatrix(l), r.box.x, r.box.y);
  // The render may be at a slightly different size from its box; keep the box's size on the canvas.
  const k = r.box.w / r.canvas.width;
  l.key = doc.addCanvas(cloneCanvas(r.canvas));
  l.t = { ...l.t, x: p.x, y: p.y, sx: l.t.sx * k, sy: l.t.sy * k };
  l.model = null;
  doc.commit('Rasterize 3D');
}

// ---------- depth ----------

/**
 * Layer › Depth › New Depth Layer: a depth layer the size of the canvas, started as level ground (black, far, at the
 * top; white, near, at the bottom), to paint over in greys.
 */
export function newDepthLayer() {
  const doc = need(); if (!doc) return;
  const l = doc.newRasterLayer(doc.nextName('Depth'));
  const x = ctx2d(doc.canvasOf(l));
  const g = x.createLinearGradient(0, 0, 0, doc.height);
  g.addColorStop(0, '#000'); g.addColorStop(1, '#fff');
  x.fillStyle = g;
  x.fillRect(0, 0, doc.width, doc.height);
  l.depth = true;
  doc.insertLayer(l);
  doc.commit('New depth layer');
  toast('Depth layer: white is near, black is far. Paint on it in greys; the canvas shows the depth map while it\'s selected.');
}

/** Layer › Depth › Use as Depth Map: the active image layer becomes a depth layer (or goes back to a picture). */
export function toggleDepthLayer() {
  const doc = need(); const l = doc?.activeRaster;
  if (!doc || !l) { toast('Select an image layer to use as a depth map.'); return; }
  if (l.model) { toast('A 3D layer can\'t be a depth map. Use Layer › Depth › Depth from 3D.'); return; }
  l.depth = !l.depth;
  doc.commit(l.depth ? 'Use as depth map' : 'Stop using as depth map');
}

/** Layer › Depth › Depth from 3D: a depth layer from the active 3D layer as it's turned now (nearest point white). */
export function depthFrom3D() {
  const doc = need(); const l = doc?.activeRaster;
  if (!doc || !l?.model) { toast('Select a 3D layer first.'); return; }
  const r = renderModel(doc.canvasOf(l), l.model, l.key, 1, true);
  if (!r) { toast('3D needs WebGL2, which isn\'t available here.', 'error'); return; }
  const p = apply(layerMatrix(l), r.box.x, r.box.y);
  const k = r.box.w / r.canvas.width;
  const layer: RasterLayer = {
    id: newId(), type: 'raster', name: `${l.name} depth`, visible: true, opacity: 1, blend: 'normal',
    key: doc.addCanvas(cloneCanvas(r.canvas)), t: { ...l.t, x: p.x, y: p.y, sx: l.t.sx * k, sy: l.t.sy * k }, depth: true,
  };
  doc.insertLayer(layer, l.id);
  doc.setActive(layer.id);
  doc.commit('Depth from 3D');
}

/**
 * Type › Text to Outlines: the active text layer's letters, from the font file, become an outline shape you can
 * reshape point by point with the Paths tool. Its colour, styles, mask, transform and warp come along; the text
 * layer is kept, hidden, in case you want to edit the words again.
 */
export async function textToOutlines() {
  const doc = need(); const l = doc?.active;
  if (!doc || l?.type !== 'text') { toast('Select a text layer to turn into outlines.'); return; }
  if (l.text.onPath) { toast('Text on a path can\'t be turned into outlines yet.'); return; }
  const font = await loadFont(l.text.font, l.text.weight, l.text.italic);
  if (!app.docs.includes(doc)) return;
  if (!font) { toast(`Couldn't read the font file for "${l.text.font}" (it may not be installed, or it's a font collection that can't be read).`, 'error'); return; }
  const subs = outlineText(l.text, font);
  if (!subs.length) { toast('There are no letters to outline.'); return; }
  const copy = cloneLayer(doc, l) as Layer as ShapeLayer & { text?: unknown };
  delete copy.text;
  copy.type = 'shape';
  copy.name = `${l.name} (outlines)`;
  copy.shape = { kind: 'path', subs, w: 0, h: 0, fill: l.text.color, stroke: null, strokeWidth: 2, radius: 0, antiAlias: l.text.antiAlias !== false };
  doc.insertLayer(copy, l.id);
  setLayerProp(l.id, { visible: false });
  doc.setActive(copy.id);
  doc.commit('Text to outlines');
}

/**
 * Layer › Fit into Shape: bends the active layer to fill a shape, like Illustrator's envelope "Make with Top Object".
 * The shape is another selected shape layer (which is then hidden), or else the active path. Text and shapes stay
 * editable; an image layer gets an editable mesh warp.
 */
export async function fitIntoShape() {
  const doc = need(); if (!doc) return;
  // Two layers selected and one is a shape: like Illustrator, the upper shape is the container, the other is fitted.
  const sel = doc.selectedIds().map((id) => doc.layer(id)).filter(isPlaced);
  let target = doc.activePlaced;
  let container: ShapeLayer | null = null;
  if (sel.length === 2) {
    const shapes = sel.filter((l): l is ShapeLayer => l.type === 'shape');
    if (shapes.length) { container = shapes[shapes.length - 1]; target = sel.find((l) => l !== container)!; }
  }
  if (!target) { toast('Select the layer to fit, then a shape layer (Ctrl+click) or a path to fit it into.'); return; }
  const outline = container ? shapeOutline(container).find((s) => s.closed) : doc.path?.subs.find((s) => s.closed && s.pts.length > 2);
  if (!outline) { toast('Draw a closed path with the Paths tool, or select a shape layer along with this one (Ctrl+click), to fit it into.'); return; }
  doc.setActive(target.id);
  const s = await beginEnvelope();
  if (!s) return;
  // The outline in the layer's own pixels (after an image layer has been trimmed).
  const inv = invert(layerMatrix(target));
  const fit = shapeFit(flattenSub(outline, 2).map((p) => apply(inv, p.x, p.y)));
  if (!fit) { finishEnvelope(s, false); toast('That shape is too small to fit into.'); return; }
  previewEnvelope(s, { style: 'shape', bend: 0, hDistort: 0, vDistort: 0, vertical: false, fit });
  if (container) setLayerProp(container.id, { visible: false });
  finishEnvelope(s, true, 'Fit into shape');
}

function roundRectSub(x: number, y: number, w: number, h: number, r: number): SubPath {
  const k = r * 0.5523;
  const P = (px: number, py: number, ix: number, iy: number, ox: number, oy: number): PathPoint => ({ x: px, y: py, ix, iy, ox, oy });
  return {
    closed: true, pts: [
      P(x + r, y, x + r - k, y, x + r, y), P(x + w - r, y, x + w - r, y, x + w - r + k, y),
      P(x + w, y + r, x + w, y + r - k, x + w, y + r), P(x + w, y + h - r, x + w, y + h - r, x + w, y + h - r + k),
      P(x + w - r, y + h, x + w - r + k, y + h, x + w - r, y + h), P(x + r, y + h, x + r, y + h, x + r - k, y + h),
      P(x, y + h - r, x, y + h - r + k, x, y + h - r), P(x, y + r, x, y + r, x, y + r - k),
    ],
  };
}

/** A new text layer that runs along the active path (its first part). Edit the words with the Text tool. */
export function textOnPath() {
  const doc = need(); if (!doc) return;
  const path = needPath(doc); if (!path) return;
  const sub = path.subs.find((s) => s.pts.length > 1)!;
  const o = app.opts.text;
  const l: TextLayer = {
    id: newId(), type: 'text', name: 'Text on path', visible: true, opacity: 1, blend: 'normal',
    t: { x: 0, y: 0, sx: 1, sy: 1, rot: 0 },
    text: {
      content: 'Text on a path', font: o.font, size: o.size, weight: o.weight, italic: o.italic, color: app.fg, align: o.align,
      lineHeight: 1.2, tracking: 0, onPath: { sub: structuredClone(sub), offset: 0 }, ...(o.antiAlias ? {} : { antiAlias: false }),
    },
  };
  doc.insertLayer(l);
  doc.commit('Text on path');
  app.setTool('text');
  toast('Click the text with the Text tool to change the words. Move it along the path with the "Start" slider in Properties.');
}

// ---------- animation ----------

const frameId = () => `f${Math.random().toString(36).slice(2, 9)}`;

/**
 * Starts an animation. 'loop': frames that all show the same layers, for animated effects. 'layers': one frame per
 * top-level layer (bottom first), each showing just that layer, plus the bottom one as a background if `keepBottom`.
 */
export function createAnimation(kind: 'loop' | 'layers', o: { frames?: number; fps?: number; keepBottom?: boolean } = {}) {
  const doc = need(); if (!doc) return;
  const fps = o.fps ?? 12;
  let frames: AnimFrame[];
  if (kind === 'loop') frames = Array.from({ length: o.frames ?? 24 }, () => ({ id: frameId(), vis: {} }));
  else {
    const content = doc.layers.filter((l) => !isFilter(l));
    if (content.length < 2) { toast('Add at least two layers to make frames from them.'); return; }
    const bottom = o.keepBottom ? content[0] : null;
    const frameLayers = content.filter((l) => l !== bottom);
    frames = frameLayers.map((show) => ({ id: frameId(), vis: Object.fromEntries(frameLayers.map((l) => [l.id, l === show])) }));
  }
  doc.anim = { fps, frames, loop: true };
  doc.frame = 0;
  doc.commit(kind === 'loop' ? 'Make animation loop' : 'Make frames from layers');
  if (!app.prefs.dock.timeline) app.setPrefs({ dock: { ...app.prefs.dock, timeline: true } });
}

export function removeAnimation() {
  const doc = need(); if (!doc?.anim) return;
  doc.anim = null;
  doc.frame = 0;
  doc.commit('Remove animation');
}

/** Shows a frame (not an undo step). */
export function goToFrame(i: number) {
  const doc = app.doc; if (!doc?.anim) return;
  const n = doc.anim.frames.length;
  doc.frame = ((i % n) + n) % n;
  doc.touch('meta');
  app.emit('frame');
}

/** Adds a copy of the current frame right after it. */
export function duplicateFrame() {
  const doc = need(); const a = doc?.anim; if (!doc || !a) return;
  const cur = a.frames[doc.frame];
  a.frames.splice(doc.frame + 1, 0, { id: frameId(), vis: { ...cur.vis }, ms: cur.ms });
  doc.frame++;
  doc.commit('Add frame');
}

export function deleteFrame() {
  const doc = need(); const a = doc?.anim; if (!doc || !a) return;
  if (a.frames.length <= 1) { removeAnimation(); return; }
  a.frames.splice(doc.frame, 1);
  doc.frame = Math.min(doc.frame, a.frames.length - 1);
  doc.commit('Delete frame');
}

export function moveFrame(from: number, to: number) {
  const doc = need(); const a = doc?.anim; if (!doc || !a || from === to) return;
  const [f] = a.frames.splice(from, 1);
  a.frames.splice(to, 0, f);
  doc.frame = to;
  doc.commit('Reorder frames');
}

export function setAnim(patch: Partial<Pick<Anim, 'fps' | 'loop'>>, label: string) {
  const doc = need(); if (!doc?.anim) return;
  Object.assign(doc.anim, patch);
  doc.commit(label);
}

/** A frame's own length in milliseconds, or undefined to follow the frame rate. */
export function setFrameMs(i: number, ms: number | undefined) {
  const doc = need(); const f = doc?.anim?.frames[i]; if (!doc || !f) return;
  if (ms === undefined) delete f.ms; else f.ms = ms;
  doc.commit('Frame length');
}

/** Moves a layer into `list` (the document's or a group's children) at `index`. */
export function moveLayer(id: string, list: Layer[], index: number) {
  const doc = need(); const l = doc?.layer(id); if (!doc || !l) return;
  if (l.type === 'group' && (l.children === list || flatLayers(l.children).some((x) => x.type === 'group' && x.children === list))) return;
  doc.moveLayerTo(id, list, index);
  doc.commit('Reorder layers');
}

export function arrange(dir: 'up' | 'down' | 'top' | 'bottom') {
  const doc = need(); const id = doc?.activeId; if (!doc || !id) return;
  const at = doc.locate(id)!;
  const i = at.index, n = at.list.length;
  const to = dir === 'up' ? i + 2 : dir === 'down' ? i - 1 : dir === 'top' ? n : 0;
  if ((dir === 'up' && i >= n - 1) || (dir === 'down' && i <= 0)) return;
  moveLayer(id, at.list, to);
}

export function toggleClip() {
  const doc = need(); const l = doc?.active; if (!doc || !l) return;
  const at = doc.locate(l.id)!;
  if (!l.clip && at.index === 0) { toast('A clipping mask needs a layer below it to clip to.'); return; }
  l.clip = !l.clip;
  doc.commit(l.clip ? 'Create clipping mask' : 'Release clipping mask');
}

function rasterOf(doc: Doc, layers: Layer[], rect: Rect): HTMLCanvasElement {
  const c = newCanvas(rect.w, rect.h);
  renderDoc(doc, c, [1, 0, 0, 1, -rect.x, -rect.y], { layers, includeHidden: true, clip: false });
  return c;
}

const fullRect = (doc: Doc): Rect => ({ x: 0, y: 0, w: doc.width, h: doc.height });

/** Turns text, a shape or a whole group into plain pixels (keeping its mask, clipping and blend). */
export function rasterizeLayer() {
  const doc = need(); const l = doc?.active;
  if (!doc || !l || l.type === 'raster' || isFilter(l)) { toast('Select a text, shape or group layer to rasterize.'); return; }
  const b = l.type === 'group' ? fullRect(doc) : roundOut(doc.layerBounds(l));
  const c = rasterOf(doc, [{ ...l, opacity: 1, blend: l.type === 'group' ? 'pass-through' : 'normal', visible: true, mask: null, clip: false } as Layer], b);
  const r: RasterLayer = {
    id: l.id, type: 'raster', name: l.name, visible: l.visible, opacity: l.opacity, blend: l.blend === 'pass-through' ? 'normal' : l.blend,
    clip: l.clip, mask: l.mask, key: doc.addCanvas(c), t: { x: b.x, y: b.y, sx: 1, sy: 1, rot: 0 },
  };
  const at = doc.locate(l.id)!;
  at.list[at.index] = r;
  doc.commit(l.type === 'group' ? 'Merge group' : 'Rasterize');
}

export function mergeDown() {
  const doc = need(); const l = doc?.active; if (!doc || !l) return;
  const at = doc.locate(l.id)!;
  const below = at.list[at.index - 1];
  if (!below) { toast('There is no layer below to merge into.'); return; }
  if (isFilter(below)) { toast("Can't merge into an adjustment or effect layer."); return; }
  const c = rasterOf(doc, [{ ...below, opacity: 1, blend: below.type === 'group' ? 'pass-through' : 'normal', visible: true, clip: false } as Layer, { ...l, visible: true }], fullRect(doc));
  const merged: RasterLayer = {
    id: below.id, type: 'raster', name: below.name, visible: below.visible, opacity: below.opacity,
    blend: below.blend === 'pass-through' ? 'normal' : below.blend, clip: below.clip, key: doc.addCanvas(c), t: { x: 0, y: 0, sx: 1, sy: 1, rot: 0 },
  };
  at.list.splice(at.index - 1, 2, merged);
  doc.setActive(merged.id);
  doc.commit('Merge down');
}

export function flattenImage() {
  const doc = need(); if (!doc) return;
  const c = flatten(doc);
  const l: RasterLayer = { id: newId(), type: 'raster', name: 'Background', visible: true, opacity: 1, blend: 'normal', key: doc.addCanvas(c), t: { x: 0, y: 0, sx: 1, sy: 1, rot: 0 } };
  doc.layers = [l];
  doc.setActive(l.id);
  doc.commit('Flatten image');
}

/** Changes a placed layer's transform; a mask on the layer moves with it. */
export function setPlacedTransform(l: PlacedLayer, t: Xform) {
  if (l.mask) l.mask.t = follow(l.mask.t, layerMatrix(l), t);
  l.t = t;
}

/** Sets a layer's transform so the local point `lp` lands on document point `dp`. */
function placeAt(t: Xform, lp: Pt, dp: Pt): Xform {
  const off = apply(xformMatrix({ ...t, x: 0, y: 0 }), lp.x, lp.y);
  return { ...t, rot: tidy(t.rot), x: tidy(dp.x - off.x), y: tidy(dp.y - off.y) };
}

function aboutCenter(label: string, f: (t: Xform) => Xform) {
  const doc = need(); const l = doc?.activePlaced;
  if (!doc || !l) { toast('Select an image, text or shape layer first.'); return; }
  const b = localBounds(l, doc.pool);
  const lc = { x: b.x + b.w / 2, y: b.y + b.h / 2 };
  const dc = apply(layerMatrix(l), lc.x, lc.y);
  setPlacedTransform(l, placeAt(f(l.t), lc, dc));
  doc.commit(label);
}

export const flipLayer = (axis: 'h' | 'v') => aboutCenter(axis === 'h' ? 'Flip horizontal' : 'Flip vertical', (t) => (axis === 'h' ? { ...t, sx: -t.sx } : { ...t, sy: -t.sy }));
export const rotateLayer90 = (dir: 1 | -1) => aboutCenter('Rotate 90°', (t) => ({ ...t, rot: t.rot + (dir * Math.PI) / 2 }));
export const resetTransform = () => aboutCenter('Reset transform', (t) => ({ ...t, sx: 1, sy: 1, rot: 0 }));

// ---------- whole-document transforms (all lossless) ----------

export function transformDoc(label: string, g: Mat, w: number, h: number, scaleShapes?: [number, number]) {
  const doc = need(); if (!doc) return;
  for (const l of doc.all()) {
    if (l.mask) l.mask.t = decompose(mul(g, xformMatrix(l.mask.t)));
    if (!isPlaced(l)) continue;
    if (l.type === 'shape' && scaleShapes) {
      const [kx, ky] = scaleShapes;
      l.shape = { ...l.shape, w: l.shape.w * kx, h: l.shape.h * ky, strokeWidth: l.shape.strokeWidth * Math.sqrt(Math.abs(kx * ky)), radius: l.shape.radius * Math.sqrt(Math.abs(kx * ky)),
        // An outline's points scale along with it.
        subs: l.shape.subs && mapSubs(l.shape.subs, (x, y) => ({ x: x * kx, y: y * ky })) };
      const p = apply(g, l.t.x, l.t.y);
      l.t = { ...l.t, x: p.x, y: p.y };
      continue;
    }
    l.t = decompose(mul(g, xformMatrix(l.t)));
  }
  // Pixel-based selections and Quick Mask are images: redraw them through the transform at the new size.
  const remap = (c: HTMLCanvasElement) => {
    const out = newCanvas(w, h);
    const x = ctx2d(out);
    setT(x, g);
    x.drawImage(c, 0, 0);
    return out;
  };
  if (doc.selection?.ops.some((o) => o.shape === 'mask')) doc.setSelection(maskSelection(remap(doc.selectionMask()!), (c) => doc.addCanvas(c)));
  else doc.setSelection(mapSel(doc.selection, (x, y) => { const p = apply(g, x, y); return [p.x, p.y]; }));
  if (doc.quickMask) doc.quickMask = doc.addCanvas(remap(doc.pool.get(doc.quickMask)!));
  doc.paths = doc.paths.map((p) => ({ ...p, subs: mapSubs(p.subs, (x, y) => apply(g, x, y)) }));
  // Guides are lines: map two points on each; a rotation can turn vertical guides horizontal.
  doc.guides = doc.guides.map((gd) => {
    const a = gd.axis === 'x' ? apply(g, gd.pos, 0) : apply(g, 0, gd.pos);
    const b = gd.axis === 'x' ? apply(g, gd.pos, 1) : apply(g, 1, gd.pos);
    return Math.abs(a.x - b.x) < 1e-6 ? { axis: 'x' as const, pos: tidy(a.x) } : { axis: 'y' as const, pos: tidy(a.y) };
  });
  doc.width = Math.max(1, Math.round(w));
  doc.height = Math.max(1, Math.round(h));
  doc.commit(label);
  view.fit();
}

export function cropTo(r: Rect) {
  transformDoc('Crop', [1, 0, 0, 1, -r.x, -r.y], r.w, r.h);
}

export function cropToSelection() {
  const doc = need(); if (!doc) return;
  const b = doc.selection && selBounds(doc.selection, doc.width, doc.height);
  if (!b) { toast('Make a selection first.'); return; }
  doc.setSelection(null);
  cropTo(b);
}

/**
 * Image › Crop to Content: trims the empty space around the image. Empty means transparent, or, when the image is
 * opaque, the colour of its top-left corner (a plain background). Uses what's visible, all layers together.
 */
export async function cropToContent() {
  const doc = need(); if (!doc) return;
  const r = await trimRect(flatten(doc));
  if (!app.docs.includes(doc)) return;
  if (!r) { toast('The image is empty, so there is nothing to crop to.'); return; }
  if (r.x === 0 && r.y === 0 && r.w === doc.width && r.h === doc.height) { toast('There is no empty space around the image.'); return; }
  cropTo(r);
  toast(`Cropped to ${r.w} × ${r.h} px.`);
}

export function resizeImage(w: number, h: number, resample?: Doc['resample']) {
  const doc = need(); if (!doc) return;
  // Part of the same undo step: the document remembers how its layers are resampled from now on.
  if (resample) doc.resample = resample;
  const kx = w / doc.width, ky = h / doc.height;
  transformDoc('Image size', [kx, 0, 0, ky, 0, 0], w, h, [kx, ky]);
}

export function resizeCanvas(w: number, h: number, ax: number, ay: number) {
  const doc = need(); if (!doc) return;
  transformDoc('Canvas size', [1, 0, 0, 1, Math.round((w - doc.width) * ax), Math.round((h - doc.height) * ay)], w, h);
}

export function rotateCanvas(deg: 90 | -90 | 180) {
  const doc = need(); if (!doc) return;
  const W = doc.width, H = doc.height;
  if (deg === 90) transformDoc('Rotate canvas 90° CW', [0, 1, -1, 0, H, 0], H, W);
  else if (deg === -90) transformDoc('Rotate canvas 90° CCW', [0, -1, 1, 0, 0, W], H, W);
  else transformDoc('Rotate canvas 180°', [-1, 0, 0, -1, W, H], W, H);
}

export function flipCanvas(axis: 'h' | 'v') {
  const doc = need(); if (!doc) return;
  const W = doc.width, H = doc.height;
  transformDoc(axis === 'h' ? 'Flip canvas horizontal' : 'Flip canvas vertical', axis === 'h' ? [-1, 0, 0, 1, W, 0] : [1, 0, 0, -1, 0, H], W, H);
}

// ---------- masks ----------

/** Adds a mask: show everything, hide everything, or show just the current selection. */
export function addMask(mode: 'reveal' | 'hide' | 'selection' = app.doc?.selection ? 'selection' : 'reveal') {
  const doc = need(); const l = doc?.active; if (!doc || !l) return;
  if (l.mask) { toast('This layer already has a mask.'); return; }
  let r = fullRect(doc);
  if (isPlaced(l)) r = roundOut(union(r, doc.layerBounds(l)));
  const c = newCanvas(r.w, r.h);
  const x = ctx2d(c);
  if (mode === 'reveal') { x.fillStyle = '#fff'; x.fillRect(0, 0, r.w, r.h); }
  else if (mode === 'selection') { const s = doc.selectionMask(); if (s) x.drawImage(s, -r.x, -r.y); }
  l.mask = { key: doc.addCanvas(c), t: { x: r.x, y: r.y, sx: 1, sy: 1, rot: 0 }, enabled: true, density: 1, feather: 0 };
  doc.maskEdit = true;
  if (mode === 'selection') doc.setSelection(null);
  doc.commit('Add layer mask');
}

export function deleteMask() {
  const doc = need(); const l = doc?.active; if (!doc || !l?.mask) return;
  l.mask = null;
  doc.maskEdit = false;
  doc.commit('Delete layer mask');
}

export function setMaskProp(patch: Partial<Pick<Mask, 'enabled' | 'density' | 'feather'>>, label?: string) {
  const doc = need(); const m = doc?.active?.mask; if (!doc || !m) return;
  Object.assign(m, patch);
  if (label) doc.commit(label); else doc.touch('meta');
}

export function invertMask() {
  const doc = need(); const m = doc?.active?.mask; if (!doc || !m) return;
  doc.editPixels(m, 'Invert mask', (ctx, c) => {
    const tmp = newCanvas(c.width, c.height);
    const t = ctx2d(tmp);
    t.fillStyle = '#fff';
    t.fillRect(0, 0, c.width, c.height);
    t.globalCompositeOperation = 'destination-out';
    t.drawImage(c, 0, 0);
    ctx.globalCompositeOperation = 'copy';
    ctx.drawImage(tmp, 0, 0);
  });
}

/** Bakes the mask into an image layer's pixels and removes it. */
export function applyMask() {
  const doc = need(); const l = doc?.active;
  if (!doc || !l?.mask) return;
  if (l.type !== 'raster') { toast('Only image layers can have their mask applied. Rasterize first.'); return; }
  const m = l.mask;
  const mc = doc.pool.get(m.key)!;
  const rel = mul(invert(layerMatrix(l)), xformMatrix(m.t));
  doc.editPixels(l, 'Apply layer mask', (ctx, c) => {
    const tmp = newCanvas(c.width, c.height);
    const t = ctx2d(tmp);
    t.save();
    setT(t, rel);
    if (m.feather > 0) t.filter = `blur(${m.feather / matScale(layerMatrix(l))}px)`;
    t.drawImage(mc, 0, 0);
    t.restore();
    if (m.density < 1) { t.fillStyle = `rgba(255,255,255,${1 - m.density})`; t.fillRect(0, 0, c.width, c.height); }
    ctx.globalCompositeOperation = 'destination-in';
    ctx.drawImage(tmp, 0, 0);
    l.mask = null;
    doc.maskEdit = false;
  });
}

// ---------- selection ----------

export function selectAll() {
  const doc = need(); if (!doc) return;
  doc.setSelection({ ops: [{ mode: 'add', shape: 'rect', pts: [0, 0, doc.width, doc.height] }] });
  doc.commit('Select all');
}

export function deselect() {
  const doc = need(); if (!doc?.selection) return;
  doc.setSelection(null);
  doc.commit('Deselect');
}

export function invertSelection() {
  const doc = need(); if (!doc) return;
  doc.setSelection(invertSel(doc.selection, doc.width, doc.height));
  doc.commit('Invert selection');
}

const MODIFY_LABEL: Record<Modify, string> = { feather: 'Feather', grow: 'Expand', shrink: 'Contract', smooth: 'Smooth', border: 'Border' };

/** Select › Modify (feather, expand, contract, smooth, border) by `r` pixels. */
export function modifySelection(kind: Modify, r: number) {
  const doc = need(); const m = doc?.selectionMask();
  if (!doc || !m) { toast('Make a selection first.'); return; }
  const sel = maskSelection(modifyMask(m, kind, r), (c) => doc.addCanvas(c));
  if (!sel) { toast('Nothing would be left selected.'); return; }
  doc.setSelection(sel);
  doc.commit(`${MODIFY_LABEL[kind]} selection`);
}

/** Magic wand at a document point. */
export async function selectSimilar(x: number, y: number, mode: SelMode) {
  const doc = need(); if (!doc) return;
  const o = app.opts.wand;
  const m = await wandMask(sampleSource(doc, o.sampleAll, doc.active), x, y, o.tolerance, o.contiguous, o.antiAlias);
  if (!m || !app.docs.includes(doc)) return;
  doc.setSelection(combine(doc, m, mode));
  doc.commit(mode === 'replace' ? 'Magic Wand' : mode === 'add' ? 'Add to selection' : 'Subtract from selection');
}

/** Colour Range: preview mask (not committed) or apply it. */
export function colorRangeSelection(src: HTMLCanvasElement, mode: number, fuzz: number, rgb: [number, number, number], how: SelMode) {
  const doc = need(); if (!doc) return;
  doc.setSelection(combine(doc, colorRangeMask(src, mode, fuzz, rgb), how));
  doc.commit('Colour Range');
}

/** Ctrl+click a layer thumbnail: select that layer's shape. */
export function selectLayerShape(id: string, mode: SelMode = 'replace') {
  const doc = need(); const l = doc?.layer(id); if (!doc || !l) return;
  if (isFilter(l)) { toast('Adjustment and effect layers have no shape to select.'); return; }
  doc.setSelection(combine(doc, layerAlphaMask(doc, l), mode));
  doc.commit('Select layer shape');
}

/**
 * Quick Mask (Q): turns the selection into a red-tinted overlay you can paint with any brush (white adds, black
 * removes), then back into a selection.
 */
export function toggleQuickMask() {
  const doc = need(); if (!doc) return;
  if (doc.quickMask) {
    const c = doc.pool.get(doc.quickMask)!;
    doc.quickMask = null;
    doc.setSelection(maskSelection(cloneCanvas(c), (k) => doc.addCanvas(k)));
    doc.commit('Exit Quick Mask');
  } else {
    const m = doc.selectionMask();
    doc.quickMask = doc.addCanvas(m ? cloneCanvas(m) : newCanvas(doc.width, doc.height));
    doc.setSelection(null);
    doc.commit('Quick Mask');
    toast('Quick Mask: paint white to select, black to deselect. Press Q again to finish.');
  }
  app.emit('tool');
}

function needTarget(doc: Doc, verb: string) {
  const pt = doc.paintTarget();
  if (pt) return pt;
  const l = doc.active;
  if (l?.type === 'raster' && l.model) { toast('This is a 3D layer. Rasterize it first (Properties › 3D › Rasterize).'); return null; }
  if (l?.type === 'raster' && l.warp) { toast('This layer is warped. Apply the warp first (Layer › Transform › Apply Warp).'); return null; }
  toast(!l ? 'Select a layer first.' : isFilter(l) || l.type === 'group'
    ? `Can't ${verb} a ${l.type === 'group' ? 'group' : l.type === 'effect' ? 'effect' : 'adjustment'} layer (add a mask to paint where it applies).`
    : `Can't ${verb} a ${l.type} layer (rasterize it first).`);
  return null;
}

/** Delete: clears the selected pixels (or hides them, on a mask). With nothing selected, deletes the layer. */
export function clearSelection() {
  const doc = need(); if (!doc) return;
  if (!doc.selection) { if (doc.active) deleteLayer(); return; }
  const pt = needTarget(doc, 'clear pixels on'); if (!pt) return;
  const mask = doc.maskForLayer(pt.target)!;
  doc.editPixels(pt.target, pt.isMask ? 'Hide in mask' : 'Clear', (ctx) => { ctx.globalCompositeOperation = 'destination-out'; ctx.drawImage(mask, 0, 0); });
}

/** Fills the selection (or everything) with a colour. On a mask, light colours reveal and dark ones hide. */
export function fillWith(which: 'fg' | 'bg') {
  const doc = need(); if (!doc) return;
  const pt = needTarget(doc, 'fill'); if (!pt) return;
  doc.ensureCovers(pt.target);
  const mask = doc.maskForLayer(pt.target);
  const color = app[which];
  const hide = pt.isMask && lumOf(color) < 0.5;
  doc.editPixels(pt.target, pt.isMask ? (hide ? 'Hide in mask' : 'Reveal in mask') : 'Fill', (ctx, c) => {
    const tmp = newCanvas(c.width, c.height);
    const t = ctx2d(tmp);
    t.fillStyle = pt.isMask ? '#fff' : color;
    t.fillRect(0, 0, c.width, c.height);
    if (mask) { t.globalCompositeOperation = 'destination-in'; t.drawImage(mask, 0, 0); }
    ctx.globalCompositeOperation = hide ? 'destination-out' : 'source-over';
    ctx.drawImage(tmp, 0, 0);
  });
  if (!pt.isMask) app.useColor(color);
}

export function lumOf(hex: string) {
  const n = parseInt(hex.slice(1), 16) || 0;
  return (((n >> 16) & 255) * 0.299 + ((n >> 8) & 255) * 0.587 + (n & 255) * 0.114) / 255;
}

// ---------- clipboard ----------

let clip: { canvas: HTMLCanvasElement; at: Pt } | null = null;

export async function copy(merged = false, cut = false) {
  const doc = need(); if (!doc) return;
  const l = doc.active;
  if (!merged && !isPlaced(l)) { toast('Select an image layer to copy from (or use Copy Merged).'); return; }
  const r = (doc.selection && selBounds(doc.selection, doc.width, doc.height)) || (merged || !l ? fullRect(doc) : roundOut(doc.layerBounds(l as PlacedLayer)));
  const c = newCanvas(r.w, r.h);
  renderDoc(doc, c, [1, 0, 0, 1, -r.x, -r.y], { layers: merged ? undefined : [{ ...(l as PlacedLayer), opacity: 1, blend: 'normal', visible: true, clip: false }], clip: merged });
  const mask = doc.selectionMask();
  if (mask) { const x = ctx2d(c); x.globalCompositeOperation = 'destination-in'; x.drawImage(mask, -r.x, -r.y); }
  clip = { canvas: c, at: { x: r.x, y: r.y } };
  try {
    const blob = await canvasBlob(c);
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
  } catch { /* system clipboard unavailable; the in-app clipboard still works */ }
  if (cut) clearSelection();
  toast(cut ? 'Cut to clipboard' : 'Copied to clipboard');
}

/** Pastes an image as a new layer (or a new document when none is open). */
export async function pasteBlob(blob: Blob | null) {
  let c: HTMLCanvasElement | null = null;
  let at: Pt | null = null;
  if (blob) {
    c = await decodeImage(blob);
    if (clip && clip.canvas.width === c.width && clip.canvas.height === c.height) at = clip.at;
  } else if (clip) {
    c = cloneCanvas(clip.canvas);
    at = clip.at;
  }
  if (!c) { toast('The clipboard has no image.'); return; }
  if (!app.doc) { app.addDoc(docFromCanvas(nextUntitled(), c)); return; }
  placeCanvas(c, 'Pasted', at);
}

export function hasInternalClip() { return !!clip; }

// ---------- layer styles & Blend If ----------

/** Edits the active layer's styles (creating them if needed). Without a label it's a live preview, not an undo step. */
export function editStyles(f: (s: LayerStyles) => void, label?: string) {
  const doc = need(); const l = doc?.active; if (!doc || !l || isFilter(l)) return;
  const s = structuredClone(l.styles ?? defaultStyles());
  f(s);
  l.styles = s;
  if (label) doc.commit(label); else doc.touch('meta');
}

export function clearStyles() {
  const doc = need(); const l = doc?.active; if (!doc || !l?.styles) return;
  l.styles = null;
  doc.commit('Clear layer styles');
}

export function editBlendIf(f: (b: BlendIf) => void, label?: string) {
  const doc = need(); const l = doc?.active; if (!doc || !l || isFilter(l)) return;
  const b: BlendIf = structuredClone(l.blendIf ?? { on: true, self: [0, 0, 255, 255], under: [0, 0, 255, 255] });
  f(b);
  l.blendIf = b;
  if (label) doc.commit(label); else doc.touch('meta');
}

// ---------- colour lookup (.cube) ----------

function pickText(accept: string): Promise<File | null> {
  return new Promise((res) => {
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = accept;
    inp.onchange = () => res(inp.files?.[0] ?? null);
    inp.click();
  });
}

/** Asks for a .cube file and loads it into the active LUT adjustment layer. */
export async function loadLut(id = app.doc?.activeId) {
  const doc = need(); const l = id ? doc?.layer(id) : null;
  if (!doc || l?.type !== 'adjust' || l.adj.kind !== 'lut') return;
  const f = await pickText('.cube,.CUBE');
  if (!f) return;
  try {
    const p = parseCube(await f.text(), baseName(f.name));
    l.adj = { ...l.adj, key: doc.addCanvas(p.canvas), name: p.name, size: p.size };
    l.name = `LUT: ${p.name}`;
    doc.commit('Load LUT');
  } catch (e) {
    toast(`Couldn't read ${f.name}: ${(e as Error).message}`, 'error');
  }
}

export async function newLut() {
  newAdjustment('lut');
  await loadLut();
}

// ---------- warp presets ----------

/** A layer as it was before a warp preset was tried on it, to put back on Cancel. */
type EnvelopeStart = { l: PlacedLayer; envelope?: Envelope | null; warp?: Warp | null; key?: string; t: Xform; box?: Rect | null };

/**
 * Starts trying warp presets on the active layer. Text and shapes keep the preset as a setting (they stay
 * editable). An image layer is first trimmed to what's on it, so the preset bends that and not empty canvas, and the
 * preset becomes a mesh warp it can be fine-tuned with (Move › Warp). Returns null if the layer can't be warped.
 */
export async function beginEnvelope(): Promise<EnvelopeStart | null> {
  const doc = need(); const l = doc?.activePlaced;
  if (!doc || !l) { toast('Select an image, text or shape layer to warp.'); return null; }
  if (l.type === 'raster' && l.model) { toast('3D layers can\'t be warped. Rasterize it first (Properties › 3D › Rasterize).'); return null; }
  const start: EnvelopeStart = { l, t: { ...l.t }, box: l.box ? { ...l.box } : l.box };
  if (l.type !== 'raster') { start.envelope = l.envelope ? { ...l.envelope } : null; return start; }
  start.warp = l.warp ? structuredClone(l.warp) : null;
  start.key = l.key;
  if (!l.warp) {
    const src = doc.pool.get(l.key)!;
    const b = roundOut(await layerBoxReady(l, doc.pool, 'content'));
    const r = intersect({ x: b.x - 2, y: b.y - 2, w: b.w + 4, h: b.h + 4 }, { x: 0, y: 0, w: src.width, h: src.height });
    if (r && (r.x > 0 || r.y > 0 || r.w < src.width || r.h < src.height)) {
      const c = newCanvas(r.w, r.h);
      ctx2d(c).drawImage(src, -r.x, -r.y);
      const p = apply(layerMatrix(l), r.x, r.y);
      l.key = doc.addCanvas(c);
      l.t = { ...l.t, x: p.x, y: p.y };
    }
  }
  return start;
}

/** Shows `e` on the layer being warped (null takes the preset off). */
export function previewEnvelope(s: EnvelopeStart, e: Envelope | null) {
  const doc = need(); if (!doc) return;
  const l = s.l;
  if (l.type === 'raster') l.warp = e ? envelopeMesh(e, rasterBox(doc, l)) : s.warp ?? null;
  else l.envelope = e ? { ...e } : null;
  doc.touch('meta');
}

export function finishEnvelope(s: EnvelopeStart, keep: boolean, label = 'Warp') {
  const doc = need(); if (!doc) return;
  const l = s.l;
  if (keep) {
    const on = l.type === 'raster' ? !!l.warp : !!l.envelope;
    doc.commit(on ? label : 'Remove warp');
    return;
  }
  l.t = s.t;
  l.box = s.box;
  if (l.type === 'raster') { l.warp = s.warp ?? null; l.key = s.key!; } else l.envelope = s.envelope ?? null;
  doc.touch('meta');
}

// ---------- warp & perspective ----------

const rasterBox = (doc: Doc, l: RasterLayer): Rect => { const c = doc.canvasOf(l); return { x: 0, y: 0, w: c.width, h: c.height }; };

/** Makes sure the active image layer has a warp of `kind` (keeping its current shape). Returns it, or null. */
export function ensureWarp(kind: Warp['kind']): RasterLayer | null {
  const doc = need(); const l = doc?.active;
  if (!doc || !l) return null;
  if (l.type !== 'raster') { toast(l.type === 'text' || l.type === 'shape' ? 'Rasterize this layer to warp it.' : 'Select an image layer to warp.'); return null; }
  if (l.model) { toast('3D layers turn with Rotate 3D instead. Rasterize it first to warp it.'); return null; }
  if (l.warp?.kind !== kind) { l.warp = initWarp(kind, rasterBox(doc, l), l.warp); doc.touch('meta'); }
  return l;
}

/** Bakes the warp into the layer's pixels (needed before painting on it). Lossless until you do this. */
export function applyWarp() {
  const doc = need(); const l = doc?.active;
  if (!doc || l?.type !== 'raster' || !l.warp) return;
  const b = roundOut(warpBounds(l.warp));
  const c = newCanvas(b.w, b.h);
  const x = ctx2d(c);
  drawPlaced(x, { ...l, t: { x: 0, y: 0, sx: 1, sy: 1, rot: 0 } }, doc.pool, [1, 0, 0, 1, -b.x, -b.y]);
  const t = decompose(mul(layerMatrix(l), [1, 0, 0, 1, b.x, b.y]));
  l.key = doc.addCanvas(c);
  l.t = t;
  l.warp = null;
  doc.commit('Apply warp');
}

export function removeWarp() {
  const doc = need(); const l = doc?.active;
  if (!doc || l?.type !== 'raster' || !l.warp) return;
  l.warp = null;
  doc.commit('Remove warp');
}

// ---------- guides ----------

export function addGuide(axis: Guide['axis'], pos: number) {
  const doc = need(); if (!doc) return;
  doc.guides = [...doc.guides, { axis, pos: Math.round(pos) }];
  doc.commit('Add guide');
}

export function clearGuides() {
  const doc = need(); if (!doc?.guides.length) return;
  doc.guides = [];
  doc.commit('Clear guides');
}

// ---------- looks (saved effect stacks) ----------

/** Drops a look onto the image as a Pass Through group above the active layer, so it affects everything below. */
export async function applyLook(look: Look) {
  const doc = need(); if (!doc) return;
  const children: Layer[] = [];
  for (const it of look.items) {
    if (it.type === 'effect') {
      const def = fxDef(it.kind);
      if (!def) continue;
      const fx = defaultFx(it.kind);
      children.push({ id: newId(), type: 'effect', name: it.name ?? def.label, visible: true, opacity: it.opacity ?? 1, blend: it.blend ?? 'normal',
        fx: { ...fx, seed: it.seed ?? fx.seed, v: { ...fx.v, ...(it.v ?? {}) } } });
    } else {
      const kind = it.kind as AdjKind;
      const adj = { ...defaultAdj(kind), ...(it.adj ?? {}) } as AdjParams;
      if (adj.kind === 'lut' && it.lutData) {
        const blob = await (await fetch(it.lutData)).blob();
        adj.key = doc.addCanvas(await decodeImage(blob));
      }
      children.push({ id: newId(), type: 'adjust', name: it.name ?? ADJ_LABELS[kind], visible: true, opacity: it.opacity ?? 1, blend: it.blend ?? 'normal', adj });
    }
  }
  if (!children.length) return;
  doc.insertLayer({ id: newId(), type: 'group', name: `Look: ${look.name}`, visible: true, opacity: 1, blend: 'pass-through', children, open: false });
  doc.commit(`Apply look: ${look.name}`);
}

/** The effect/adjustment layers a look would be saved from: the active group's, or the run around the active one. */
export function lookSourceLayers(): Layer[] {
  const doc = need(); const l = doc?.active; if (!doc || !l) return [];
  if (l.type === 'group') return l.children.filter(isFilter);
  if (!isFilter(l)) return [];
  const at = doc.locate(l.id)!;
  let a = at.index, b = at.index;
  while (a > 0 && isFilter(at.list[a - 1])) a--;
  while (b < at.list.length - 1 && isFilter(at.list[b + 1])) b++;
  return at.list.slice(a, b + 1);
}

export async function saveLook(name: string) {
  const doc = need(); if (!doc) return false;
  const src = lookSourceLayers();
  if (!src.length) { toast('Select an effect/adjustment layer, or a group of them, to save as a look.'); return false; }
  const items: LookItem[] = [];
  for (const l of src) {
    if (l.type === 'effect') items.push({ type: 'effect', kind: l.fx.kind, name: l.name, v: { ...l.fx.v }, seed: l.fx.seed, opacity: l.opacity, blend: l.blend });
    else if (l.type === 'adjust') {
      const it: LookItem = { type: 'adjust', kind: l.adj.kind, name: l.name, adj: structuredClone(l.adj), opacity: l.opacity, blend: l.blend };
      if (l.adj.kind === 'lut' && l.adj.key) {
        it.lutData = doc.pool.get(l.adj.key)?.toDataURL('image/png');
        it.adj = { ...l.adj, key: null };
      }
      items.push(it);
    }
  }
  const list = savedLooks().filter((x) => x.name !== name);
  list.push({ name, items });
  if (!storeLooks(list)) { toast('Could not save the look (storage is full).', 'error'); return false; }
  toast(`Saved look "${name}"`);
  return true;
}

export function deleteLook(name: string) {
  storeLooks(savedLooks().filter((x) => x.name !== name));
}
