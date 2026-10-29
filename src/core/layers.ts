import { alphaBox } from './alphabox';
import { envelopeBounds, envelopePoint, type Envelope } from './envelope';
import type { Pt } from './math';
import { glops } from './glops';
import { pathBounds, toPath2D } from './paths';
import { modelBox, renderModel } from './model3d';
import { decompose, invert, matScale, mul, setT, xformMatrix, type Mat, type Rect, type Xform } from './math';
import { displaySource } from './pyramid';
import { drawText, layoutText } from './text';
import type { PlacedLayer, ShapeLayer, ShapeProps, TextLayer } from './types';
import { warpBounds, warpGL } from './warp';

export type Pool = Map<string, HTMLCanvasElement>;

export const layerMatrix = (l: PlacedLayer): Mat => xformMatrix(l.t);

/**
 * Where something placed relative to a layer (e.g. its linked mask, originally at `t0`) ends up when the layer
 * moves from matrix `from` to transform `to`.
 */
export function follow(t0: Xform, from: Mat, to: Xform): Xform {
  return decompose(mul(mul(xformMatrix(to), invert(from)), xformMatrix(t0)));
}

/** The layer's own box in local (pre-transform) pixels. */
export function localBounds(l: PlacedLayer, pool: Pool): Rect {
  switch (l.type) {
    case 'raster': {
      if (l.warp) return warpBounds(l.warp);
      const c = pool.get(l.key);
      if (l.model && c) return modelBox(c, l.model, l.key);
      return { x: 0, y: 0, w: c?.width ?? 1, h: c?.height ?? 1 };
    }
    case 'text': {
      if (l.envelope) return envelopeBounds(l.envelope, vectorBox(l));
      const lay = layoutText(l.text);
      return { x: lay.x, y: lay.y, w: lay.w, h: lay.h };
    }
    case 'shape':
      return l.envelope ? envelopeBounds(l.envelope, vectorBox(l)) : shapeBounds(l.shape);
  }
}

/**
 * A text or shape layer's box before any warp preset, with room for what reaches past it: a shape's stroke, and
 * letters that overhang their line (italics, accents, tails), which would otherwise be cut off when warped.
 */
export function vectorBox(l: TextLayer | ShapeLayer): Rect {
  if (l.type === 'text') {
    const lay = layoutText(l.text), p = Math.ceil(l.text.size * 0.2);
    return { x: lay.x - p, y: lay.y - p, w: lay.w + p * 2, h: lay.h + p * 2 };
  }
  const b = shapeBounds(l.shape), p = (l.shape.stroke ? l.shape.strokeWidth / 2 : 0) + 1;
  return { x: b.x - p, y: b.y - p, w: b.w + p * 2, h: b.h + p * 2 };
}

const inkCache = new Map<string, Rect>();

/** Where a text layer's letters actually are: its layout box also holds line spacing and room for accents. */
function textInk(l: TextLayer, box: Rect): Rect {
  const key = JSON.stringify(l.text);
  const hit = inkCache.get(key);
  if (hit) return hit;
  if (inkCache.size > 64) inkCache.clear();
  const c = newCanvas(Math.max(1, Math.ceil(box.w)), Math.max(1, Math.ceil(box.h)));
  const x = ctx2d(c, true);
  x.translate(-box.x, -box.y);
  drawText(x, l.text);
  const r = alphaBox(x.getImageData(0, 0, c.width, c.height).data, c.width, c.height);
  const ink = r ? { x: box.x + r.x, y: box.y + r.y, w: r.w, h: r.h } : box;
  inkCache.set(key, ink);
  return ink;
}

/**
 * Where the point (u, v) of a warped text or shape layer's image (its vectorBox) lands. Fitted into a shape, it's the
 * letters themselves that fill the outline, not the padded box around them.
 */
function envelopeMap(l: TextLayer | ShapeLayer, e: Envelope, box: Rect): (u: number, v: number) => Pt {
  if (e.style !== 'shape' || l.type !== 'text') return (u, v) => envelopePoint(e, box, u, v);
  const ink = textInk(l, box), cl = (n: number) => Math.min(1, Math.max(0, n));
  return (u, v) => envelopePoint(e, ink, cl((box.x + u * box.w - ink.x) / ink.w), cl((box.y + v * box.h - ink.y) / ink.h));
}

