import { boundsOf, type Pt, type Rect } from './math';
import type { Warp } from './types';

/**
 * Warp presets (like Photoshop's Warp Text and Illustrator's Envelope › Make with Warp): a layer bent into an arc, a
 * flag, a bulge... Stored as settings, not points, so text keeps the shape after it's edited, and it's lossless.
 * Bend and the two distortions run -100..100.
 */
export type EnvelopeStyle = 'arc' | 'arcLower' | 'arcUpper' | 'arch' | 'bulge' | 'flag' | 'wave' | 'fish' | 'rise' | 'fisheye' | 'inflate' | 'squeeze' | 'twist';
export interface Envelope { style: EnvelopeStyle; bend: number; hDistort: number; vDistort: number; vertical: boolean }

export const ENVELOPE_STYLES: [EnvelopeStyle, string][] = [
  ['arc', 'Arc'], ['arcLower', 'Arc Lower'], ['arcUpper', 'Arc Upper'], ['arch', 'Arch'], ['bulge', 'Bulge'],
  ['flag', 'Flag'], ['wave', 'Wave'], ['fish', 'Fish'], ['rise', 'Rise'], ['fisheye', 'Fisheye'],
  ['inflate', 'Inflate'], ['squeeze', 'Squeeze'], ['twist', 'Twist'],
];

export const defaultEnvelope = (): Envelope => ({ style: 'arc', bend: 50, hDistort: 0, vDistort: 0, vertical: false });

export const envelopeLabel = (e: Envelope) => `${ENVELOPE_STYLES.find(([k]) => k === e.style)?.[1] ?? e.style} ${Math.round(e.bend)}%`;

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
export function envelopeMesh(e: Envelope, box: Rect, n = 9): Warp {
  const pts: number[] = [];
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) { const p = envelopePoint(e, box, j / (n - 1), i / (n - 1)); pts.push(p.x, p.y); }
  return { kind: 'mesh', n, pts };
}
