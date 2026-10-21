import { app } from './app';
import { defaultAdj, ADJ_LABELS } from './core/adjustments';
import { Doc, newId } from './core/document';
import { baseName, canvasBlob, decodeImage, decodePixl, docFromCanvas, encodePixl, extOf, PIXL_ACCEPT, saveBlob } from './core/fileio';
import { cloneCanvas, ctx2d, layerMatrix, localBounds, newCanvas } from './core/layers';
import { apply, mul, roundOut, tidy, xformMatrix, type Mat, type Pt, type Rect, type Xform } from './core/math';
import { flatten, renderDoc } from './core/render';
import { invertSel, mapSel, selBounds } from './core/selection';
import type { AdjKind, Layer, PlacedLayer, RasterLayer } from './core/types';
import { isPlaced } from './core/types';
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

export async function openFiles(files: { file: File; handle: FileSystemFileHandle | null }[]) {
  for (const { file, handle } of files) {
    try {
      if (extOf(file.name) === 'pixl') {
        const doc = await decodePixl(file, baseName(file.name));
        doc.name = file.name;
        doc.fileHandle = handle;
        app.addDoc(doc);
      } else {
        const c = await decodeImage(file);
        app.addDoc(docFromCanvas(file.name, c));
      }
    } catch (e) {
      console.error(e);
      toast(`Couldn't open ${file.name}: ${(e as Error).message || 'unsupported file'}`, 'error');
    }
  }
}