const vecCache = new Map<string, { c: HTMLCanvasElement; s: number }>();

/**
 * A text or shape layer drawn flat into an image at about `want` pixels per layer pixel (a power of two, so zooming
 * reuses it), for warping. Cached by content.
 */
function vectorImage(l: TextLayer | ShapeLayer, box: Rect, want: number) {
  let s = 2 ** Math.ceil(Math.log2(Math.max(0.25, Math.min(4, want))));
  while (s > 0.25 && Math.max(box.w, box.h) * s > 4096) s /= 2;
  const key = `${JSON.stringify(l.type === 'text' ? l.text : l.shape)}|${s}`;
  const hit = vecCache.get(key);
  if (hit) return hit;
  if (vecCache.size > 32) vecCache.clear();
  const c = newCanvas(Math.max(1, Math.ceil(box.w * s)), Math.max(1, Math.ceil(box.h * s)));
  const x = ctx2d(c);
  x.setTransform(s, 0, 0, s, -box.x * s, -box.y * s);
  if (l.type === 'text') drawText(x, l.text); else drawShape(x, l.shape);
  const out = { c, s };
  vecCache.set(key, out);
  return out;
}

export function shapeBounds(s: ShapeProps): Rect {
  if (s.kind === 'path') return pathBounds(s.subs ?? []) ?? { x: 0, y: 0, w: 1, h: 1 };
  if (s.kind === 'line') {
    const pad = Math.max(1, (s.stroke ? s.strokeWidth : 1) / 2);
    return { x: Math.min(0, s.w) - pad, y: Math.min(0, s.h) - pad, w: Math.abs(s.w) + pad * 2, h: Math.abs(s.h) + pad * 2 };
  }
  return { x: Math.min(0, s.w), y: Math.min(0, s.h), w: Math.abs(s.w), h: Math.abs(s.h) };
}

/** A polygon's or star's corners inside its box (first point at the top). */
export function shapePoints(s: ShapeProps): { x: number; y: number }[] {
  const b = shapeBounds(s);
  const n = Math.max(3, Math.round(s.sides ?? (s.kind === 'star' ? 5 : 6)));
  const star = s.kind === 'star', inner = Math.max(0.05, Math.min(1, s.inner ?? 0.45));
  const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
  const out: { x: number; y: number }[] = [];
  const count = star ? n * 2 : n;
  for (let i = 0; i < count; i++) {
    const a = -Math.PI / 2 + (i * Math.PI * 2) / count;
    const k = star && i % 2 ? inner : 1;
    out.push({ x: cx + Math.cos(a) * (b.w / 2) * k, y: cy + Math.sin(a) * (b.h / 2) * k });
  }
  return out;
}

export function drawShape(ctx: CanvasRenderingContext2D, s: ShapeProps) {
  if (s.kind === 'path') {
    // Holes (the middle of an O) come from the outlines' directions, as in fonts (non-zero winding).
    const p = toPath2D({ id: '', name: '', subs: s.subs ?? [] });
    if (s.fill) { ctx.fillStyle = s.fill; ctx.fill(p); }
    if (s.stroke && s.strokeWidth > 0) { ctx.strokeStyle = s.stroke; ctx.lineWidth = s.strokeWidth; ctx.lineJoin = 'round'; ctx.stroke(p); }
    return;
  }
  const b = s.kind === 'line' ? null : shapeBounds(s);
  ctx.beginPath();
  if (s.kind === 'line') {
    ctx.moveTo(0, 0);
    ctx.lineTo(s.w, s.h);
  } else if (s.kind === 'polygon' || s.kind === 'star') {
    shapePoints(s).forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
    ctx.closePath();
  } else if (s.kind === 'ellipse') {
    ctx.ellipse(b!.x + b!.w / 2, b!.y + b!.h / 2, Math.max(0.01, b!.w / 2), Math.max(0.01, b!.h / 2), 0, 0, Math.PI * 2);
  } else {
    const r = Math.min(s.radius, b!.w / 2, b!.h / 2);
    if (r > 0) ctx.roundRect(b!.x, b!.y, b!.w, b!.h, r);
    else ctx.rect(b!.x, b!.y, b!.w, b!.h);
  }
  if (s.fill && s.kind !== 'line') { ctx.fillStyle = s.fill; ctx.fill(); }
  if (s.stroke && s.strokeWidth > 0) {
    ctx.strokeStyle = s.stroke;
    ctx.lineWidth = s.strokeWidth;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.stroke();
  }
}

