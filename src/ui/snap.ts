import { app } from '../app';
import { visiblePlaced } from '../core/document';

/** Lines currently being snapped to (drawn as magenta guides while dragging). Document coordinates. */
export const snapLines: { x: number[]; y: number[] } = { x: [], y: [] };

export function clearSnapLines() { snapLines.x = []; snapLines.y = []; }

/** Things worth snapping to: guides, the canvas edges and centre, and other visible layers' edges and centres. */
export function snapTargets(excludeId?: string): { xs: number[]; ys: number[] } {
  const doc = app.doc;
  if (!doc) return { xs: [], ys: [] };
  const xs = [0, doc.width / 2, doc.width], ys = [0, doc.height / 2, doc.height];
  if (app.prefs.guides) for (const g of doc.guides) (g.axis === 'x' ? xs : ys).push(g.pos);
  for (const l of visiblePlaced(doc.layers)) {
    if (l.id === excludeId) continue;
    const b = doc.layerBounds(l);
    xs.push(b.x, b.x + b.w / 2, b.x + b.w);
    ys.push(b.y, b.y + b.h / 2, b.y + b.h);
  }
  return { xs, ys };
}

/**
 * The smallest shift (within `tol` document pixels) that lines one of `vals` up with one of `targets`, and the
 * target it lines up with. Null if nothing is close enough.
 */
export function snapDelta(vals: number[], targets: number[], tol: number): { d: number; at: number } | null {
  let best: { d: number; at: number } | null = null;
  for (const v of vals) for (const t of targets) {
    const d = t - v;
    if (Math.abs(d) <= tol && (!best || Math.abs(d) < Math.abs(best.d))) best = { d, at: t };
  }
  return best;
}

/** Snaps a single point (for selections, guides and crops). Returns the adjusted point. */
export function snapPoint(x: number, y: number, excludeId?: string): { x: number; y: number } {
  clearSnapLines();
  const doc = app.doc;
  if (!doc || !app.prefs.snap) return { x, y };
  const tol = 6 / doc.zoom;
  const { xs, ys } = snapTargets(excludeId);
  const sx = snapDelta([x], xs, tol), sy = snapDelta([y], ys, tol);
  if (sx) { x += sx.d; snapLines.x = [sx.at]; }
  if (sy) { y += sy.d; snapLines.y = [sy.at]; }
  return { x, y };
}
