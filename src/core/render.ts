import { flatLayers, type Doc } from './document';
import { fxDef } from './effects';
import { fxEngine } from './fx';
import { glfx } from './glfx';
import { glops } from './glops';
import { ctx2d, drawPlaced, newCanvas } from './layers';
import { identity, mapRect, matScale, mul, setT, xformMatrix, type Mat, type Rect } from './math';
import { displaySource } from './pyramid';
import { acquire, composite, gco as gcoOf, like, release } from './scratch';
import { applyStyles, hasStyles } from './styles';
import type { BlendIf, BlendMode, FilterLayer, Layer, LayerStyles, Mask } from './types';
import { isFilter, isPlaced } from './types';

export { gco } from './scratch';

export interface RenderOpts {
  /** Only these layers (bottom to top); defaults to all of the document's. */
  layers?: Layer[];
  /** Ignore the visibility flag (for merging / rasterizing hidden layers). */
  includeHidden?: boolean;
  /** Clip to the document's canvas. */
  clip?: boolean;
  /** Stop just before this layer and leave what it would receive in the output (for adjustment histograms). */
  stopAt?: string;
  /** Override the document's resampling (export can choose). */
  nearest?: boolean;
  /** Drawing the on-screen view (zoomed-in pixels show crisp). */
  screen?: boolean;
  /** Animation frame to draw (defaults to the document's current frame). */
  frame?: number;
}

/**
 * How far (document pixels) a change to some pixels can show up beyond them once everything is composited: blurs,
 * glows, shadows, mask feathering, and effects that look at neighbouring pixels. Infinity when an effect can move
 * pixels anywhere (lens distortion, CRT curvature), so the whole view has to redraw.
 */
export function dirtyPad(doc: Doc): number {
  let pad = 2;
  const n = (v: unknown) => Number(v) || 0;
  for (const l of flatLayers(doc.layers)) {
    if (l.mask && l.mask.feather > 0) pad = Math.max(pad, l.mask.feather * 3);
    const st = l.styles;
    if (st) {
      if (st.shadow.on) pad = Math.max(pad, st.shadow.distance + st.shadow.size * 3);
      if (st.glow.on) pad = Math.max(pad, st.glow.size * 3);
      if (st.innerGlow.on) pad = Math.max(pad, st.innerGlow.size * 3);
      if (st.stroke.on) pad = Math.max(pad, st.stroke.size * 2);
    }
    if (l.type !== 'effect') continue;
    const v = l.fx.v, def = fxDef(l.fx.kind);
    if (l.fx.kind === 'distortion' || l.fx.kind === 'crt') return Infinity;
    let p = def?.aux ? def.aux.radius(v) * 3 : 0;
    switch (l.fx.kind) {
      case 'grain': p += n(v.size) * 2; break;
      case 'chromatic': p += n(v.amount) * 1.5; break;
      case 'vhs': p += n(v.shift) + 12 * 24 + 80; break;
      case 'glitch': p += n(v.offset) * 1.5 + n(v.split) + 40; break;
      case 'halftone': p += n(v.size) * 2.5; break;
      case 'dither': p += n(v.pixel) * 2; break;
      case 'compression': p += n(v.block) * 4; break;
      case 'videodeg': p += n(v.size) * 2; break;
    }
    pad = Math.max(pad, p + 4);
  }
  return pad;
}

/** Seconds into the animation at the start of `frame` (frames can have their own length). */
export function frameTime(doc: Doc, frame: number): number {
  const a = doc.anim;
  if (!a) return 0;
  let ms = 0;
  for (let i = 0; i < Math.min(frame, a.frames.length); i++) ms += a.frames[i].ms ?? 1000 / a.fps;
  return ms / 1000;
}

