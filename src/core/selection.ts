import { boundsOf, type Rect } from './math';
import { ctx2d, newCanvas, type Pool } from './layers';
import type { SelOp, Selection } from './types';

export function opPath(op: SelOp): Path2D {
  const p = new Path2D();
  const a = op.pts;
  if (op.shape === 'rect' || op.shape === 'mask') p.rect(a[0], a[1], a[2], a[3]);
  else if (op.shape === 'ellipse') p.ellipse(a[0] + a[2] / 2, a[1] + a[3] / 2, Math.abs(a[2] / 2), Math.abs(a[3] / 2), 0, 0, Math.PI * 2);
  else {
    p.moveTo(a[0], a[1]);
    for (let i = 2; i < a.length; i += 2) p.lineTo(a[i], a[i + 1]);
    p.closePath();
  }
  return p;
}

export function opBounds(op: SelOp): Rect {
  const a = op.pts;
  if (op.shape !== 'poly') return { x: Math.min(a[0], a[0] + a[2]), y: Math.min(a[1], a[1] + a[3]), w: Math.abs(a[2]), h: Math.abs(a[3]) };
  const pts = [];
  for (let i = 0; i < a.length; i += 2) pts.push({ x: a[i], y: a[i + 1] });
  return boundsOf(pts);
}

/** Paints the selection as an alpha mask in document pixels (opaque = selected, soft where feathered). */
export function buildMask(sel: Selection, w: number, h: number, pool: Pool): HTMLCanvasElement {
  const c = newCanvas(w, h);
  const ctx = ctx2d(c);
  ctx.fillStyle = '#fff';
  for (const op of sel.ops) {
    ctx.globalCompositeOperation = op.mode === 'add' ? 'source-over' : 'destination-out';
    if (op.shape === 'mask') { const m = op.key ? pool.get(op.key) : null; if (m) ctx.drawImage(m, 0, 0); }
    else ctx.fill(opPath(op));
  }
  return c;
}

/** Bounding box of what's selected, clipped to the document. Approximate for subtractions (uses the added shapes). */
export function selBounds(sel: Selection, w: number, h: number): Rect | null {
  let r: Rect | null = null;
  for (const op of sel.ops) {
    if (op.mode !== 'add') continue;
    const b = opBounds(op);
    r = r ? boundsOf([{ x: r.x, y: r.y }, { x: r.x + r.w, y: r.y + r.h }, { x: b.x, y: b.y }, { x: b.x + b.w, y: b.y + b.h }]) : b;
  }
  if (!r) return null;
  const x0 = Math.max(0, Math.floor(r.x)), y0 = Math.max(0, Math.floor(r.y));
  const x1 = Math.min(w, Math.ceil(r.x + r.w)), y1 = Math.min(h, Math.ceil(r.y + r.h));
  return x1 > x0 && y1 > y0 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null;
}

/** Bounding box of a mask's opaque-ish pixels (alpha >= 8), read at reduced size for speed. */
export function alphaBounds(mask: HTMLCanvasElement): Rect | null {
  const s = Math.min(1, 1024 / Math.max(mask.width, mask.height));
  const w = Math.max(1, Math.round(mask.width * s)), h = Math.max(1, Math.round(mask.height * s));
  const c = newCanvas(w, h);
  const x = ctx2d(c, true);
  x.drawImage(mask, 0, 0, w, h);
  const d = x.getImageData(0, 0, w, h).data;
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) for (let xx = 0; xx < w; xx++) {
    if (d[(y * w + xx) * 4 + 3] < 8) continue;
    if (xx < x0) x0 = xx; if (xx > x1) x1 = xx; if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  if (x1 < 0) return null;
  return { x: Math.floor(x0 / s), y: Math.floor(y0 / s), w: Math.ceil((x1 - x0 + 1) / s), h: Math.ceil((y1 - y0 + 1) / s) };
}

