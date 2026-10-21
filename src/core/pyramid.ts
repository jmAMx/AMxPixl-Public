import { ctx2d, newCanvas } from './layers';
import type { Rect } from './math';

/**
 * Pre-shrunk copies (1/2, 1/4, 1/8...) of large layers for zoomed-out display. Shrinking a 24MP photo straight
 * to screen size with high-quality smoothing costs ~130ms per frame on older integrated graphics; drawing from the nearest
 * level costs a few ms. Each level is an exact half of the one above (bilinear at exactly 0.5 = a clean 2x2 box
 * filter), and painting only refreshes the touched area of each level.
 */
interface Pyr { levels: HTMLCanvasElement[]; dirty: Rect | 'all' | null }
const cache = new WeakMap<HTMLCanvasElement, Pyr>();

/** Marks part (or all) of a layer's pixels as changed. */
export function invalidate(src: HTMLCanvasElement | undefined, r?: Rect) {
  const p = src && cache.get(src);
  if (!p || p.dirty === 'all') return;
  if (!r) { p.dirty = 'all'; return; }
  if (!p.dirty) { p.dirty = { ...r }; return; }
  const x = Math.min(p.dirty.x, r.x), y = Math.min(p.dirty.y, r.y);
  p.dirty = { x, y, w: Math.max(p.dirty.x + p.dirty.w, r.x + r.w) - x, h: Math.max(p.dirty.y + p.dirty.h, r.y + r.h) - y };
}

function halve(dst: HTMLCanvasElement, prev: HTMLCanvasElement, r?: Rect) {
  const x = ctx2d(dst);
  x.save();
  x.imageSmoothingEnabled = true;
  x.imageSmoothingQuality = 'low';
  if (r) {
    x.beginPath();
    x.rect(r.x, r.y, r.w, r.h);
    x.clip();
  }
  x.globalCompositeOperation = 'copy';
  x.drawImage(prev, 0, 0, prev.width / 2, prev.height / 2);
  x.restore();
}

/** The image to draw for `src` at `scale`, and the factor to scale it back up to `src` coordinates. */
export function displaySource(src: HTMLCanvasElement, scale: number): { img: HTMLCanvasElement; f: number } {
  if (scale >= 0.5 || (src.width < 256 && src.height < 256)) return { img: src, f: 1 };
  const want = Math.floor(Math.log2(1 / scale));
  let p = cache.get(src);
  if (!p) { p = { levels: [], dirty: null }; cache.set(src, p); }
  if (p.dirty === 'all') p.levels = [];
  else if (p.dirty) {
    let r = p.dirty;
    let prev = src;
    for (const lv of p.levels) {
      const x0 = Math.max(0, Math.floor(r.x / 2) - 1), y0 = Math.max(0, Math.floor(r.y / 2) - 1);
      r = { x: x0, y: y0, w: Math.min(lv.width, Math.ceil((r.x + r.w) / 2) + 1) - x0, h: Math.min(lv.height, Math.ceil((r.y + r.h) / 2) + 1) - y0 };
      halve(lv, prev, r);
      prev = lv;
    }
  }
  p.dirty = null;
  while (p.levels.length < want) {
    const prev = p.levels[p.levels.length - 1] ?? src;
    if (prev.width < 48 || prev.height < 48) break;
    const c = newCanvas(Math.ceil(prev.width / 2), Math.ceil(prev.height / 2));
    halve(c, prev);
    p.levels.push(c);
  }
  const n = Math.min(want, p.levels.length);
  return n ? { img: p.levels[n - 1], f: 2 ** n } : { img: src, f: 1 };
}
