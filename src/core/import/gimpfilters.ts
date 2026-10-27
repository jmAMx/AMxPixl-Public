import { VIDEO_PATTERNS } from '../effects';
import type { FilterArg, XcfFilter } from './xcf';

/**
 * GIMP 3 non-destructive filters, re-implemented so imported layers look the way they do in GIMP. They run once,
 * on import, baking the result into the layer's pixels. Buffers are float RGBA, straight (not premultiplied)
 * alpha, in perceptual sRGB unless a filter says otherwise.
 */
export interface Px { w: number; h: number; d: Float32Array }

const toLin = (v: number) => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
const toSrgb = (v: number) => (v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(Math.max(0, v), 1 / 2.4) - 0.055);
const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

function mapRgb(p: Px, f: (r: number, g: number, b: number, a: number) => [number, number, number] | [number, number, number, number], linear: boolean) {
  const d = p.d;
  for (let i = 0; i < d.length; i += 4) {
    let r = d[i], g = d[i + 1], b = d[i + 2];
    if (linear) { r = toLin(r); g = toLin(g); b = toLin(b); }
    const o = f(r, g, b, d[i + 3]);
    d[i] = linear ? toSrgb(o[0]) : o[0];
    d[i + 1] = linear ? toSrgb(o[1]) : o[1];
    d[i + 2] = linear ? toSrgb(o[2]) : o[2];
    if (o.length === 4) d[i + 3] = o[3];
  }
}

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2, dd = mx - mn;
  if (dd < 1e-9) return [0, 0, l];
  const s = l > 0.5 ? dd / (2 - mx - mn) : dd / (mx + mn);
  let h = mx === r ? (g - b) / dd + (g < b ? 6 : 0) : mx === g ? (b - r) / dd + 2 : (r - g) / dd + 4;
  return [h / 6, s, l];
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  if (s === 0) return [l, l, l];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
  const f = (t: number) => {
    t = ((t % 1) + 1) % 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return [f(h + 1 / 3), f(h), f(h - 1 / 3)];
}

