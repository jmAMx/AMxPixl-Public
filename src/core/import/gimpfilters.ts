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
 * GEGL video degradation (approximation): each pixel keeps one colour channel in a staggered RGB pattern, like
 * a CRT's phosphors.
 */
function videoDegradation(p: Px) {
  const { w, d } = p;
  for (let i = 0; i < d.length; i += 4) {
    const x = (i / 4) % w, y = Math.floor(i / 4 / w);
    const keep = (x + (Math.floor(y / 2) % 2) * 2) % 3;
    for (let c = 0; c < 3; c++) if (c !== keep) d[i + c] = 0;
  }
}

export interface FilterSpaces { colorize: boolean; brightness: boolean; huesat: boolean; c2a: boolean }
/** Which filters work in linear light (true) or perceptual sRGB (false). Determined by testing against GIMP. */
export const SPACES: FilterSpaces = { colorize: true, brightness: true, huesat: false, c2a: false };

/** Applies one filter in place. Returns false if AMxPixl doesn't know this filter (the layer is left as is). */
export function applyGimpFilter(p: Px, f: XcfFilter): boolean {
  switch (f.op) {
    case 'gimp:colorize': colorize(p, f.args, SPACES.colorize); return true;
    case 'gimp:brightness-contrast': brightnessContrast(p, f.args, SPACES.brightness); return true;
    case 'gimp:hue-saturation': hueSaturation(p, f.args, SPACES.huesat); return true;
    case 'gegl:color-to-alpha': colorToAlpha(p, f.args, SPACES.c2a); return true;
    case 'gegl:gaussian-blur': gaussianBlur(p, f.args); return true;
    case 'gegl:emboss': emboss(p, f.args); return true;
    case 'gegl:video-degradation': videoDegradation(p); return true;
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
