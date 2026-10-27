import type { Pt, Rect } from './math';
import type { PathPoint, SubPath, VPath } from './types';

/**
 * Pen paths: cubic Bézier runs of points. Helpers to draw them, sample them evenly (for stroking and text on a
 * path), hit-test their points and segments for editing, and build them from selections.
 */

export const corner = (x: number, y: number): PathPoint => ({ x, y, ix: x, iy: y, ox: x, oy: y });
export const isSmooth = (p: PathPoint) => p.ix !== p.x || p.iy !== p.y || p.ox !== p.x || p.oy !== p.y;

/** The segments of a run as [from, to] pairs (including the closing one). */
export function segments(s: SubPath): [PathPoint, PathPoint][] {
  const out: [PathPoint, PathPoint][] = [];
  for (let i = 0; i + 1 < s.pts.length; i++) out.push([s.pts[i], s.pts[i + 1]]);
  if (s.closed && s.pts.length > 1) out.push([s.pts[s.pts.length - 1], s.pts[0]]);
  return out;
}

export function addSub(p: Path2D | CanvasRenderingContext2D, s: SubPath) {
  if (!s.pts.length) return;
  p.moveTo(s.pts[0].x, s.pts[0].y);
  for (const [a, b] of segments(s)) p.bezierCurveTo(a.ox, a.oy, b.ix, b.iy, b.x, b.y);
  if (s.closed) p.closePath();
}

export function toPath2D(path: VPath): Path2D {
  const p = new Path2D();
  for (const s of path.subs) addSub(p, s);
  return p;
}

const bez = (a: number, b: number, c: number, d: number, t: number) => {
  const u = 1 - t;
  return u * u * u * a + 3 * u * u * t * b + 3 * u * t * t * c + t * t * t * d;
};

/** Point at t on the segment a→b. */
export function segPoint(a: PathPoint, b: PathPoint, t: number): Pt {
  return { x: bez(a.x, a.ox, b.ix, b.x, t), y: bez(a.y, a.oy, b.iy, b.y, t) };
}

/** A run as a polyline about `step` pixels apart (exact at the points). */
export function flattenSub(s: SubPath, step = 1): Pt[] {
  if (!s.pts.length) return [];
  const out: Pt[] = [{ x: s.pts[0].x, y: s.pts[0].y }];
  for (const [a, b] of segments(s)) {
    // Control-polygon length bounds the curve length; use it to pick how many samples.
    const est = Math.hypot(a.ox - a.x, a.oy - a.y) + Math.hypot(b.ix - a.ox, b.iy - a.oy) + Math.hypot(b.x - b.ix, b.y - b.iy);
    const n = Math.max(1, Math.ceil(est / step));
    for (let i = 1; i <= n; i++) out.push(segPoint(a, b, i / n));
  }
  return out;
}

/** Even sampling along a run: where you are and which way it's heading at any distance. */
export function measure(s: SubPath) {
  const pts = flattenSub(s, 0.75);
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y));
  const length = cum[cum.length - 1] || 0;
  const at = (d: number): { x: number; y: number; angle: number } => {
    if (pts.length < 2) return { x: pts[0]?.x ?? 0, y: pts[0]?.y ?? 0, angle: 0 };
    d = Math.max(0, Math.min(length, d));
    let lo = 0, hi = cum.length - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (cum[m] < d) lo = m; else hi = m; }
    const seg = cum[hi] - cum[lo] || 1, k = (d - cum[lo]) / seg;
    const a = pts[lo], b = pts[hi];
    return { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k, angle: Math.atan2(b.y - a.y, b.x - a.x) };
  };
  return { length, at, pts };
}

export function pathBounds(subs: SubPath[]): Rect | null {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const s of subs) for (const p of flattenSub(s, 4)) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); }
  return x0 <= x1 ? { x: x0, y: y0, w: Math.max(1, x1 - x0), h: Math.max(1, y1 - y0) } : null;
}

export type PathHit =
  | { kind: 'point'; sub: number; i: number }
  | { kind: 'in' | 'out'; sub: number; i: number }
  | { kind: 'segment'; sub: number; i: number; t: number };

/** What's under the pointer on a path (`tol` in document pixels): handles first, then points, then segments. */
export function hitPath(path: VPath, x: number, y: number, tol: number, handlesOf?: (sub: number, i: number) => boolean): PathHit | null {
  const near = (ax: number, ay: number) => Math.hypot(ax - x, ay - y) <= tol;
  for (let si = 0; si < path.subs.length; si++) {
    const s = path.subs[si];
    for (let i = 0; i < s.pts.length; i++) {
      const p = s.pts[i];
      if (handlesOf?.(si, i)) {
        if ((p.ox !== p.x || p.oy !== p.y) && near(p.ox, p.oy)) return { kind: 'out', sub: si, i };
        if ((p.ix !== p.x || p.iy !== p.y) && near(p.ix, p.iy)) return { kind: 'in', sub: si, i };
      }
    }
  }
  for (let si = 0; si < path.subs.length; si++) {
    const s = path.subs[si];
    for (let i = 0; i < s.pts.length; i++) if (near(s.pts[i].x, s.pts[i].y)) return { kind: 'point', sub: si, i };
  }
  for (let si = 0; si < path.subs.length; si++) {
    const segs = segments(path.subs[si]);
    for (let i = 0; i < segs.length; i++) {
      const [a, b] = segs[i];
      let best = Infinity, bt = 0;
      for (let k = 0; k <= 40; k++) { const t = k / 40, q = segPoint(a, b, t), d = Math.hypot(q.x - x, q.y - y); if (d < best) { best = d; bt = t; } }
      if (best <= tol) return { kind: 'segment', sub: si, i, t: bt };
    }
  }
  return null;
}