const num = (v: FilterArg | undefined, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

/** Values from a GIMP config string like "(range all) (hue 0) (saturation -0.4) ...", grouped by range. */
function parseConfig(s: string): { flat: Record<string, number>; ranges: Record<string, Record<string, number>> } {
  const flat: Record<string, number> = {}, ranges: Record<string, Record<string, number>> = {};
  let range = 'all';
  for (const m of s.matchAll(/\((\S+)\s+([^()]+)\)/g)) {
    const k = m[1], v = m[2].trim();
    if (k === 'range') { range = v; ranges[range] ??= {}; continue; }
    const n = parseFloat(v);
    if (Number.isNaN(n)) continue;
    flat[k] = n;
    (ranges[range] ??= {})[k] = n;
  }
  return { flat, ranges };
}

// ---------- the filters ----------

function colorize(p: Px, a: Record<string, FilterArg>, linear: boolean) {
  const hue = num(a.hue, 0.5), sat = num(a.saturation, 0.5), light = num(a.lightness, 0);
  mapRgb(p, (r, g, b) => {
    let l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    if (light > 0) l = l * (1 - light) + light;
    else if (light < 0) l = l * (light + 1);
    return hslToRgb(hue, sat, l);
  }, linear);
}

function brightnessContrast(p: Px, a: Record<string, FilterArg>, linear: boolean) {
  const c = parseConfig(String(a.config ?? '')).flat;
  const br = (c.brightness ?? 0) / 2, slant = Math.tan(((c.contrast ?? 0) + 1) * (Math.PI / 4));
  const f = (v: number) => ((br < 0 ? v * (1 + br) : v + (1 - v) * br) - 0.5) * slant + 0.5;
  mapRgb(p, (r, g, b) => [f(r), f(g), f(b)], linear);
}

const HUE_RANGES = ['red', 'yellow', 'green', 'cyan', 'blue', 'magenta'];

function hueSaturation(p: Px, a: Record<string, FilterArg>, linear: boolean) {
  const { ranges } = parseConfig(String(a.config ?? ''));
  const get = (r: string, k: string) => ranges[r]?.[k] ?? 0;
  mapRgb(p, (r, g, b) => {
    let [h, s, l] = rgbToHsl(r, g, b);
    const range = HUE_RANGES[Math.floor(((h * 6 + 0.5) % 6 + 6) % 6)];
    h = (h + (get('all', 'hue') + get(range, 'hue')) / 2 + 1) % 1;
    s = clamp01(s * (get('all', 'saturation') + get(range, 'saturation') + 1));
    const v = (get('all', 'lightness') + get(range, 'lightness')) / 2;
    l = v < 0 ? l * (v + 1) : l + v * (1 - l);
    return hslToRgb(h, s, l);
  }, linear);
}

function colorToAlpha(p: Px, a: Record<string, FilterArg>, linear: boolean) {
  const col = (Array.isArray(a.color) ? a.color : [1, 1, 1]).slice(0, 3).map((v) => (linear ? v : toSrgb(v)));
  const tt = num(a['transparency-threshold'], 0), ot = num(a['opacity-threshold'], 1);
  const eps = 1e-5;
  mapRgb(p, (r, g, b, al) => {
    const src = [r, g, b];
    let alpha = 0, dist = 0;
    for (let i = 0; i < 3; i++) {
      const d = Math.abs(src[i] - col[i]);
      let x: number;
      if (d < tt + eps) x = 0;
      else if (d > ot - eps) x = 1;
      else if (src[i] < col[i]) x = (d - tt) / (Math.min(ot, col[i]) - tt);
      else x = (d - tt) / (Math.min(ot, 1 - col[i]) - tt);
      if (x > alpha) { alpha = x; dist = d; }
    }
    const out = [...src];
    if (alpha > eps) {
      const ratio = tt / dist, inv = 1 / alpha;
      for (let i = 0; i < 3; i++) {
        const c = col[i] + (src[i] - col[i]) * ratio;
        out[i] = c + (src[i] - c) * inv;
      }
    }
    return [out[0], out[1], out[2], al * alpha];
  }, linear);
}

/** Box sizes whose three passes approximate a Gaussian of `sigma`. */
function boxes(sigma: number): number[] {
  const n = 3;
  const wIdeal = Math.sqrt((12 * sigma * sigma) / n + 1);
  let wl = Math.floor(wIdeal);
  if (wl % 2 === 0) wl--;
  const wu = wl + 2;
  const m = Math.round((12 * sigma * sigma - n * wl * wl - 4 * n * wl - 3 * n) / (-4 * wl - 4));
  return [0, 1, 2].map((i) => (i < m ? wl : wu));
}

/** One box-blur pass along rows (horizontal) or columns, clamping at the edges. */
function boxPass(src: Float32Array, dst: Float32Array, w: number, h: number, r: number, horizontal: boolean) {
  const len = horizontal ? w : h, lines = horizontal ? h : w;
  const step = horizontal ? 4 : w * 4;
  const inv = 1 / (2 * r + 1);
  for (let line = 0; line < lines; line++) {
    const base = horizontal ? line * w * 4 : line * 4;
    for (let c = 0; c < 4; c++) {
      const at = (i: number) => src[base + Math.min(len - 1, Math.max(0, i)) * step + c];
      let acc = 0;
      for (let i = -r; i <= r; i++) acc += at(i);
      for (let i = 0; i < len; i++) {
        dst[base + i * step + c] = acc * inv;
        acc += at(i + r + 1) - at(i - r);
      }
    }
  }
}

/** Gaussian blur in linear light with premultiplied alpha (like GEGL), kept within the layer. */
function gaussianBlur(p: Px, a: Record<string, FilterArg>) {
  const sx = num(a['std-dev-x'], 1.5), sy = num(a['std-dev-y'], sx);
  const { w, h, d } = p;
  for (let i = 0; i < d.length; i += 4) { const al = d[i + 3]; d[i] = toLin(d[i]) * al; d[i + 1] = toLin(d[i + 1]) * al; d[i + 2] = toLin(d[i + 2]) * al; }
  const tmp = new Float32Array(d.length);
  if (sx > 0.1) for (const bx of boxes(sx)) { boxPass(d, tmp, w, h, (bx - 1) / 2, true); d.set(tmp); }
  if (sy > 0.1) for (const by of boxes(sy)) { boxPass(d, tmp, w, h, (by - 1) / 2, false); d.set(tmp); }
  for (let i = 0; i < d.length; i += 4) {
    const al = d[i + 3];
    for (let c = 0; c < 3; c++) d[i + c] = al > 1e-6 ? toSrgb(d[i + c] / al) : 0;
  }
}

/** GEGL emboss: light the image as a height map from the given direction. */
function emboss(p: Px, a: Record<string, FilterArg>) {
  const az = (num(a.azimuth, 30) * Math.PI) / 180, el = (num(a.elevation, 45) * Math.PI) / 180, depth = Math.max(1, num(a.depth, 20));
  const Lx = Math.cos(az) * Math.cos(el), Ly = Math.sin(az) * Math.cos(el), Lz = Math.sin(el);
  const Nz = 1 / depth, Nz2 = Nz * Nz, NzLz = Nz * Lz;
  const { w, h, d } = p;
  const lum = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) lum[i] = (0.2126 * d[i * 4] + 0.7152 * d[i * 4 + 1] + 0.0722 * d[i * 4 + 2]) * d[i * 4 + 3];
  const L = (x: number, y: number) => lum[Math.min(h - 1, Math.max(0, y)) * w + Math.min(w - 1, Math.max(0, x))];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const Nx = L(x - 1, y - 1) + L(x - 1, y) + L(x - 1, y + 1) - L(x + 1, y - 1) - L(x + 1, y) - L(x + 1, y + 1);
    const Ny = L(x - 1, y + 1) + L(x, y + 1) + L(x + 1, y + 1) - L(x - 1, y - 1) - L(x, y - 1) - L(x + 1, y - 1);
    let shade: number;
    if (Nx === 0 && Ny === 0) shade = Lz;
    else {
      const NdotL = Nx * Lx + Ny * Ly + NzLz;
      shade = NdotL < 0 ? 0 : NdotL / Math.sqrt(Nx * Nx + Ny * Ny + Nz2);
    }
    const i = (y * w + x) * 4;
    d[i] = d[i + 1] = d[i + 2] = clamp01(shade);
  }
}

