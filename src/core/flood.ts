/**
 * Marks pixels similar to the one at (sx, sy): every channel (and alpha) within `tol` of it. Contiguous = only
 * those connected to it (scanline fill), otherwise every matching pixel. Returns 1 for each hit.
 */
export function floodFill(d: Uint8ClampedArray, W: number, H: number, sx: number, sy: number, tol: number, contiguous: boolean): Uint8Array {
  const si = (sy * W + sx) * 4;
  const tr = d[si], tg = d[si + 1], tb = d[si + 2], ta = d[si + 3];
  const match = (i: number) => Math.abs(d[i] - tr) <= tol && Math.abs(d[i + 1] - tg) <= tol && Math.abs(d[i + 2] - tb) <= tol && Math.abs(d[i + 3] - ta) <= tol;
  const hit = new Uint8Array(W * H);
  if (!contiguous) {
    for (let i = 0; i < W * H; i++) if (match(i * 4)) hit[i] = 1;
    return hit;
  }
  const stack = [sx, sy];
  while (stack.length) {
    const y = stack.pop()!, x0 = stack.pop()!;
    let x = x0;
    while (x >= 0 && !hit[y * W + x] && match((y * W + x) * 4)) x--;
    x++;
    let up = false, dn = false;
    while (x < W && !hit[y * W + x] && match((y * W + x) * 4)) {
      hit[y * W + x] = 1;
      if (y > 0) { const m = !hit[(y - 1) * W + x] && match(((y - 1) * W + x) * 4); if (m && !up) { stack.push(x, y - 1); up = true; } else if (!m) up = false; }
      if (y < H - 1) { const m = !hit[(y + 1) * W + x] && match(((y + 1) * W + x) * 4); if (m && !dn) { stack.push(x, y + 1); dn = true; } else if (!m) dn = false; }
      x++;
    }
  }
  return hit;
}