/** Splits segment `i` of a run at `t` (de Casteljau), inserting a smooth point; the curve keeps its shape. */
export function splitSegment(s: SubPath, i: number, t: number) {
  const a = s.pts[i], b = s.pts[(i + 1) % s.pts.length];
  const lerp = (p: Pt, q: Pt, k: number): Pt => ({ x: p.x + (q.x - p.x) * k, y: p.y + (q.y - p.y) * k });
  const p0 = { x: a.x, y: a.y }, p1 = { x: a.ox, y: a.oy }, p2 = { x: b.ix, y: b.iy }, p3 = { x: b.x, y: b.y };
  const p01 = lerp(p0, p1, t), p12 = lerp(p1, p2, t), p23 = lerp(p2, p3, t);
  const p012 = lerp(p01, p12, t), p123 = lerp(p12, p23, t), m = lerp(p012, p123, t);
  a.ox = p01.x; a.oy = p01.y;
  b.ix = p23.x; b.iy = p23.y;
  s.pts.splice(i + 1, 0, { x: m.x, y: m.y, ix: p012.x, iy: p012.y, ox: p123.x, oy: p123.y });
}

/** Makes a point smooth (handles along its neighbours' direction) or, if it's smooth, a sharp corner. */
export function toggleSmooth(s: SubPath, i: number) {
  const p = s.pts[i];
  if (isSmooth(p)) { p.ix = p.ox = p.x; p.iy = p.oy = p.y; return; }
  const n = s.pts.length;
  const prev = s.pts[(i - 1 + n) % n], next = s.pts[(i + 1) % n];
  const has = (j: number) => s.closed || (j >= 0 && j < n);
  const px = has(i - 1) ? prev : p, nx = has(i + 1) ? next : p;
  let dx = nx.x - px.x, dy = nx.y - px.y;
  const len = Math.hypot(dx, dy) || 1;
  dx /= len; dy /= len;
  const k = Math.min(Math.hypot(nx.x - p.x, nx.y - p.y), Math.hypot(p.x - px.x, p.y - px.y)) / 3 || 20;
  p.ox = p.x + dx * k; p.oy = p.y + dy * k;
  p.ix = p.x - dx * k; p.iy = p.y - dy * k;
}

/** Ramer–Douglas–Peucker: drops points closer than `eps` to the line between their neighbours. */
function simplify(pts: Pt[], eps: number): Pt[] {
  if (pts.length < 3) return pts;
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack: [number, number][] = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    let best = 0, bi = -1;
    const ax = pts[a].x, ay = pts[a].y, dx = pts[b].x - ax, dy = pts[b].y - ay, L = Math.hypot(dx, dy) || 1;
    for (let i = a + 1; i < b; i++) {
      const d = Math.abs((pts[i].x - ax) * dy - (pts[i].y - ay) * dx) / L;
      if (d > best) { best = d; bi = i; }
    }
    if (best > eps && bi > 0) { keep[bi] = 1; stack.push([a, bi], [bi, b]); }
  }
  return pts.filter((_, i) => keep[i]);
}

/** Turns closed outlines (polylines) into smooth paths: gentle bends get curve handles, sharp ones stay corners. */
function outlineToSub(loop: Pt[]): SubPath {
  return fitPolyline(loop, 0.9, true);
}

/**
 * Fits a drawn line (or outline) with a few smooth points: drops points within `eps` of the line through their
 * neighbours, then gives gentle bends curve handles along the direction of travel. Sharp bends stay corners.
 */