interface Env {
  doc: Doc;
  view: Mat;
  /** Target pixels per document pixel. */
  scale: number;
  /** The document's rectangle in target pixels (for effects). */
  docRect: Rect;
  includeHidden: boolean;
  stopAt?: string;
  out: HTMLCanvasElement;
  /** Set once `stopAt` is reached: everything else stops drawing. */
  done: boolean;
  /** Nearest-neighbour resampling (blocky pixel art). */
  nearest: boolean;
  screen: boolean;
  frame: number;
  /** Seconds into the animation (moves animated effects). */
  time: number;
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
  x.imageSmoothingEnabled = !env.nearest;
  const { img, f } = env.nearest ? { img: src, f: 1 } : displaySource(src, s);
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
  if (l.type === 'adjust') return glfx.apply(target, l.adj, (k) => env.doc.pool.get(k));
  return fxEngine.apply(target, l.fx, env.scale, env.docRect, env.time);
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

const shows = (l: Layer, env: Env) => (env.doc.shows(l, env.frame) || env.includeHidden) && l.opacity > 0;

/**
 * Finishes an isolated layer buffer: mask, Blend If (against what's already in `target`), styles, then composites
 * it onto `target` with the layer's blend mode and opacity. Releases `iso`.
 */
function finish(l: Layer, iso: HTMLCanvasElement, target: HTMLCanvasElement, env: Env, m: Mask | null, st: LayerStyles | null, bi: BlendIf | null) {
  if (m) applyMask(iso, m, env);
  if (bi) {
    const r = glops.blendIf(iso, target, bi);
    if (r) composite(iso, r, 'normal', 1, 'copy');
  }
  const blend = l.blend === 'pass-through' ? 'normal' : l.blend;
  const out = st ? applyStyles(iso, st, env.scale) : iso;
  const lm = l.linear ? LINEAR_MODES[blend] : undefined;
  const res = lm !== undefined ? glops.linearOver(target, out, lm, l.opacity) : null;
  if (res) composite(target, res, 'normal', 1, 'copy');
  else composite(target, out, blend, l.opacity);
  if (out !== iso) release(out);
  release(iso);
}

/** Blend modes that can be done GIMP-style (in linear light), by shader mode number. */
const LINEAR_MODES: Partial<Record<BlendMode, number>> = { normal: 0, multiply: 1, screen: 2, darken: 3, lighten: 4, difference: 5 };

function drawLayer(l: Layer, target: HTMLCanvasElement, env: Env) {
  if (env.done) return;
  if (isFilter(l)) { drawFilter(l, target, env); return; }
  const m = maskOn(l);
  const st = hasStyles(l.styles) ? l.styles : null;
  const bi = l.blendIf?.on ? l.blendIf : null;
  const lin = !!l.linear && LINEAR_MODES[l.blend === 'pass-through' ? 'normal' : l.blend] !== undefined;
  if (l.type === 'group') {
    if (l.blend === 'pass-through' && l.opacity >= 1 && !m && !st && !bi) { renderList(l.children, target, env); return; }
    const iso = like(target);
    renderList(l.children, iso, env);
    if (env.done) { release(iso); return; }
    finish(l, iso, target, env, m, st, bi);
    return;
  }
  if (!isPlaced(l)) return;
  if (!m && !st && !bi && !lin) {
    const x = ctx2d(target);
    x.save();
    x.globalAlpha = l.opacity;
    x.globalCompositeOperation = gcoOf(l.blend);
    drawPlaced(x, l, env.doc.pool, env.view, env.nearest, env.screen);
    x.restore();
    return;
  }
  const iso = like(target);
  drawPlaced(ctx2d(iso), l, env.doc.pool, env.view, env.nearest, env.screen);
  ctx2d(iso).setTransform(1, 0, 0, 1, 0, 0);
  finish(l, iso, target, env, m, st, bi);
}

/** Leaves a copy of `target` in the output and stops all further drawing (used for histograms). */
function capture(target: HTMLCanvasElement, env: Env) {
  if (target !== env.out) {
    const x = ctx2d(env.out);
    x.save();
    x.setTransform(1, 0, 0, 1, 0, 0);
    x.globalCompositeOperation = 'copy';
    x.drawImage(target, 0, 0);
    x.restore();
  }
  env.done = true;
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
    if (env.done) return;
    const l = list[i];
    if (l.id === env.stopAt) { capture(target, env); return; }
    let j = i + 1;
    const clipped: Layer[] = [];
    if (!isFilter(l)) while (j < list.length && list[j].clip) clipped.push(list[j++]);
    i = j - 1;
    // A hidden base hides everything clipped to it, as in Photoshop.
    if (!shows(l, env)) continue;
    const live = clipped.filter((c) => shows(c, env));
    if (!live.length && !clipped.some((c) => c.id === env.stopAt)) { drawLayer(l, target, env); continue; }
    const iso = like(target);
    drawLayer({ ...l, opacity: 1, blend: 'normal' } as Layer, iso, env);
    const baseAlpha = like(target);
    composite(baseAlpha, iso, 'normal', 1);
    for (const c of live) {
      if (env.done) break;
      if (c.id === env.stopAt) { capture(iso, env); break; }
      drawClipped(c, iso, baseAlpha, env);
    }
    if (!env.done) composite(target, iso, l.blend, l.opacity);
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
  const env: Env = {
    doc, view, scale: matScale(view), docRect: mapRect(view, { x: 0, y: 0, w: doc.width, h: doc.height }),
    includeHidden: !!opts.includeHidden, stopAt: opts.stopAt, out, done: false,
    nearest: opts.nearest ?? doc.resample === 'nearest', screen: !!opts.screen,
    frame: opts.frame ?? doc.frame, time: frameTime(doc, opts.frame ?? doc.frame),
  };
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
