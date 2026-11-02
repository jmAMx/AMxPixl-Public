import { cloneCanvas, ctx2d, newCanvas } from './layers';

/**
 * Helpers for filters. The filters themselves are effects (core/filterfx.ts), run on the GPU: as editable effect
 * layers, or applied to a layer's pixels from the Filter menu (ui/dialogs.ts filterDialog).
 */

/** Copy with edge pixels stretched outward, so blurs don't fade to transparent at the borders (into `into` if given). */
export function padEdges(src: HTMLCanvasElement, pad: number, into?: HTMLCanvasElement) {
  const w = src.width, h = src.height;
  const c = into ?? newCanvas(w + pad * 2, h + pad * 2);
  if (c.width !== w + pad * 2 || c.height !== h + pad * 2) { c.width = w + pad * 2; c.height = h + pad * 2; }
  const x = ctx2d(c);
  x.save();
  x.clearRect(0, 0, c.width, c.height);
  x.imageSmoothingEnabled = false;
  x.drawImage(src, pad, pad);
  x.drawImage(src, 0, 0, 1, h, 0, pad, pad, h);
  x.drawImage(src, w - 1, 0, 1, h, pad + w, pad, pad, h);
  x.drawImage(src, 0, 0, w, 1, pad, 0, w, pad);
  x.drawImage(src, 0, h - 1, w, 1, pad, pad + h, w, pad);
  x.drawImage(src, 0, 0, 1, 1, 0, 0, pad, pad);
  x.drawImage(src, w - 1, 0, 1, 1, pad + w, 0, pad, pad);
  x.drawImage(src, 0, h - 1, 1, 1, 0, pad + h, pad, pad);
  x.drawImage(src, w - 1, h - 1, 1, 1, pad + w, pad + h, pad, pad);
  x.restore();
  return c;
}

/** Blends a filtered result over the original only where `mask` is opaque (selection-limited filters). */
export function maskedMerge(original: HTMLCanvasElement, result: HTMLCanvasElement, mask: HTMLCanvasElement | null) {
  if (!mask) return result;
  const a = cloneCanvas(result);
  const ax = ctx2d(a);
  ax.globalCompositeOperation = 'destination-in';
  ax.drawImage(mask, 0, 0);
  const b = cloneCanvas(original);
  const bx = ctx2d(b);
  bx.globalCompositeOperation = 'destination-out';
  bx.drawImage(mask, 0, 0);
  bx.globalCompositeOperation = 'lighter';
  bx.drawImage(a, 0, 0);
  return b;
}