/**
 * GEGL median-blur (radius 1) as the bevel uses it: alpha takes the given percentile of its 3×3 neighbourhood,
 * which grows the shape's edge slightly. (The colour median is skipped: the bevel blurs the colour right after.)
 */
function median3(p: Px, alphaPct: number) {
  const { w, h, d } = p;
  const out = new Float32Array(w * h);
  const v = new Float32Array(9);
  const k = Math.min(8, Math.round((alphaPct / 100) * 8));
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let n = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const xx = Math.min(w - 1, Math.max(0, x + dx)), yy = Math.min(h - 1, Math.max(0, y + dy));
      v[n++] = d[(yy * w + xx) * 4 + 3];
    }
    v.sort();
    out[y * w + x] = v[k];
  }
  for (let i = 0; i < out.length; i++) d[i * 4 + 3] = out[i];
}

/** SVG-style blend of `top` over `base` in linear light, premultiplied (how GEGL's blend ops work). */
function svgBlend(base: Px, top: Px, mode: number) {
  const b = base.d, t = top.d;
  const f = (s: number, sa: number, dd: number, da: number) => {
    switch (mode) {
      case 0: return s; // replace ("none")
      case 2: return s * dd + s * (1 - da) + dd * (1 - sa); // multiply
      case 3: { // colour dodge
        if (s * da + dd * sa >= sa * da) return sa * da + s * (1 - da) + dd * (1 - sa);
        return (dd * sa) / (1 - s / Math.max(sa, 1e-6)) * (sa > 0 ? 1 : 0) + s * (1 - da) + dd * (1 - sa);
      }
      case 4: return Math.min(s * da, dd * sa) + s * (1 - da) + dd * (1 - sa); // darken
      case 5: return Math.max(s * da, dd * sa) + s * (1 - da) + dd * (1 - sa); // lighten
      case 6: return s + dd; // add
      default: // hard light
        return 2 * s <= sa
          ? 2 * s * dd + s * (1 - da) + dd * (1 - sa)
          : sa * da - 2 * (da - dd) * (sa - s) + s * (1 - da) + dd * (1 - sa);
    }
  };
  for (let i = 0; i < b.length; i += 4) {
    const sa = t[i + 3], da = b[i + 3];
    const oa = mode === 0 ? sa : sa + da - sa * da;
    for (let c = 0; c < 3; c++) {
      const s = toLin(t[i + c]) * sa, dd = toLin(b[i + c]) * da;
      const o = f(s, sa, dd, da);
      b[i + c] = oa > 1e-6 ? toSrgb(clamp01(o / oa)) : 0;
    }
    b[i + 3] = clamp01(oa);
  }
}