export function fitPolyline(raw: Pt[], eps: number, closed: boolean): SubPath {
  let pts: Pt[];
  if (closed && raw.length > 3) {
    // A loop's ends meet, so simplify its two halves, split at the point farthest from the start.
    let far = 0, fd = -1;
    raw.forEach((p, i) => { const d = Math.hypot(p.x - raw[0].x, p.y - raw[0].y); if (d > fd) { fd = d; far = i; } });
    pts = [...simplify(raw.slice(0, far + 1), eps).slice(0, -1), ...simplify([...raw.slice(far), raw[0]], eps).slice(0, -1)];
  } else pts = simplify(raw, eps);
  if (closed && pts.length > 2 && Math.hypot(pts[0].x - pts[pts.length - 1].x, pts[0].y - pts[pts.length - 1].y) < eps * 2) pts.pop();
  const n = pts.length;
  const out: PathPoint[] = pts.map((p) => corner(p.x, p.y));
  for (let i = 0; i < n; i++) {
    if (!closed && (i === 0 || i === n - 1)) continue;
    const a = pts[(i - 1 + n) % n], p = pts[i], b = pts[(i + 1) % n];
    const v1x = p.x - a.x, v1y = p.y - a.y, v2x = b.x - p.x, v2y = b.y - p.y;
    const l1 = Math.hypot(v1x, v1y), l2 = Math.hypot(v2x, v2y);
    if (!l1 || !l2) continue;
    const cos = (v1x * v2x + v1y * v2y) / (l1 * l2);
    if (cos < 0.75) continue; // sharper than ~40°: keep the corner
    const tx = (b.x - a.x) / (l1 + l2), ty = (b.y - a.y) / (l1 + l2);
    out[i].ix = p.x - tx * l1 / 3; out[i].iy = p.y - ty * l1 / 3;
    out[i].ox = p.x + tx * l2 / 3; out[i].oy = p.y + ty * l2 / 3;
  }
  return { closed, pts: out };
}

/**
 * Traces the edges of a selection mask (alpha >= 50%) into closed paths, in document pixels. Large masks are traced
 * at reduced size first (it's an outline, so ~2000 px is plenty).
 */
export function maskToSubs(mask: HTMLCanvasElement): SubPath[] {
  const s = Math.min(1, 2000 / Math.max(mask.width, mask.height));
  const W = Math.max(1, Math.round(mask.width * s)), H = Math.max(1, Math.round(mask.height * s));
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const x = c.getContext('2d', { willReadFrequently: true })!;
  x.drawImage(mask, 0, 0, W, H);
  const d = x.getImageData(0, 0, W, H).data;
  const on = (i: number, j: number) => i >= 0 && j >= 0 && i < W && j < H && d[(j * W + i) * 4 + 3] >= 128;
  // Pixel edges between "on" and "off", each directed so the selection stays on the same side, then walked into
  // closed loops.
  const key = (i: number, j: number) => `${i},${j}`;
  const edges: [string, string][] = [];
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
    if (!on(i, j)) continue;
    if (!on(i, j - 1)) edges.push([key(i, j), key(i + 1, j)]);
    if (!on(i + 1, j)) edges.push([key(i + 1, j), key(i + 1, j + 1)]);
    if (!on(i, j + 1)) edges.push([key(i + 1, j + 1), key(i, j + 1)]);
    if (!on(i - 1, j)) edges.push([key(i, j + 1), key(i, j)]);
  }
  const from = new Map<string, string[]>();
  for (const [a, b] of edges) { if (!from.has(a)) from.set(a, []); from.get(a)!.push(b); }
  const subs: SubPath[] = [];
  const k = 1 / s;
  for (const [start] of edges) {
    if (!from.get(start)?.length) continue;
    const loop: Pt[] = [];
    let cur = start;
    for (let guard = 0; guard < 4e6; guard++) {
      const outs = from.get(cur);
      if (!outs?.length) break;
      const nxt = outs.pop()!;
      const [i, j] = cur.split(',').map(Number);
      loop.push({ x: i * k, y: j * k });
      cur = nxt;
      if (cur === start) break;
    }
    if (loop.length >= 4) subs.push(outlineToSub(loop));
  }
  return subs;
}

/** A rectangle, ellipse (four-point circle approximation) or polygon as a closed run. */
export function rectSub(x: number, y: number, w: number, h: number): SubPath {
  return { closed: true, pts: [corner(x, y), corner(x + w, y), corner(x + w, y + h), corner(x, y + h)] };
}
export function ellipseSub(cx: number, cy: number, rx: number, ry: number): SubPath {
  const k = 0.5523;
  return {
    closed: true, pts: [
      { x: cx, y: cy - ry, ix: cx - rx * k, iy: cy - ry, ox: cx + rx * k, oy: cy - ry },
      { x: cx + rx, y: cy, ix: cx + rx, iy: cy - ry * k, ox: cx + rx, oy: cy + ry * k },
      { x: cx, y: cy + ry, ix: cx + rx * k, iy: cy + ry, ox: cx - rx * k, oy: cy + ry },
      { x: cx - rx, y: cy, ix: cx - rx, iy: cy + ry * k, ox: cx - rx, oy: cy - ry * k },
    ],
  };
}
export function polySub(pts: Pt[], closed = true): SubPath {
  return { closed, pts: pts.map((p) => corner(p.x, p.y)) };
}

/** Moves every point and handle of the runs through `f` (e.g. a layer transform). */
export function mapSubs(subs: SubPath[], f: (x: number, y: number) => Pt): SubPath[] {
  return subs.map((s) => ({
    closed: s.closed,
    pts: s.pts.map((p) => {
      const a = f(p.x, p.y), i = f(p.ix, p.iy), o = f(p.ox, p.oy);
      return { x: a.x, y: a.y, ix: i.x, iy: i.y, ox: o.x, oy: o.y };
    }),
  }));
}
