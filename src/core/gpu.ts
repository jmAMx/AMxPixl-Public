import { ctx2d } from './layers';
import type { Rect } from './math';

/** GPU helpers shared by the WebGL engines (adjustments, effects, small ops, warp, 3D). */

const restoredListeners = new Set<() => void>();
let restoreTimer = 0;

/** Runs `f` once the graphics card is back after a reset, so whatever was drawn without it is drawn again. */
export function onGpuRestored(f: () => void) { restoredListeners.add(f); }

/** Called by a GPU engine when its context is back. Several engines coming back together make one call. */
export function gpuRestored() {
  clearTimeout(restoreTimer);
  restoreTimer = window.setTimeout(() => { for (const f of restoredListeners) f(); }, 0);
}

/**
 * The biggest image a WebGL2 context can take in and draw in one go: its texture, renderbuffer and viewport limits.
 */
export function glLimit(gl: WebGL2RenderingContext): number {
  const vp = gl.getParameter(gl.MAX_VIEWPORT_DIMS) as Int32Array;
  return Math.min(gl.getParameter(gl.MAX_TEXTURE_SIZE), gl.getParameter(gl.MAX_RENDERBUFFER_SIZE), vp[0], vp[1]);
}

/** Pieces are kept to this size even on graphics cards that take more, to keep memory use down on older hardware. */
const MOST = 8192;

/**
 * Runs a GPU step on a w × h image too big for the graphics card (`max` pixels a side) in pieces, into `out`.
 * `f` gets each piece's rectangle, grown by `margin` pixels of the image around it (for steps that look at
 * neighbouring pixels) and kept inside the image, and returns its result at that size (or null if it fails, which
 * stops the whole run). Only the middle of each result, without the margin, is kept. Returns false if a piece failed.
 */
export function inTiles(w: number, h: number, max: number, margin: number, f: (r: Rect) => HTMLCanvasElement | null, out: HTMLCanvasElement): boolean {
  const limit = Math.min(max, MOST);
  const m = Math.max(0, Math.min(Math.ceil(margin), Math.floor(limit / 4)));
  const step = limit - m * 2;
  const x = ctx2d(out);
  x.save();
  x.setTransform(1, 0, 0, 1, 0, 0);
  x.globalAlpha = 1;
  x.globalCompositeOperation = 'source-over';
  x.clearRect(0, 0, out.width, out.height);
  try {
    for (let ty = 0; ty < h; ty += step) {
      for (let tx = 0; tx < w; tx += step) {
        const core = { x: tx, y: ty, w: Math.min(step, w - tx), h: Math.min(step, h - ty) };
        const x0 = Math.max(0, core.x - m), y0 = Math.max(0, core.y - m);
        const r = { x: x0, y: y0, w: Math.min(w, core.x + core.w + m) - x0, h: Math.min(h, core.y + core.h + m) - y0 };
        const res = f(r);
        if (!res) return false;
        x.drawImage(res, core.x - r.x, core.y - r.y, core.w, core.h, core.x, core.y, core.w, core.h);
      }
    }
  } finally {
    x.restore();
  }
  return true;
}