/**
 * Draws one placed layer through `view` (document -> target pixels). Raster layers are always sampled from their
 * full-resolution originals, so any amount of scaling or rotating costs nothing in quality.
 */
export function drawPlaced(ctx: CanvasRenderingContext2D, l: PlacedLayer, pool: Pool, view: Mat, nearest = false, screen = false) {
  const m = mul(view, layerMatrix(l));
  setT(ctx, m);
  if (l.type === 'raster') {
    const c = pool.get(l.key);
    if (!c) return;
    const s = matScale(m);
    if (l.model) {
      // A 3D layer: its picture rendered as a lit 3D object (flat if WebGL2 isn't available).
      const r = renderModel(c, l.model, l.key, s);
      if (r) {
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(r.canvas, r.box.x, r.box.y, r.box.w, r.box.h);
        return;
      }
    }
    // On screen past 200%, show crisp pixels (like Photoshop's pixel view); otherwise smooth, high-quality
    // resampling. Nearest neighbour (pixel art) is always crisp and reads the original pixels directly.
    ctx.imageSmoothingEnabled = !nearest && !(screen && s >= 2);
    ctx.imageSmoothingQuality = 'high';
    const { img, f } = nearest ? { img: c, f: 1 } : displaySource(c, s);
    if (l.warp) warpGL.draw(ctx, img, f, c.width, c.height, l.warp, m);
    else if (f === 1) ctx.drawImage(c, 0, 0);
    else ctx.drawImage(img, 0, 0, img.width * f, img.height * f);
  } else if (l.envelope) {
    // Warp preset: the text or shape drawn flat at the needed sharpness, then bent on the GPU.
    const box = vectorBox(l);
    const img = vectorImage(l, box, matScale(m));
    warpGL.drawMapped(ctx, img.c, 1 / img.s, box.w, box.h, envelopeMap(l, l.envelope, box), m);
  } else if ((l.type === 'text' ? l.text : l.shape).antiAlias === false) {
    // Hard pixel edges: draw it once at 1:1 with edges snapped on/off, then show those pixels unsmoothed.
    const b = localBounds(l, pool);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(hardPixels(l), Math.floor(b.x), Math.floor(b.y));
  } else if (l.type === 'text') {
    drawText(ctx, l.text);
  } else {
    drawShape(ctx, l.shape);
  }
}

const hardCache = new Map<string, HTMLCanvasElement>();

/** A text or shape layer with anti-aliasing off, rendered in its own pixels (cached by content). */
function hardPixels(l: TextLayer | ShapeLayer): HTMLCanvasElement {
  const key = JSON.stringify(l.type === 'text' ? l.text : l.shape);
  const hit = hardCache.get(key);
  if (hit) return hit;
  const b = localBounds(l, new Map());
  const x0 = Math.floor(b.x), y0 = Math.floor(b.y);
  const c = newCanvas(Math.ceil(b.x + b.w) - x0, Math.ceil(b.y + b.h) - y0);
  const x = ctx2d(c);
  x.translate(-x0, -y0);
  if (l.type === 'text') drawText(x, l.text); else drawShape(x, l.shape);
  const hard = glops.hardEdge(c);
  const out = hard ? cropCanvas(hard, { x: 0, y: 0, w: c.width, h: c.height }) : c;
  if (hardCache.size > 48) hardCache.clear();
  hardCache.set(key, out);
  return out;
}

export function newCanvas(w: number, h: number) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  return c;
}

export function ctx2d(c: HTMLCanvasElement, readback = false) {
  return c.getContext('2d', readback ? { willReadFrequently: true } : undefined)!;
}

/** GPU-side copy of part of a canvas (no slow readback to the CPU). */
export function cropCanvas(src: HTMLCanvasElement, r: Rect) {
  const c = newCanvas(r.w, r.h);
  ctx2d(c).drawImage(src, -r.x, -r.y);
  return c;
}

export function cloneCanvas(src: HTMLCanvasElement) {
  const c = newCanvas(src.width, src.height);
  ctx2d(c).drawImage(src, 0, 0);
  return c;
}
