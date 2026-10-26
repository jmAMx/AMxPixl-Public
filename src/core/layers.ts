import { decompose, invert, matScale, mul, setT, xformMatrix, type Mat, type Rect, type Xform } from './math';
import { displaySource } from './pyramid';
import { drawText, layoutText } from './text';
import type { PlacedLayer, ShapeProps } from './types';
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
      return { x: 0, y: 0, w: c?.width ?? 1, h: c?.height ?? 1 };
    }
    case 'text': {
      const lay = layoutText(l.text);
      return { x: 0, y: 0, w: lay.w, h: lay.h };
    }
    case 'shape':
      return shapeBounds(l.shape);
  }
}

export function shapeBounds(s: ShapeProps): Rect {
  if (s.kind === 'line') {
    const pad = Math.max(1, (s.stroke ? s.strokeWidth : 1) / 2);
    return { x: Math.min(0, s.w) - pad, y: Math.min(0, s.h) - pad, w: Math.abs(s.w) + pad * 2, h: Math.abs(s.h) + pad * 2 };
  }
  return { x: Math.min(0, s.w), y: Math.min(0, s.h), w: Math.abs(s.w), h: Math.abs(s.h) };
}

export function drawShape(ctx: CanvasRenderingContext2D, s: ShapeProps) {
  const b = s.kind === 'line' ? null : shapeBounds(s);
  ctx.beginPath();
  if (s.kind === 'line') {
    ctx.moveTo(0, 0);
    ctx.lineTo(s.w, s.h);
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
export function drawPlaced(ctx: CanvasRenderingContext2D, l: PlacedLayer, pool: Pool, view: Mat) {
  const m = mul(view, layerMatrix(l));
  setT(ctx, m);
  if (l.type === 'raster') {
    const c = pool.get(l.key);
    if (!c) return;
    const s = matScale(m);
    // Past 200% show crisp pixels (like Photoshop's pixel view); otherwise smooth, high-quality resampling.
    ctx.imageSmoothingEnabled = s < 2;
    ctx.imageSmoothingQuality = 'high';
    const { img, f } = displaySource(c, s);
    if (l.warp) warpGL.draw(ctx, img, f, c.width, c.height, l.warp, m);
    else if (f === 1) ctx.drawImage(c, 0, 0);
    else ctx.drawImage(img, 0, 0, img.width * f, img.height * f);
  } else if (l.type === 'text') {
    drawText(ctx, l.text);
  } else {
    drawShape(ctx, l.shape);
  }
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
