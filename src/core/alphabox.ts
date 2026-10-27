import type { Rect } from './math';

/** The smallest rectangle holding every pixel `filled` accepts (pixels as little-endian RGBA words); null if none. */
function scanBox(px: Uint32Array, W: number, H: number, filled: (v: number) => boolean): Rect | null {
  const rowHas = (y: number) => { for (let i = y * W, e = i + W; i < e; i++) if (filled(px[i])) return true; return false; };
  let top = 0;
  while (top < H && !rowHas(top)) top++;
  if (top === H) return null;
  let bottom = H - 1;
  while (bottom > top && !rowHas(bottom)) bottom--;
  // Narrow the left and right edges row by row, only looking where they could still move.
  let left = W, right = -1;
  for (let y = top; y <= bottom; y++) {
    const row = y * W;
    for (let x = 0; x < left; x++) if (filled(px[row + x])) { left = x; break; }
    for (let x = W - 1; x > right; x--) if (filled(px[row + x])) { right = x; break; }
  }
  return { x: left, y: top, w: right - left + 1, h: bottom - top + 1 };
}

const words = (data: Uint8ClampedArray, W: number, H: number) => new Uint32Array(data.buffer, data.byteOffset, W * H);

/** The smallest rectangle holding every pixel that isn't fully transparent; null if there are none. RGBA input. */
export function alphaBox(data: Uint8ClampedArray, W: number, H: number): Rect | null {
  // Alpha is the top byte of each word.
  return scanBox(words(data, W, H), W, H, (v) => v >>> 24 !== 0);
}

/**
 * What's left after trimming empty edges: transparent ones, or, when the top-left pixel is opaque, ones within a
 * small tolerance of its colour (a flat background). Null if the whole image is empty.
 */
export function trimBox(data: Uint8ClampedArray, W: number, H: number): Rect | null {
  const px = words(data, W, H);
  const ref = px[0];
  if (ref >>> 24 === 0) return alphaBox(data, W, H);
  const tol = 6;
  const ch = (v: number, s: number) => (v >>> s) & 255;
  return scanBox(px, W, H, (v) => Math.abs(ch(v, 0) - ch(ref, 0)) > tol || Math.abs(ch(v, 8) - ch(ref, 8)) > tol
    || Math.abs(ch(v, 16) - ch(ref, 16)) > tol || Math.abs(ch(v, 24) - ch(ref, 24)) > tol);
}