/** Distance (in pixels) from each pixel to the nearest transparent one, by the chosen metric (two-pass chamfer). */
function distanceMap(p: Px, metric: number): Float32Array {
  const { w, h, d } = p;
  const INF = 1e9, dist = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) dist[i] = d[i * 4 + 3] > 0.5 ? INF : 0;
  const diag = metric === 0 ? Math.SQRT2 : metric === 1 ? 2 : 1; // euclidean (approx.), manhattan, chebyshev
  const at = (x: number, y: number) => (x < 0 || y < 0 || x >= w || y >= h ? 0 : dist[y * w + x]);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    if (!dist[i]) continue;
    dist[i] = Math.min(dist[i], at(x - 1, y) + 1, at(x, y - 1) + 1, at(x - 1, y - 1) + diag, at(x + 1, y - 1) + diag);
  }
  for (let y = h - 1; y >= 0; y--) for (let x = w - 1; x >= 0; x--) {
    const i = y * w + x;
    if (!dist[i]) continue;
    dist[i] = Math.min(dist[i], at(x + 1, y) + 1, at(x, y + 1) + 1, at(x + 1, y + 1) + diag, at(x - 1, y + 1) + diag);
  }
  return dist;
}

/**
 * GEGL bevel (GIMP 3's Filters › Light and Shadow › Bevel). Bump: blur the layer, light the blur as a height map
 * and blend that lighting back over it, then firm up the soft edge. Chamfer: light a distance map instead, so the
 * edge slopes evenly. Follows GEGL's node graph; the final edge clean-up is approximated.
 */
function bevel(p: Px, a: Record<string, FilterArg>) {
  const type = num(a.type, 0), mode = num(a.blendmode, 1);
  const az = num(a.azimuth, 68), el = num(a.elevation, 25), depth = num(a.depth, 40);
  median3(p, 80);
  if (type === 1) {
    gaussianBlur(p, { 'std-dev-x': num(a.radius, 3), 'std-dev-y': num(a.radius, 3) });
    const light: Px = { w: p.w, h: p.h, d: p.d.slice() };
    emboss(light, { azimuth: az, elevation: el, depth });
    if (mode === 0) {
      // No blending: the lighting itself, with its alpha boosted.
      p.d.set(light.d);
      for (let i = 3; i < p.d.length; i += 4) p.d[i] = clamp01(p.d[i] * 2.2);
      return;
    }
    svgBlend(p, light, mode);
    // Firm up the edge: boost alpha, then drop the faintest fringe.
    for (let i = 3; i < p.d.length; i += 4) {
      const al = clamp01(p.d[i] * 1.7);
      p.d[i] = al < 0.4 ? al * Math.max(0, (al - 0.15) / 0.25) : al;
    }
    return;
  }
  // Chamfer: emboss a distance map of the shape, at 80% opacity, blended over the shape and kept inside it.
  const dist = distanceMap(p, num(a.metric, 2));
  const light: Px = { w: p.w, h: p.h, d: new Float32Array(p.d.length) };
  for (let i = 0; i < dist.length; i++) {
    const v = Math.min(1, dist[i] / 255);
    light.d[i * 4] = light.d[i * 4 + 1] = light.d[i * 4 + 2] = v;
    light.d[i * 4 + 3] = 1;
  }
  emboss(light, { azimuth: az, elevation: el, depth: Math.max(1, Math.trunc((depth / 100) * 15)) });
  for (let i = 3; i < light.d.length; i += 4) light.d[i] = 0.8;
  const alpha = Float32Array.from({ length: dist.length }, (_, i) => p.d[i * 4 + 3]);
  svgBlend(p, light, mode);
  for (let i = 0; i < alpha.length; i++) p.d[i * 4 + 3] = alpha[i];
}

