import type { Doc } from './document';
import { glfx } from './glfx';
import { ctx2d, drawPlaced, newCanvas } from './layers';
import { identity, setT, type Mat } from './math';
import type { BlendMode, Layer } from './types';

export const gco = (b: BlendMode): GlobalCompositeOperation => (b === 'normal' ? 'source-over' : b);

export interface RenderOpts {
  /** Only these layers (bottom to top); defaults to all of the document's. */
  layers?: Layer[];
  /** Ignore the visibility flag (for merging / rasterizing hidden layers). */
  includeHidden?: boolean;
  /** Clip to the document's canvas. */
  clip?: boolean;
}

let adjWarned = false;

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
  }
  for (const l of opts.layers ?? doc.layers) {
    if (!l.visible && !opts.includeHidden) continue;
    if (l.opacity <= 0) continue;
    if (l.type === 'adjust') {
      const res = glfx.apply(out, l.adj);
      if (!res) {
        if (!adjWarned) { adjWarned = true; console.warn('Adjustment layers need WebGL2; skipping.'); }
        continue;
      }
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalAlpha = l.opacity;
      ctx.globalCompositeOperation = l.opacity >= 1 ? 'copy' : 'source-atop';
      ctx.drawImage(res, 0, 0);
      ctx.restore();
      continue;
    }
    ctx.save();
    ctx.globalAlpha = l.opacity;
    ctx.globalCompositeOperation = gco(l.blend);
    drawPlaced(ctx, l, doc.pool, view);
    ctx.restore();
  }
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
