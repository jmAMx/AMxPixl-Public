import type { AdjKind, AdjParams, Channel, CurvePts, LevelsCh } from './types';

export const ADJ_LABELS: Record<AdjKind, string> = {
  brightness: 'Brightness/Contrast',
  levels: 'Levels',
  curves: 'Curves',
  exposure: 'Exposure',
  huesat: 'Hue/Saturation',
  vibrance: 'Vibrance',
  colorbalance: 'Color Balance',
  bw: 'Black & White',
  invert: 'Invert',
  threshold: 'Threshold',
  posterize: 'Posterize',
  hsl: 'HSL / Colour Mixer',
  grade: 'Colour Grading',
  gradmap: 'Gradient Map',
  mixer: 'Channel Mixer',
  photofilter: 'Photo Filter',
  lut: 'Colour Lookup (LUT)',
};

export const ADJ_ORDER: AdjKind[] = [
  'brightness', 'levels', 'curves', 'exposure', 'huesat', 'hsl', 'vibrance', 'colorbalance', 'grade', 'photofilter',
  'lut', 'mixer', 'gradmap', 'bw', 'invert', 'threshold', 'posterize',
];

export const HSL_BANDS: [string, string][] = [
  ['Reds', '#e5484d'], ['Oranges', '#f2994a'], ['Yellows', '#f2d74a'], ['Greens', '#46a758'],
  ['Aquas', '#3dbfc4'], ['Blues', '#3e7bfa'], ['Purples', '#8e4ec6'], ['Magentas', '#d6409f'],
];

const levels0 = (): LevelsCh => ({ inBlack: 0, inWhite: 255, gamma: 1, outBlack: 0, outWhite: 255 });
const curve0 = (): CurvePts => [[0, 0], [255, 255]];

export function defaultAdj(kind: AdjKind): AdjParams {
  switch (kind) {
    case 'brightness': return { kind, brightness: 0, contrast: 0 };
    case 'levels': return { kind, ch: { rgb: levels0(), r: levels0(), g: levels0(), b: levels0() } };
    case 'curves': return { kind, ch: { rgb: curve0(), r: curve0(), g: curve0(), b: curve0() } };
    case 'huesat': return { kind, hue: 0, sat: 0, light: 0 };
    case 'vibrance': return { kind, vibrance: 0, saturation: 0 };
    case 'exposure': return { kind, exposure: 0, offset: 0, gamma: 1 };
    case 'colorbalance': return { kind, shadows: [0, 0, 0], midtones: [0, 0, 0], highlights: [0, 0, 0] };
    case 'bw': return { kind, tint: null };
    case 'invert': return { kind };
    case 'threshold': return { kind, level: 128 };
    case 'posterize': return { kind, levels: 4 };
    case 'hsl': return { kind, bands: HSL_BANDS.map(() => [0, 0, 0] as [number, number, number]) };
    case 'grade': return { kind, balance: 0, shadows: { hue: 200, amount: 0, lum: 0 }, midtones: { hue: 30, amount: 0, lum: 0 }, highlights: { hue: 40, amount: 0, lum: 0 } };
    case 'gradmap': return { kind, dark: '#10141f', mid: '#a0525a', light: '#f6e7c8', useMid: false, reverse: false };
    case 'mixer': return { kind, r: [100, 0, 0], g: [0, 100, 0], b: [0, 0, 100], mono: false };
    case 'photofilter': return { kind, color: '#ec8a00', density: 25, preserve: true };
    case 'lut': return { kind, key: null, name: '', size: 0, intensity: 100 };
  }
}

