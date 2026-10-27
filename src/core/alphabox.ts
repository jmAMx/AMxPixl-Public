import type { Rect } from './math';

/** The smallest rectangle holding every pixel that isn't fully transparent; null if there are none. RGBA input. */
export function alphaBox(data: Uint8ClampedArray, W: number, H: number): Rect | null {
  const px = new Uint32Array(data.buffer, data.byteOffset, W * H);
  // Alpha is the top byte of each little-endian RGBA word.
  const rowHas = (y: number, x0 = 0, x1 = W) => { for (let x = x0, i = y * W + x0; x < x1; x++, i++) if (px[i] >>> 24) return true; return false; };
  let top = 0;
  while (top < H && !rowHas(top)) top++;
  if (top === H) return null;
  let bottom = H - 1;
  while (bottom > top && !rowHas(bottom)) bottom--;
  // Narrow the left and right edges row by row, only looking where they could still move.
  let left = W, right = -1;
  for (let y = top; y <= bottom; y++) {
    const row = y * W;
    for (let x = 0; x < left; x++) if (px[row + x] >>> 24) { left = x; break; }
    for (let x = W - 1; x > right; x--) if (px[row + x] >>> 24) { right = x; break; }
  }
  return { x: left, y: top, w: right - left + 1, h: bottom - top + 1 };
}
