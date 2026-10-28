import { boundsOf, type Pt, type Rect } from './math';
import type { Warp } from './types';

/**
 * Warp presets (like Photoshop's Warp Text and Illustrator's Envelope › Make with Warp): a layer bent into an arc, a
 * flag, a bulge... Stored as settings, not points, so text keeps the shape after it's edited, and it's lossless.
 * Bend and the two distortions run -100..100.
 */
export type EnvelopeStyle = 'arc' | 'arcLower' | 'arcUpper' | 'arch' | 'bulge' | 'flag' | 'wave' | 'fish' | 'rise' | 'fisheye' | 'inflate' | 'squeeze' | 'twist' | 'shape';
/** `fit` (style 'shape'): the outline the layer is fitted into, as four sides in the layer's own pixels. */
export interface Envelope { style: EnvelopeStyle; bend: number; hDistort: number; vDistort: number; vertical: boolean; fit?: ShapeFit }

/**
 * A closed outline split into four sides for fitting a layer into it: top and bottom run left to right, left and
 * right run top to bottom. Each is a list of x, y pairs.
 */
export interface ShapeFit { t: number[]; r: number[]; b: number[]; l: number[] }

export const ENVELOPE_STYLES: [EnvelopeStyle, string][] = [
  ['arc', 'Arc'], ['arcLower', 'Arc Lower'], ['arcUpper', 'Arc Upper'], ['arch', 'Arch'], ['bulge', 'Bulge'],
  ['flag', 'Flag'], ['wave', 'Wave'], ['fish', 'Fish'], ['rise', 'Rise'], ['fisheye', 'Fisheye'],
  ['inflate', 'Inflate'], ['squeeze', 'Squeeze'], ['twist', 'Twist'],
];

export const defaultEnvelope = (): Envelope => ({ style: 'arc', bend: 50, hDistort: 0, vDistort: 0, vertical: false });

export const envelopeLabel = (e: Envelope) => (e.style === 'shape' ? 'Fitted into a shape' : `${ENVELOPE_STYLES.find(([k]) => k === e.style)?.[1] ?? e.style} ${Math.round(e.bend)}%`);

// ---------- fitting into a shape ----------

/** `n` points spaced evenly along a polyline (by length). */
function resample(pts: Pt[], n: number): number[] {
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y));
  const total = cum[cum.length - 1] || 1;
  const out: number[] = [];
  let k = 0;
  for (let i = 0; i < n; i++) {
    const d = (i / (n - 1)) * total;
    while (k < pts.length - 2 && cum[k + 1] < d) k++;
    const seg = cum[k + 1] - cum[k] || 1, t = Math.min(1, Math.max(0, (d - cum[k]) / seg));
    out.push(pts[k].x + (pts[k + 1].x - pts[k].x) * t, pts[k].y + (pts[k + 1].y - pts[k].y) * t);
  }
  return out;
}

/**
 * Splits a closed outline into four sides at the points nearest its bounding box's corners, ready to fit a layer
 * into it. Null if it's too small to use.
 */
export function shapeFit(outline: Pt[]): ShapeFit | null {
  const pts = outline.filter((p, i) => i === 0 || Math.hypot(p.x - outline[i - 1].x, p.y - outline[i - 1].y) > 1e-6);
  if (pts.length > 1 && Math.hypot(pts[0].x - pts[pts.length - 1].x, pts[0].y - pts[pts.length - 1].y) < 1e-6) pts.pop();
  if (pts.length < 3) return null;
  // Clockwise on screen (y down), so the sides come out top, right, bottom, left.
  let area = 0;
  for (let i = 0; i < pts.length; i++) { const a = pts[i], b = pts[(i + 1) % pts.length]; area += a.x * b.y - b.x * a.y; }
  if (area < 0) pts.reverse();
  const bb = boundsOf(pts);
  if (bb.w < 2 || bb.h < 2) return null;
  const n = pts.length;
  const nearest = (x: number, y: number) => { let best = 0, bd = Infinity; pts.forEach((p, i) => { const d = Math.hypot(p.x - x, p.y - y); if (d < bd) { bd = d; best = i; } }); return best; };
  let c = [nearest(bb.x, bb.y), nearest(bb.x + bb.w, bb.y), nearest(bb.x + bb.w, bb.y + bb.h), nearest(bb.x, bb.y + bb.h)];
  // The corners must come round in order; if an odd shape muddles them, split it into even quarters instead.
  const ahead = (i: number) => (c[i] - c[0] + n) % n;
  if (!(ahead(1) > 0 && ahead(2) > ahead(1) && ahead(3) > ahead(2))) c = [0, 1, 2, 3].map((k) => (c[0] + Math.round((k * n) / 4)) % n);
  const walk = (from: number, to: number) => { const out: Pt[] = []; for (let i = from; ; i = (i + 1) % n) { out.push(pts[i]); if (i === to) break; } return out; };
  const M = 96;
  return {
    t: resample(walk(c[0], c[1]), M),
    r: resample(walk(c[1], c[2]), M),
    b: resample(walk(c[2], c[3]).reverse(), M),
    l: resample(walk(c[3], c[0]).reverse(), M),
  };
}

const sideAt = (s: number[], u: number): Pt => {
  const n = s.length / 2 - 1, x = Math.min(n, Math.max(0, u * n)), i = Math.min(n - 1, Math.floor(x)), t = x - i;
  return { x: s[i * 2] + (s[i * 2 + 2] - s[i * 2]) * t, y: s[i * 2 + 1] + (s[i * 2 + 3] - s[i * 2 + 1]) * t };
};

