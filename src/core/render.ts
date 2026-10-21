import type { Doc } from './document';
import { fxEngine } from './fx';
import { glfx } from './glfx';
import { ctx2d, drawPlaced, newCanvas } from './layers';
import { identity, mapRect, matScale, mul, setT, xformMatrix, type Mat, type Rect } from './math';
import { displaySource } from './pyramid';
import type { BlendMode, FilterLayer, Layer, Mask } from './types';
import { isFilter, isPlaced } from './types';

export const gco = (b: BlendMode): GlobalCompositeOperation => (b === 'normal' || b === 'pass-through' ? 'source-over' : b);

export interface RenderOpts {
  /** Only these layers (bottom to top); defaults to all of the document's. */
  layers?: Layer[];
  /** Ignore the visibility flag (for merging / rasterizing hidden layers). */
  includeHidden?: boolean;
  /** Clip to the document's canvas. */
  clip?: boolean;
}

interface Env {
  doc: Doc;
  view: Mat;
  /** Target pixels per document pixel. */
  scale: number;
  /** The document's rectangle in target pixels (for effects). */
  docRect: Rect;
  includeHidden: boolean;
}

// ---------- scratch canvases (isolated groups, masks, clipping need temporary buffers) ----------

const scratch: { c: HTMLCanvasElement; busy: boolean }[] = [];

function acquire(w: number, h: number): HTMLCanvasElement {
  let s = scratch.find((x) => !x.busy && x.c.width === w && x.c.height === h);
  if (!s) {
    // Drop idle buffers of other sizes (the view was resized) before making a new one.
    for (let i = scratch.length - 1; i >= 0; i--) if (!scratch[i].busy && (scratch[i].c.width !== w || scratch[i].c.height !== h)) scratch.splice(i, 1);
    s = { c: newCanvas(w, h), busy: false };
    scratch.push(s);
  }
  s.busy = true;
  const x = ctx2d(s.c);
  x.setTransform(1, 0, 0, 1, 0, 0);
  x.globalAlpha = 1;
  x.globalCompositeOperation = 'source-over';
  x.filter = 'none';
  x.clearRect(0, 0, w, h);
  return s.c;
}

function release(...cs: HTMLCanvasElement[]) {
  for (const c of cs) { const s = scratch.find((x) => x.c === c); if (s) s.busy = false; }
}

const like = (c: HTMLCanvasElement) => acquire(c.width, c.height);

function composite(target: HTMLCanvasElement, src: HTMLCanvasElement, blend: BlendMode, opacity: number, op?: GlobalCompositeOperation) {
  const x = ctx2d(target);
  x.save();
  x.setTransform(1, 0, 0, 1, 0, 0);
  x.globalAlpha = opacity;
  x.globalCompositeOperation = op ?? gco(blend);
  x.drawImage(src, 0, 0);
  x.restore();
}

// ---------- masks ----------

const maskOn = (l: Layer): Mask | null => (l.mask && l.mask.enabled ? l.mask : null);

/** The mask drawn into target space (alpha = how much shows), with live feather and density. */
function maskInTarget(m: Mask, like: HTMLCanvasElement, env: Env): HTMLCanvasElement {
  const out = acquire(like.width, like.height);
  const src = env.doc.pool.get(m.key);
  if (!src) return out;
  const x = ctx2d(out);
  const mm = mul(env.view, xformMatrix(m.t));
  const s = matScale(mm);
  x.save();
  setT(x, mm);
  if (m.feather > 0) x.filter = `blur(${m.feather * env.scale}px)`;
  x.imageSmoothingEnabled = true;
  const { img, f } = displaySource(src, s);
  x.drawImage(img, 0, 0, img.width * f, img.height * f);
  x.restore();
  if (m.density < 1) {
    x.fillStyle = `rgba(255,255,255,${1 - m.density})`;
    x.fillRect(0, 0, out.width, out.height);
  }
  return out;
}

function applyMask(c: HTMLCanvasElement, m: Mask, env: Env) {
  const mc = maskInTarget(m, c, env);
  composite(c, mc, 'normal', 1, 'destination-in');
  release(mc);
}

// ---------- filter layers (adjustments + effects) ----------

function filterResult(l: FilterLayer, target: HTMLCanvasElement, env: Env): HTMLCanvasElement | null {
  if (l.type === 'adjust') return glfx.apply(target, l.adj);
  return fxEngine.apply(target, l.fx, env.scale, env.docRect);
}

/** target = mix(target, result, opacity × mask), done with premultiplied adds so transparency stays exact. */
function mergeFiltered(target: HTMLCanvasElement, res: HTMLCanvasElement, opacity: number, mask: HTMLCanvasElement | null) {
  if (!mask && opacity >= 1) { composite(target, res, 'normal', 1, 'copy'); return; }
  const a = like(target);
  composite(a, res, 'normal', opacity);
  if (mask) composite(a, mask, 'normal', 1, 'destination-in');
  const b = like(target);
  composite(b, target, 'normal', 1);
  if (mask) composite(b, mask, 'normal', opacity, 'destination-out');
  else {
    const x = ctx2d(b);
    x.save();
    x.globalAlpha = opacity;
    x.globalCompositeOperation = 'destination-out';
    x.fillRect(0, 0, b.width, b.height);
    x.restore();
  }
  composite(target, b, 'normal', 1, 'copy');
  composite(target, a, 'normal', 1, 'lighter');
  release(a, b);
}

let warned = false;