/** A grading wheel's colour push as an RGB offset (no brightness change) plus its brightness shift. */
export function wheelOffset(w: { hue: number; amount: number; lum: number }): [number, number, number, number] {
  const h = (((w.hue % 360) + 360) % 360) / 60;
  const x = 1 - Math.abs((h % 2) - 1);
  const [r, g, b] = h < 1 ? [1, x, 0] : h < 2 ? [x, 1, 0] : h < 3 ? [0, 1, x] : h < 4 ? [0, x, 1] : h < 5 ? [x, 0, 1] : [1, 0, x];
  const l = r * 0.299 + g * 0.587 + b * 0.114;
  const k = (w.amount / 100) * 0.3;
  return [(r - l) * k, (g - l) * k, (b - l) * k, (w.lum / 100) * 0.25];
}

/** Which shader path an adjustment uses: 0 = per-channel lookup table, 1+ = dedicated math. */
export function adjMode(a: AdjParams): number {
  switch (a.kind) {
    case 'huesat': return 1;
    case 'vibrance': return 2;
    case 'bw': return 3;
    case 'threshold': return 4;
    case 'hsl': return 5;
    case 'grade': return 6;
    case 'gradmap': return 7;
    case 'mixer': return 8;
    case 'photofilter': return 9;
    default: return 0;
  }
}

const hexRgb = (h: string) => { const n = parseInt(h.slice(1), 16) || 0; return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };

/** Gradient-map colours by brightness (256 x 1 RGBA). */
function gradientTable(a: Extract<AdjParams, { kind: 'gradmap' }>): Uint8Array {
  const stops: [number, number[]][] = a.useMid ? [[0, hexRgb(a.dark)], [0.5, hexRgb(a.mid)], [1, hexRgb(a.light)]] : [[0, hexRgb(a.dark)], [1, hexRgb(a.light)]];
  const lut = new Uint8Array(256 * 4);
  for (let i = 0; i < 256; i++) {
    let t = i / 255;
    if (a.reverse) t = 1 - t;
    let s = 0;
    while (s < stops.length - 2 && t > stops[s + 1][0]) s++;
    const [p0, c0] = stops[s], [p1, c1] = stops[s + 1];
    const k = Math.min(1, Math.max(0, (t - p0) / (p1 - p0)));
    for (let c = 0; c < 3; c++) lut[i * 4 + c] = Math.round(c0[c] + (c1[c] - c0[c]) * k);
    lut[i * 4 + 3] = 255;
  }
  return lut;
}

const c8 = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v));

function levelsMap(l: LevelsCh, v: number) {
  const span = Math.max(1, l.inWhite - l.inBlack);
  let t = Math.min(1, Math.max(0, (v - l.inBlack) / span));
  t = Math.pow(t, 1 / Math.max(0.01, l.gamma));
  return l.outBlack + t * (l.outWhite - l.outBlack);
}

/** Monotone cubic interpolation through the curve's points (no overshoot), sampled at 0..255. */
export function curveTable(pts: CurvePts): Float32Array {
  const p = [...pts].sort((a, b) => a[0] - b[0]);
  const out = new Float32Array(256);
  const n = p.length;
  if (n === 1) { out.fill(p[0][1]); return out; }
  const dx: number[] = [], m: number[] = [];
  for (let i = 0; i < n - 1; i++) { dx.push(p[i + 1][0] - p[i][0] || 1e-6); m.push((p[i + 1][1] - p[i][1]) / dx[i]); }
  const t: number[] = [m[0]];
  for (let i = 1; i < n - 1; i++) t.push(m[i - 1] * m[i] <= 0 ? 0 : (m[i - 1] + m[i]) / 2);
  t.push(m[n - 2]);
  for (let i = 0; i < n - 1; i++) {
    if (m[i] === 0) { t[i] = 0; t[i + 1] = 0; continue; }
    const a = t[i] / m[i], b = t[i + 1] / m[i], s = a * a + b * b;
    if (s > 9) { const k = 3 / Math.sqrt(s); t[i] = k * a * m[i]; t[i + 1] = k * b * m[i]; }
  }
  let seg = 0;
  for (let x = 0; x < 256; x++) {
    if (x <= p[0][0]) { out[x] = p[0][1]; continue; }
    if (x >= p[n - 1][0]) { out[x] = p[n - 1][1]; continue; }
    while (seg < n - 2 && x > p[seg + 1][0]) seg++;
    const h = dx[seg], u = (x - p[seg][0]) / h;
    const u2 = u * u, u3 = u2 * u;
    out[x] = (2 * u3 - 3 * u2 + 1) * p[seg][1] + (u3 - 2 * u2 + u) * h * t[seg] + (-2 * u3 + 3 * u2) * p[seg + 1][1] + (u3 - u2) * h * t[seg + 1];
  }
  return out;
}