/** Wraps a document-sized alpha image as a selection (stored in the pixel pool). Null if it's empty. */
export function maskSelection(mask: HTMLCanvasElement, addCanvas: (c: HTMLCanvasElement) => string): Selection | null {
  const b = alphaBounds(mask);
  if (!b) return null;
  return { ops: [{ mode: 'add', shape: 'mask', key: addCanvas(mask), pts: [b.x, b.y, b.w, b.h] }] };
}

/** Inverse of a sequence of add/subtract steps: start from everything, then flip each step. */
export function invertSel(sel: Selection | null, w: number, h: number): Selection | null {
  const all: SelOp = { mode: 'add', shape: 'rect', pts: [0, 0, w, h] };
  if (!sel || !sel.ops.length) return { ops: [all] };
  return { ops: [all, ...sel.ops.map((o) => ({ ...o, mode: (o.mode === 'add' ? 'sub' : 'add') as SelOp['mode'] }))] };
}

export function mapSel(sel: Selection | null, f: (x: number, y: number) => [number, number], sizeScale?: [number, number]): Selection | null {
  if (!sel) return null;
  return {
    ops: sel.ops.map((o) => {
      if (o.shape === 'poly') {
        const pts: number[] = [];
        for (let i = 0; i < o.pts.length; i += 2) pts.push(...f(o.pts[i], o.pts[i + 1]));
        return { ...o, pts };
      }
      const [x, y] = f(o.pts[0], o.pts[1]);
      if (sizeScale) return { ...o, pts: [x, y, o.pts[2] * sizeScale[0], o.pts[3] * sizeScale[1]] };
      // A general map (rotation/flip): carry the opposite corner through too.
      const [x2, y2] = f(o.pts[0] + o.pts[2], o.pts[1] + o.pts[3]);
      return { ...o, pts: [Math.min(x, x2), Math.min(y, y2), Math.abs(x2 - x), Math.abs(y2 - y)] };
    }),
  };
}

/**
 * The selection's outline for the "marching ants". Shape selections use their own paths; pixel-based ones are
 * traced from the mask with marching squares (at up to ~1200px for speed).
 */
export function selOutline(sel: Selection, w: number, h: number, pool: Pool): Path2D {
  const out = new Path2D();
  if (!sel.ops.some((o) => o.shape === 'mask')) {
    for (const op of sel.ops) out.addPath(opPath(op));
    return out;
  }
  const s = Math.min(1, 1200 / Math.max(w, h));
  const W = Math.max(1, Math.round(w * s)), H = Math.max(1, Math.round(h * s));
  const c = newCanvas(W, H);
  const x = ctx2d(c, true);
  x.drawImage(buildMask(sel, w, h, pool), 0, 0, W, H);
  const d = x.getImageData(0, 0, W, H).data;
  const v = (i: number, j: number) => (i < 0 || j < 0 || i >= W || j >= H ? 0 : d[(j * W + i) * 4 + 3] >= 128 ? 1 : 0);
  const k = 1 / s;
  const seg = (ax: number, ay: number, bx: number, by: number) => { out.moveTo(ax * k, ay * k); out.lineTo(bx * k, by * k); };
  for (let j = -1; j < H; j++) for (let i = -1; i < W; i++) {
    const c4 = v(i, j) * 8 + v(i + 1, j) * 4 + v(i + 1, j + 1) * 2 + v(i, j + 1);
    if (c4 === 0 || c4 === 15) continue;
    // Edge midpoints between the four pixel centres of this cell.
    const T: [number, number] = [i + 1, j + 0.5], R: [number, number] = [i + 1.5, j + 1], B: [number, number] = [i + 1, j + 1.5], L: [number, number] = [i + 0.5, j + 1];
    const pairs: [number, number][][] = ({
      1: [[L, B]], 2: [[B, R]], 3: [[L, R]], 4: [[T, R]], 5: [[T, R], [L, B]], 6: [[T, B]], 7: [[T, L]],
      8: [[T, L]], 9: [[T, B]], 10: [[T, L], [B, R]], 11: [[T, R]], 12: [[L, R]], 13: [[B, R]], 14: [[L, B]],
    } as Record<number, [number, number][][]>)[c4];
    for (const [a, b] of pairs) seg(a[0], a[1], b[0], b[1]);
  }
  return out;
}