/** Adds images to the current document as new layers, centred (scaled down to fit if larger). */
export async function placeFiles(files: File[]) {
  const doc = need();
  if (!doc) return openFiles(files.map((f) => ({ file: f, handle: null })));
  for (const f of files) {
    try {
      if (extOf(f.name) === 'pixl') { await openFiles([{ file: f, handle: null }]); continue; }
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
  const handle = !saveAs && isPixl ? doc.fileHandle : null;
  try {
    const blob = await encodePixl(doc);
    const h = await saveBlob(blob, `${baseName(doc.name)}.pixl`, handle, PIXL_ACCEPT);
    if (h === undefined) return false;
    doc.fileHandle = h;
    if (h) doc.name = h.name;
    else if (!isPixl) doc.name = `${baseName(doc.name)}.pixl`;
    doc.savedIndex = doc.index;
    app.emit('docs');
    toast(`Saved ${doc.name}`);
    return true;
  } catch (e) {
    toast(`Save failed: ${(e as Error).message}`, 'error');
    return false;
  }
}

export async function exportImage(doc: Doc, o: { format: 'png' | 'jpeg' | 'webp'; quality: number; scale: number }) {
  let c = flatten(doc, o.scale);
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
  const h = await saveBlob(blob, `${baseName(doc.name)}.${ext}`, null, accept);
  if (h !== undefined) toast(`Exported ${c.width} × ${c.height} ${ext.toUpperCase()} (${(blob.size / 1024 / 1024).toFixed(2)} MB)`);
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

export function duplicateLayer() {
  const doc = need(); const l = doc?.active; if (!doc || !l) return;
  const copy = structuredClone(l) as Layer;
  copy.id = newId();
  copy.name = `${l.name} copy`;
  if (copy.type === 'raster') copy.key = doc.addCanvas(cloneCanvas(doc.canvasOf(copy)));
  doc.insertLayer(copy, l.id);
  doc.commit('Duplicate layer');
}

export function deleteLayer(id = app.doc?.activeId) {
  const doc = need(); if (!doc || !id) return;
  doc.removeLayer(id);
  doc.commit('Delete layer');
}

export function setLayerProp(id: string, patch: Partial<Pick<Layer, 'name' | 'visible' | 'opacity' | 'blend'>>, label?: string) {
  const doc = need(); const l = doc?.layer(id); if (!doc || !l) return;
  Object.assign(l, patch);
  if (label) doc.commit(label); else doc.touch('meta');
}

export function moveLayer(id: string, toIndex: number) {
  const doc = need(); if (!doc) return;
  const i = doc.indexOf(id);
  if (i < 0) return;
  const [l] = doc.layers.splice(i, 1);
  doc.layers.splice(Math.max(0, Math.min(doc.layers.length, toIndex)), 0, l);
  doc.commit('Reorder layers');
}

export function arrange(dir: 'up' | 'down' | 'top' | 'bottom') {
  const doc = need(); const id = doc?.activeId; if (!doc || !id) return;
  const i = doc.indexOf(id);
  const to = dir === 'up' ? i + 1 : dir === 'down' ? i - 1 : dir === 'top' ? doc.layers.length - 1 : 0;
  if (to === i || to < 0 || to >= doc.layers.length) return;
  moveLayer(id, to);
}

function rasterOf(doc: Doc, layers: Layer[], rect: Rect): HTMLCanvasElement {
  const c = newCanvas(rect.w, rect.h);
  renderDoc(doc, c, [1, 0, 0, 1, -rect.x, -rect.y], { layers, includeHidden: true, clip: false });
  return c;
}

export function rasterizeLayer() {
  const doc = need(); const l = doc?.active;
  if (!doc || !l || l.type === 'raster' || l.type === 'adjust') { toast('Select a text or shape layer to rasterize.'); return; }
  const b = roundOut(doc.layerBounds(l));
  const c = rasterOf(doc, [{ ...l, opacity: 1, blend: 'normal', visible: true }], b);
  const r: RasterLayer = { id: l.id, type: 'raster', name: l.name, visible: l.visible, opacity: l.opacity, blend: l.blend, key: doc.addCanvas(c), t: { x: b.x, y: b.y, sx: 1, sy: 1, rot: 0 } };
  doc.layers[doc.indexOf(l.id)] = r;
  doc.commit('Rasterize');
}

export function mergeDown() {
  const doc = need(); const l = doc?.active; if (!doc || !l) return;
  const i = doc.indexOf(l.id);
  const below = doc.layers[i - 1];
  if (!below) { toast('There is no layer below to merge into.'); return; }
  if (below.type === 'adjust') { toast("Can't merge into an adjustment layer."); return; }
  const full = { x: 0, y: 0, w: doc.width, h: doc.height };
  const c = rasterOf(doc, [{ ...below, opacity: 1, blend: 'normal', visible: true }, { ...l, visible: true }], full);
  const merged: RasterLayer = { id: below.id, type: 'raster', name: below.name, visible: below.visible, opacity: below.opacity, blend: below.blend, key: doc.addCanvas(c), t: { x: 0, y: 0, sx: 1, sy: 1, rot: 0 } };
  doc.layers.splice(i - 1, 2, merged);
  doc.activeId = merged.id;
  doc.commit('Merge down');
}

export function flattenImage() {
  const doc = need(); if (!doc) return;
  const c = flatten(doc);
  const l: RasterLayer = { id: newId(), type: 'raster', name: 'Background', visible: true, opacity: 1, blend: 'normal', key: doc.addCanvas(c), t: { x: 0, y: 0, sx: 1, sy: 1, rot: 0 } };
  doc.layers = [l];
  doc.activeId = l.id;
  doc.commit('Flatten image');
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
  l.t = placeAt(f(l.t), lc, dc);
  doc.commit(label);
}

export const flipLayer = (axis: 'h' | 'v') => aboutCenter(axis === 'h' ? 'Flip horizontal' : 'Flip vertical', (t) => (axis === 'h' ? { ...t, sx: -t.sx } : { ...t, sy: -t.sy }));
export const rotateLayer90 = (dir: 1 | -1) => aboutCenter('Rotate 90°', (t) => ({ ...t, rot: t.rot + (dir * Math.PI) / 2 }));
export const resetTransform = () => aboutCenter('Reset transform', (t) => ({ ...t, sx: 1, sy: 1, rot: 0 }));

// ---------- whole-document transforms (all lossless) ----------

/** Splits an affine matrix back into position/rotation/scale (exact for rotations, flips and uniform scales). */
function decompose(m: Mat): Xform {
  const sx = Math.hypot(m[0], m[1]);
  const rot = Math.atan2(tidy(m[1]), tidy(m[0]));
  const sy = (m[0] * m[3] - m[1] * m[2]) / (sx || 1e-9);
  return { x: tidy(m[4]), y: tidy(m[5]), sx: tidy(sx), sy: tidy(sy), rot: tidy(rot) };
}

export function transformDoc(label: string, g: Mat, w: number, h: number, scaleShapes?: [number, number]) {
  const doc = need(); if (!doc) return;
  for (const l of doc.layers) {
    if (!isPlaced(l)) continue;
    if (l.type === 'shape' && scaleShapes) {
      const [kx, ky] = scaleShapes;
      l.shape = { ...l.shape, w: l.shape.w * kx, h: l.shape.h * ky, strokeWidth: l.shape.strokeWidth * Math.sqrt(Math.abs(kx * ky)), radius: l.shape.radius * Math.sqrt(Math.abs(kx * ky)) };
      const p = apply(g, l.t.x, l.t.y);
      l.t = { ...l.t, x: p.x, y: p.y };
      continue;
    }
    l.t = decompose(mul(g, xformMatrix(l.t)));
  }
  doc.setSelection(mapSel(doc.selection, (x, y) => { const p = apply(g, x, y); return [p.x, p.y]; }));
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

export function resizeImage(w: number, h: number) {
  const doc = need(); if (!doc) return;
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

function needRaster(doc: Doc, verb: string): RasterLayer | null {
  const l = doc.active;
  if (l?.type === 'raster') return l;
  toast(l ? `Can't ${verb} a ${l.type === 'adjust' ? 'adjustment' : l.type} layer${l.type === 'adjust' ? '' : ' (rasterize it first)'}.` : 'Select a layer first.');
  return null;
}

export function clearSelection() {
  const doc = need(); if (!doc) return;
  if (!doc.selection) { if (doc.active) deleteLayer(); return; }
  const l = needRaster(doc, 'clear pixels on'); if (!l) return;
  const mask = doc.maskForLayer(l)!;
  doc.editPixels(l, 'Clear', (ctx) => { ctx.globalCompositeOperation = 'destination-out'; ctx.drawImage(mask, 0, 0); });
}

export function fillWith(which: 'fg' | 'bg') {
  const doc = need(); if (!doc) return;
  const l = needRaster(doc, 'fill'); if (!l) return;
  doc.ensureCovers(l);
  const mask = doc.maskForLayer(l);
  const color = app[which];
  doc.editPixels(l, 'Fill', (ctx, c) => {
    if (!mask) { ctx.fillStyle = color; ctx.fillRect(0, 0, c.width, c.height); return; }
    const tmp = newCanvas(c.width, c.height);
    const t = ctx2d(tmp);
    t.fillStyle = color;
    t.fillRect(0, 0, c.width, c.height);
    t.globalCompositeOperation = 'destination-in';
    t.drawImage(mask, 0, 0);
    ctx.drawImage(tmp, 0, 0);
  });
  app.useColor(color);
}

// ---------- clipboard ----------

let clip: { canvas: HTMLCanvasElement; at: Pt } | null = null;

export async function copy(merged = false, cut = false) {
  const doc = need(); if (!doc) return;
  const l = doc.active;
  if (!merged && !isPlaced(l)) { toast('Select an image layer to copy from.'); return; }
  const r = (doc.selection && selBounds(doc.selection, doc.width, doc.height)) || (merged || !l ? { x: 0, y: 0, w: doc.width, h: doc.height } : roundOut(doc.layerBounds(l as PlacedLayer)));
  const c = newCanvas(r.w, r.h);
  renderDoc(doc, c, [1, 0, 0, 1, -r.x, -r.y], { layers: merged ? undefined : [{ ...(l as PlacedLayer), opacity: 1, blend: 'normal', visible: true }], clip: merged });
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