const toLin = (v: number) => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
const toSrgb = (v: number) => (v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055);

/** RGBA lookup table (256 x 1) for the table-driven adjustments. */
export function buildLut(a: AdjParams): Uint8Array {
  if (a.kind === 'gradmap') return gradientTable(a);
  const lut = new Uint8Array(256 * 4);
  const chans: (keyof typeof idx)[] = ['r', 'g', 'b'];
  const idx = { r: 0, g: 1, b: 2 } as const;
  let f: (v: number, c: 'r' | 'g' | 'b') => number = (v) => v;
  switch (a.kind) {
    case 'brightness': {
      const g = Math.pow(2, -a.brightness / 100);
      const k = Math.tan(((Math.max(-100, Math.min(100, a.contrast)) / 100) * 0.98 + 1) * (Math.PI / 4));
      f = (v) => ((Math.pow(v / 255, g) - 0.5) * k + 0.5) * 255;
      break;
    }
    case 'levels':
      f = (v, c) => levelsMap(a.ch.rgb, levelsMap(a.ch[c], v));
      break;
    case 'curves': {
      const tabs: Record<Channel, Float32Array> = { rgb: curveTable(a.ch.rgb), r: curveTable(a.ch.r), g: curveTable(a.ch.g), b: curveTable(a.ch.b) };
      f = (v, c) => tabs.rgb[c8(tabs[c][v])];
      break;
    }
    case 'exposure': {
      const mult = Math.pow(2, a.exposure);
      f = (v) => {
        let x = toLin(v / 255) * mult + a.offset;
        x = Math.pow(Math.max(0, x), 1 / Math.max(0.01, a.gamma));
        return toSrgb(Math.min(1, x)) * 255;
      };
      break;
    }
    case 'colorbalance': {
      f = (v, c) => {
        const i = idx[c], t = v / 255;
        const sh = (1 - t) * (1 - t), hi = t * t, mid = 1 - (2 * t - 1) * (2 * t - 1);
        return v + ((a.shadows[i] * sh + a.midtones[i] * mid + a.highlights[i] * hi) / 100) * 64;
      };
      break;
    }
    case 'invert': f = (v) => 255 - v; break;
    case 'posterize': {
      const n = Math.max(2, Math.round(a.levels));
      f = (v) => (Math.round((v / 255) * (n - 1)) / (n - 1)) * 255;
      break;
    }
    default: break;
  }
  for (let v = 0; v < 256; v++) {
    for (const c of chans) lut[v * 4 + idx[c]] = c8(f(v, c));
    lut[v * 4 + 3] = 255;
  }
  return lut;
}

export interface Histogram { r: Uint32Array; g: Uint32Array; b: Uint32Array; l: Uint32Array; max: number }

export function histogram(data: ImageData): Histogram {
  const r = new Uint32Array(256), g = new Uint32Array(256), b = new Uint32Array(256), l = new Uint32Array(256);
  const d = data.data;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] === 0) continue;
    r[d[i]]++; g[d[i + 1]]++; b[d[i + 2]]++;
    l[(d[i] * 77 + d[i + 1] * 150 + d[i + 2] * 29) >> 8]++;
  }
  let max = 1;
  for (let i = 1; i < 255; i++) max = Math.max(max, r[i], g[i], b[i], l[i]);
  return { r, g, b, l, max };
}
