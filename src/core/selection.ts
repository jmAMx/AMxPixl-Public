import { boundsOf, type Rect } from './math';
import { ctx2d, newCanvas } from './layers';
import type { SelOp, Selection } from './types';

export function opPath(op: SelOp): Path2D {
  const p = new Path2D();
  const a = op.pts;
  if (op.shape === 'rect') p.rect(a[0], a[1], a[2], a[3]);
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

/** Paints the selection as an alpha mask in document pixels (opaque = selected). */
export function buildMask(sel: Selection, w: number, h: number): HTMLCanvasElement {
  const c = newCanvas(w, h);
  const ctx = ctx2d(c);
  ctx.fillStyle = '#fff';
  for (const op of sel.ops) {
    ctx.globalCompositeOperation = op.mode === 'add' ? 'source-over' : 'destination-out';
    ctx.fill(opPath(op));
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