/** A Coons patch: the unit square blended between the four sides, so its edges follow the outline. */
function coons(f: ShapeFit, u: number, v: number): Pt {
  const T = sideAt(f.t, u), B = sideAt(f.b, u), L = sideAt(f.l, v), R = sideAt(f.r, v);
  const p00 = sideAt(f.t, 0), p10 = sideAt(f.t, 1), p01 = sideAt(f.b, 0), p11 = sideAt(f.b, 1);
  const k = (a: number, b: number, c: number, d: number) => (1 - u) * (1 - v) * a + u * (1 - v) * b + (1 - u) * v * c + u * v * d;
  return {
    x: (1 - v) * T.x + v * B.x + (1 - u) * L.x + u * R.x - k(p00.x, p10.x, p01.x, p11.x),
    y: (1 - v) * T.y + v * B.y + (1 - u) * L.y + u * R.y - k(p00.y, p10.y, p01.y, p11.y),
  };
}

/** The style's shape for a horizontal envelope: where (u, v) of the box (0..1 each way) lands. */
function shape(e: Envelope, B: Rect, u: number, v: number): Pt {
  const b = e.bend / 100;
  const cx = B.x + B.w / 2, cy = B.y + B.h / 2;
  const s = u * 2 - 1, t = v * 2 - 1;
  let x = cx + (s * B.w) / 2, y = cy + (t * B.h) / 2;
  const hump = 1 - s * s;
  switch (e.style) {
    case 'arc': {
      // Rows become concentric arcs; the edge on the outside keeps its length.
      const th = Math.abs(b) * Math.PI;
      if (th < 1e-3) break;
      const R = B.w / th, ph = (s * th) / 2;
      if (b > 0) { const r = Math.max(1e-3, R - v * B.h); x = cx + r * Math.sin(ph); y = B.y + R - r * Math.cos(ph); }
      else { const r = Math.max(1e-3, R - (1 - v) * B.h); x = cx + r * Math.sin(ph); y = B.y + B.h - R + r * Math.cos(ph); }
      break;
    }
    case 'arcLower': y += v * b * (B.h / 2) * hump; break;
    case 'arcUpper': y -= (1 - v) * b * (B.h / 2) * hump; break;
    case 'arch': y -= b * (B.h / 2) * hump; break;
    case 'bulge': y += t * b * (B.h / 2) * hump; break;
    case 'flag': y += b * (B.h / 4) * Math.sin(Math.PI * s); break;
    case 'wave': y += b * (B.h / 4) * Math.sin(Math.PI * s - t * Math.PI * 0.5); break;
    case 'fish': y += t * b * (B.h / 2) * Math.sin(Math.PI * Math.pow(u, 0.7)); break;
    case 'rise': y -= b * (B.h / 2) * Math.sin((s * Math.PI) / 2); break;
    case 'fisheye': {
      const k = 1 + b * 0.6 * Math.max(0, 1 - (s * s + t * t) / 2);
      x = cx + (s * B.w / 2) * k; y = cy + (t * B.h / 2) * k;
      break;
    }
    case 'inflate':
      x = cx + (s * B.w / 2) * (1 + b * 0.3 * (1 - t * t));
      y = cy + (t * B.h / 2) * (1 + b * 0.6 * hump);
      break;
    case 'squeeze':
      x = cx + (s * B.w / 2) * (1 - b * 0.5 * (1 - t * t));
      y = cy + (t * B.h / 2) * (1 + b * 0.25 * hump);
      break;
    case 'twist': {
      // Turned in the box's own proportions (as if it were square), so a wide box swirls instead of folding over.
      const r = Math.min(1, Math.hypot(s, t) / Math.SQRT2), a = b * Math.PI * 0.5 * (1 - r);
      x = cx + ((s * Math.cos(a) - t * Math.sin(a)) * B.w) / 2;
      y = cy + ((s * Math.sin(a) + t * Math.cos(a)) * B.h) / 2;
      break;
    }
  }
  // Distortions: one side bigger than the other, like seeing it at an angle.
  const hd = e.hDistort / 100, vd = e.vDistort / 100;
  if (hd) y = cy + (y - cy) * (1 + hd * 0.5 * ((x - cx) / (B.w / 2)));
  if (vd) x = cx + (x - cx) * (1 + vd * 0.5 * ((y - cy) / (B.h / 2)));
  return { x, y };
}

/** Where (u, v) of the layer's box (0..1 each way) lands, in the layer's own pixels. */
export function envelopePoint(e: Envelope, box: Rect, u: number, v: number): Pt {
  if (e.style === 'shape') return e.fit ? coons(e.fit, u, v) : { x: box.x + u * box.w, y: box.y + v * box.h };
  if (!e.vertical) return shape(e, box, u, v);
  // Vertical: the same shapes turned on their side.
  const p = shape(e, { x: box.y, y: box.x, w: box.h, h: box.w }, v, u);
  return { x: p.y, y: p.x };
}

/** The warped layer's bounding box (sampled across it, since some styles push the middle out). */
export function envelopeBounds(e: Envelope, box: Rect): Rect {
  const pts: Pt[] = [];
  const N = 16;
  for (let i = 0; i <= N; i++) for (let j = 0; j <= N; j++) pts.push(envelopePoint(e, box, j / N, i / N));
  return boundsOf(pts);
}

/** The envelope as an editable mesh warp over `box` (image layers: fine-tune it afterwards with Move › Warp). */
export function envelopeMesh(e: Envelope, box: Rect, n = e.style === 'shape' ? 13 : 9): Warp {
  const pts: number[] = [];
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) { const p = envelopePoint(e, box, j / (n - 1), i / (n - 1)); pts.push(p.x, p.y); }
  return { kind: 'mesh', n, pts };
}