function drawFilter(l: FilterLayer, target: HTMLCanvasElement, env: Env) {
  const res = filterResult(l, target, env);
  if (!res) {
    if (!warned) { warned = true; console.warn('Adjustment/effect layers need WebGL2; skipping.'); }
    return;
  }
  const m = maskOn(l);
  const mc = m ? maskInTarget(m, target, env) : null;
  mergeFiltered(target, res, l.opacity, mc);
  if (mc) release(mc);
}

// ---------- layers, groups, clipping ----------

const shows = (l: Layer, env: Env) => (l.visible || env.includeHidden) && l.opacity > 0;

function drawLayer(l: Layer, target: HTMLCanvasElement, env: Env) {
  if (isFilter(l)) { drawFilter(l, target, env); return; }
  const m = maskOn(l);
  if (l.type === 'group') {
    if (l.blend === 'pass-through' && l.opacity >= 1 && !m) { renderList(l.children, target, env); return; }
    const iso = like(target);
    renderList(l.children, iso, env);
    if (m) applyMask(iso, m, env);
    composite(target, iso, l.blend, l.opacity);
    release(iso);
    return;
  }
  if (!isPlaced(l)) return;
  if (!m) {
    const x = ctx2d(target);
    x.save();
    x.globalAlpha = l.opacity;
    x.globalCompositeOperation = gco(l.blend);
    drawPlaced(x, l, env.doc.pool, env.view);
    x.restore();
    return;
  }
  const iso = like(target);
  drawPlaced(ctx2d(iso), l, env.doc.pool, env.view);
  ctx2d(iso).setTransform(1, 0, 0, 1, 0, 0);
  applyMask(iso, m, env);
  composite(target, iso, l.blend, l.opacity);
  release(iso);
}

/** A layer clipped to `base` (whose own alpha is `baseAlpha`): it only shows where the base has pixels. */
function drawClipped(l: Layer, base: HTMLCanvasElement, baseAlpha: HTMLCanvasElement, env: Env) {
  if (isFilter(l)) {
    drawFilter(l, base, env);
    composite(base, baseAlpha, 'normal', 1, 'destination-in');
    return;
  }
  const tmp = like(base);
  drawLayer({ ...l, opacity: 1, blend: l.type === 'group' ? l.blend : 'normal', clip: false } as Layer, tmp, env);
  composite(tmp, baseAlpha, 'normal', 1, 'destination-in');
  if (l.blend === 'normal' || l.blend === 'pass-through') composite(base, tmp, 'normal', l.opacity, 'source-atop');
  else {
    composite(base, tmp, l.blend, l.opacity);
    composite(base, baseAlpha, 'normal', 1, 'destination-in');
  }
  release(tmp);
}

function renderList(list: Layer[], target: HTMLCanvasElement, env: Env) {
  for (let i = 0; i < list.length; i++) {
    const l = list[i];
    let j = i + 1;
    const clipped: Layer[] = [];
    if (!isFilter(l)) while (j < list.length && list[j].clip) clipped.push(list[j++]);
    i = j - 1;
    // A hidden base hides everything clipped to it, as in Photoshop.
    if (!shows(l, env)) continue;
    const live = clipped.filter((c) => shows(c, env));
    if (!live.length) { drawLayer(l, target, env); continue; }
    const iso = like(target);
    drawLayer({ ...l, opacity: 1, blend: 'normal' } as Layer, iso, env);
    const baseAlpha = like(target);
    composite(baseAlpha, iso, 'normal', 1);
    for (const c of live) drawClipped(c, iso, baseAlpha, env);
    composite(target, iso, l.blend, l.opacity);
    release(iso, baseAlpha);
  }
}

/**
 * Composites a document into `out` through `view` (document -> out pixels). The view is rendered at the
 * target's resolution, so on-screen previews stay fast regardless of image size.
 */
export function renderDoc(doc: Doc, out: HTMLCanvasElement, view: Mat, opts: RenderOpts = {}) {
  const ctx = ctx2d(out);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 1;
  ctx.clearRect(0, 0, out.width, out.height);
  ctx.save();
  if (opts.clip !== false) {
    setT(ctx, view);
    ctx.beginPath();
    ctx.rect(0, 0, doc.width, doc.height);
    ctx.clip();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }
  const env: Env = { doc, view, scale: matScale(view), docRect: mapRect(view, { x: 0, y: 0, w: doc.width, h: doc.height }), includeHidden: !!opts.includeHidden };
  renderList(opts.layers ?? doc.layers, out, env);
  ctx.restore();
}

/** Full-resolution flattened image of the document (optionally scaled). */
export function flatten(doc: Doc, scaleBy = 1, opts: RenderOpts = {}): HTMLCanvasElement {
  const out = newCanvas(Math.round(doc.width * scaleBy), Math.round(doc.height * scaleBy));
  const v: Mat = scaleBy === 1 ? identity() : [scaleBy, 0, 0, scaleBy, 0, 0];
  renderDoc(doc, out, v, opts);
  return out;
}

/** Colour of the composite at a document point, averaged over size x size pixels. */
export function sampleDoc(doc: Doc, x: number, y: number, size = 1): [number, number, number, number] {
  const out = newCanvas(size, size);
  const h = Math.floor(size / 2);
  renderDoc(doc, out, [1, 0, 0, 1, -Math.floor(x) + h, -Math.floor(y) + h]);
  const d = ctx2d(out).getImageData(0, 0, size, size).data;
  let r = 0, g = 0, b = 0, a = 0;
  for (let i = 0; i < d.length; i += 4) { r += d[i] * d[i + 3]; g += d[i + 1] * d[i + 3]; b += d[i + 2] * d[i + 3]; a += d[i + 3]; }
  if (!a) return [0, 0, 0, 0];
  return [Math.round(r / a), Math.round(g / a), Math.round(b / a), Math.round(a / (size * size))];
}