/**
 * GEGL video degradation: a CRT-style RGB pattern. Each pixel keeps one colour channel; "additive" (the default)
 * instead doubles that channel on top of the original, which brightens it.
 */
function videoDegradation(p: Px, a: Record<string, FilterArg>) {
  const [pw, ph, cells] = VIDEO_PATTERNS[num(a.pattern, 2)] ?? VIDEO_PATTERNS[2];
  const additive = num(a.additive, 1) !== 0, rotated = num(a.rotated, 0) !== 0;
  const { w, d } = p;
  for (let i = 0; i < d.length; i += 4) {
    const x = (i / 4) % w, y = Math.floor(i / 4 / w);
    const sel = +cells[rotated ? pw * (x % ph) + (y % pw) : pw * (y % ph) + (x % pw)];
    for (let c = 0; c < 3; c++) {
      const v = c === sel ? d[i + c] : 0;
      d[i + c] = additive ? Math.min(1, v + d[i + c]) : v;
    }
  }
}

export interface FilterSpaces { colorize: boolean; brightness: boolean; huesat: boolean; c2a: boolean }
/** Which filters work in linear light (true) or perceptual sRGB (false). Determined by testing against GIMP. */
export const SPACES: FilterSpaces = { colorize: true, brightness: true, huesat: true, c2a: false };

/** Applies one filter in place. Returns false if AMxPixl doesn't know this filter (the layer is left as is). */
export function applyGimpFilter(p: Px, f: XcfFilter): boolean {
  switch (f.op) {
    case 'gimp:colorize': colorize(p, f.args, SPACES.colorize); return true;
    case 'gimp:brightness-contrast': brightnessContrast(p, f.args, SPACES.brightness); return true;
    case 'gimp:hue-saturation': hueSaturation(p, f.args, SPACES.huesat); return true;
    case 'gegl:color-to-alpha': colorToAlpha(p, f.args, SPACES.c2a); return true;
    case 'gegl:gaussian-blur': gaussianBlur(p, f.args); return true;
    case 'gegl:emboss': emboss(p, f.args); return true;
    case 'gegl:video-degradation': videoDegradation(p, f.args); return true;
    case 'gegl:bevel': bevel(p, f.args); return true;
    case 'gimp:desaturate': mapRgb(p, (r, g, b) => { const l = 0.2126 * r + 0.7152 * g + 0.0722 * b; return [l, l, l]; }, true); return true;
    case 'gegl:invert-gamma': case 'gegl:invert': mapRgb(p, (r, g, b) => [1 - r, 1 - g, 1 - b], false); return true;
    default: return false;
  }
}

export const toPx = (img: ImageData): Px => ({ w: img.width, h: img.height, d: Float32Array.from(img.data, (v) => v / 255) });

export function fromPx(p: Px): ImageData {
  const out = new ImageData(p.w, p.h);
  for (let i = 0; i < p.d.length; i++) out.data[i] = Math.round(clamp01(p.d[i]) * 255);
  return out;
}
