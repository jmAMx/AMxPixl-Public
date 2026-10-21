// 2D affine helpers. A Mat maps (x, y) to (a*x + c*y + e, b*x + d*y + f), the same layout as canvas setTransform.
export type Mat = [number, number, number, number, number, number];

export interface Pt { x: number; y: number }
export interface Rect { x: number; y: number; w: number; h: number }

/** A layer's placement: its pixels' top-left lands at (x, y), then rotate by rot (radians), scaled by sx/sy in local axes. */
export interface Xform { x: number; y: number; sx: number; sy: number; rot: number }

export const identity = (): Mat => [1, 0, 0, 1, 0, 0];

/** m * n: applies n first, then m. */
export function mul(m: Mat, n: Mat): Mat {
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}

export function invert(m: Mat): Mat {
  const det = m[0] * m[3] - m[1] * m[2] || 1e-12;
  const id = 1 / det;
  return [m[3] * id, -m[1] * id, -m[2] * id, m[0] * id, (m[2] * m[5] - m[3] * m[4]) * id, (m[1] * m[4] - m[0] * m[5]) * id];
}

export function apply(m: Mat, x: number, y: number): Pt {
  return { x: m[0] * x + m[2] * y + m[4], y: m[1] * x + m[3] * y + m[5] };
}

export const translate = (x: number, y: number): Mat => [1, 0, 0, 1, x, y];
export const scale = (sx: number, sy = sx): Mat => [sx, 0, 0, sy, 0, 0];

export function xformMatrix(t: Xform): Mat {
  const c = Math.cos(t.rot), s = Math.sin(t.rot);
  return [c * t.sx, s * t.sx, -s * t.sy, c * t.sy, t.x, t.y];
}

/** Average linear scale of a matrix (how many output pixels one input pixel covers along an axis). */
export const matScale = (m: Mat) => Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2]));

export function setT(ctx: CanvasRenderingContext2D, m: Mat) {
  ctx.setTransform(m[0], m[1], m[2], m[3], m[4], m[5]);
}

export function corners(m: Mat, r: Rect): Pt[] {
  return [apply(m, r.x, r.y), apply(m, r.x + r.w, r.y), apply(m, r.x + r.w, r.y + r.h), apply(m, r.x, r.y + r.h)];
}

export function boundsOf(pts: Pt[]): Rect {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of pts) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

export const mapRect = (m: Mat, r: Rect) => boundsOf(corners(m, r));

/** Smallest whole-pixel rect containing r; ignores float noise like 1919.9999999 so edges don't grow by a pixel. */
export function roundOut(r: Rect): Rect {
  const e = 1e-6;
  const x = Math.floor(r.x + e), y = Math.floor(r.y + e);
  return { x, y, w: Math.ceil(r.x + r.w - e) - x, h: Math.ceil(r.y + r.h - e) - y };
}

/** Rounds away floating-point noise (e.g. -1.2e-16 -> 0) so repeated flips/rotations stay exact. */
export const tidy = (v: number) => Math.round(v * 1e9) / 1e9 + 0;

/** Splits an affine matrix back into position/rotation/scale (exact for rotations, flips and uniform scales). */
export function decompose(m: Mat): Xform {
  const sx = Math.hypot(m[0], m[1]);
  const rot = Math.atan2(tidy(m[1]), tidy(m[0]));
  const sy = (m[0] * m[3] - m[1] * m[2]) / (sx || 1e-9);
  return { x: tidy(m[4]), y: tidy(m[5]), sx: tidy(sx), sy: tidy(sy), rot: tidy(rot) };
}

export function intersect(a: Rect, b: Rect): Rect | null {
  const x = Math.max(a.x, b.x), y = Math.max(a.y, b.y);
  const x1 = Math.min(a.x + a.w, b.x + b.w), y1 = Math.min(a.y + a.h, b.y + b.h);
  return x1 > x && y1 > y ? { x, y, w: x1 - x, h: y1 - y } : null;
}

export function union(a: Rect | null, b: Rect): Rect {
  if (!a) return { ...b };
  const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
}

export const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

export function pointInPoly(p: Pt, poly: Pt[]) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}
