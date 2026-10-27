import type { FxParams } from './types';

/**
 * Effect layers: GPU shaders that restyle everything beneath them (or just a group / clipped layer).
 * Sizes are in document pixels, so the on-screen preview matches the export at any zoom.
 */

export type FxValue = number | string | boolean;

export type FxParam =
  | { key: string; label: string; type: 'range'; min: number; max: number; step?: number; value: number; unit?: string }
  | { key: string; label: string; type: 'bool'; value: boolean }
  | { key: string; label: string; type: 'color'; value: string }
  | { key: string; label: string; type: 'select'; value: string; options: [string, string][] };

export interface FxEnv {
  /** Output pixels per document pixel. */
  scale: number;
}

type V = Record<string, FxValue>;
type Uniforms = Partial<Record<'uA' | 'uB' | 'uC', [number, number, number, number]> & Record<'uCol1' | 'uCol2', [number, number, number]>>;

export interface FxDef {
  kind: string;
  label: string;
  group: 'Film' | 'Lens' | 'CRT & VHS' | 'Damage & Print';
  params: FxParam[];
  /** Whether the effect uses its random seed (shows a "new variation" button; animates by re-rolling). */
  seeded?: boolean;
  /** Whether the shader moves with `uTime` (seconds) when the layer's motion is on. */
  moves?: boolean;
  /** Extra blurred input: the whole image, or just its highlights above a threshold (0..1). */
  aux?: { radius: (v: V) => number; threshold?: (v: V) => number };
  uniforms: (v: V) => Uniforms;
  /** GLSL defining `vec4 fx(vec2 p, vec2 d)`: p = output pixel, d = document pixel. */
  glsl: string;
}

const n = (v: FxValue) => Number(v);
export const hex3 = (h: FxValue): [number, number, number] => {
  const x = parseInt(String(h).slice(1), 16) || 0;
  return [((x >> 16) & 255) / 255, ((x >> 8) & 255) / 255, (x & 255) / 255];
};
const sel = (v: FxValue, opts: string[]) => Math.max(0, opts.indexOf(String(v)));

export const FX_DEFS: FxDef[] = [
  // ---------- Film ----------
  {
    kind: 'grain', label: 'Film Grain', group: 'Film', seeded: true,
    params: [
      { key: 'amount', label: 'Amount', type: 'range', min: 0, max: 100, value: 25, unit: '%' },
      { key: 'size', label: 'Grain size', type: 'range', min: 0.5, max: 8, step: 0.1, value: 1.5, unit: 'px' },
      { key: 'rough', label: 'Roughness', type: 'range', min: 0, max: 100, value: 50, unit: '%' },
      { key: 'color', label: 'Colour grain', type: 'range', min: 0, max: 100, value: 0, unit: '%' },
      { key: 'response', label: 'Midtone bias', type: 'range', min: 0, max: 100, value: 70, unit: '%' },
    ],
    uniforms: (v) => ({ uA: [n(v.amount) / 100, n(v.size), n(v.rough) / 100, n(v.color) / 100], uB: [n(v.response) / 100, 0, 0, 0] }),
    glsl: `
vec4 fx(vec2 p, vec2 d) {
  vec4 c = src(p);
  vec2 g = d / uA.y;
  float n1 = vnoise(g) - 0.5, n2 = vnoise(g * 2.13 + 17.3) - 0.5;
  float nn = mix(n1, n1 * 0.6 + n2 * 0.8, uA.z);
  vec3 nc = vec3(vnoise(g + 41.7), vnoise(g + 93.1), vnoise(g + 7.9)) - 0.5;
  float att = clamp(uScale * uA.y, 0.15, 1.0);
  float l = lum(c.rgb);
  float w = mix(1.0, 1.0 - pow(abs(2.0 * l - 1.0), 2.0), uB.x);
  vec3 grain = (vec3(nn) * (1.0 - uA.w) + nc * uA.w) * 2.0;
  c.rgb += grain * uA.x * 0.6 * w * att;
  return c;
}`,
  },
  {
    kind: 'halation', label: 'Halation', group: 'Film',
    params: [
      { key: 'threshold', label: 'Threshold', type: 'range', min: 0, max: 100, value: 65, unit: '%' },
      { key: 'radius', label: 'Spread', type: 'range', min: 1, max: 200, value: 18, unit: 'px' },
      { key: 'strength', label: 'Strength', type: 'range', min: 0, max: 300, value: 90, unit: '%' },
      { key: 'tint', label: 'Colour', type: 'color', value: '#ff4a1a' },
    ],
    aux: { radius: (v) => n(v.radius), threshold: (v) => n(v.threshold) / 100 },
    uniforms: (v) => ({ uA: [n(v.strength) / 100, 0, 0, 0], uCol1: hex3(v.tint) }),
    glsl: `
vec4 fx(vec2 p, vec2 d) {
  vec4 c = src(p);
  float h = lum(aux(p).rgb);
  c.rgb = 1.0 - (1.0 - c.rgb) * (1.0 - clamp(uCol1 * h * uA.x, 0.0, 1.0));
  return c;
}`,
  },
  {
    kind: 'bloom', label: 'Bloom', group: 'Film',
    params: [
      { key: 'threshold', label: 'Threshold', type: 'range', min: 0, max: 100, value: 70, unit: '%' },
      { key: 'radius', label: 'Radius', type: 'range', min: 1, max: 300, value: 30, unit: 'px' },
      { key: 'strength', label: 'Strength', type: 'range', min: 0, max: 300, value: 70, unit: '%' },
    ],
    aux: { radius: (v) => n(v.radius), threshold: (v) => n(v.threshold) / 100 },
    uniforms: (v) => ({ uA: [n(v.strength) / 100, 0, 0, 0] }),
    glsl: `
vec4 fx(vec2 p, vec2 d) {
  vec4 c = src(p);
  vec3 g = aux(p).rgb * uA.x;
  c.rgb = 1.0 - (1.0 - c.rgb) * (1.0 - clamp(g, 0.0, 1.0));
  return c;
}`,
  },
  {
    kind: 'diffusion', label: 'Diffusion (Mist)', group: 'Film',
    params: [
      { key: 'radius', label: 'Radius', type: 'range', min: 1, max: 200, value: 25, unit: 'px' },
      { key: 'strength', label: 'Strength', type: 'range', min: 0, max: 100, value: 35, unit: '%' },
      { key: 'lift', label: 'Haze', type: 'range', min: 0, max: 100, value: 20, unit: '%' },
    ],
    aux: { radius: (v) => n(v.radius) },
    uniforms: (v) => ({ uA: [n(v.strength) / 100, n(v.lift) / 100, 0, 0] }),
    glsl: `
vec4 fx(vec2 p, vec2 d) {
  vec4 c = src(p);
  vec3 b = aux(p).rgb;
  vec3 scr = 1.0 - (1.0 - c.rgb) * (1.0 - b);
  c.rgb = mix(c.rgb, scr, uA.x);
  c.rgb = mix(c.rgb, c.rgb * (1.0 - uA.y * 0.25) + uA.y * 0.12, uA.x);
  return c;
}`,
  },
  {
    kind: 'lightleak', label: 'Light Leak', group: 'Film', seeded: true, moves: true,
    params: [
      { key: 'intensity', label: 'Intensity', type: 'range', min: 0, max: 100, value: 55, unit: '%' },
      { key: 'size', label: 'Size', type: 'range', min: 10, max: 100, value: 45, unit: '%' },
      { key: 'angle', label: 'Direction', type: 'range', min: 0, max: 360, value: 30, unit: '°' },
      { key: 'c1', label: 'Colour 1', type: 'color', value: '#ff6a24' },
      { key: 'c2', label: 'Colour 2', type: 'color', value: '#ffd36b' },
    ],
    uniforms: (v) => ({ uA: [n(v.intensity) / 100, n(v.size) / 100, (n(v.angle) * Math.PI) / 180, 0], uCol1: hex3(v.c1), uCol2: hex3(v.c2) }),
    glsl: `
vec4 fx(vec2 p, vec2 d) {
  vec4 c = src(p);
  vec2 ds = docSize(), uv = d / ds;
  float asp = ds.x / ds.y;
  vec2 dir = vec2(cos(uA.z), sin(uA.z));
  // In motion the glow wanders and breathes (uTime is 0 for a still image).
  vec2 wander = vec2(sin(uTime * 0.6), cos(uTime * 0.45)) * 0.08;
  float breathe = 1.0 - 0.15 * (1.0 - cos(uTime * 1.3)) * 0.5;
  vec2 c1 = 0.5 + dir * 0.55 + (vec2(hash1(1.0), hash1(2.0)) - 0.5) * 0.3 + wander;
  vec2 c2 = 0.5 + dir * 0.8 + (vec2(hash1(3.0), hash1(4.0)) - 0.5) * 0.4 - wander * 0.6;
  vec2 q1 = (uv - c1) * vec2(asp, 1.0), q2 = (uv - c2) * vec2(asp, 1.0);
  float s = uA.y;
  float l1 = exp(-dot(q1, q1) / (s * s * 0.6)), l2 = exp(-dot(q2, q2) / (s * s * 0.22));
  vec3 leak = clamp((uCol1 * l1 + uCol2 * l2 * 0.85) * uA.x * 1.5 * breathe, 0.0, 1.0);
  c.rgb = 1.0 - (1.0 - c.rgb) * (1.0 - leak);
  return c;
}`,
  },
  {
    kind: 'fade', label: 'Fade & Split Tone', group: 'Film',
    params: [
      { key: 'lift', label: 'Lift blacks', type: 'range', min: 0, max: 40, value: 10, unit: '%' },
      { key: 'cut', label: 'Soften whites', type: 'range', min: 0, max: 40, value: 5, unit: '%' },
      { key: 'desat', label: 'Desaturate', type: 'range', min: 0, max: 100, value: 15, unit: '%' },
      { key: 'split', label: 'Split tone', type: 'range', min: 0, max: 100, value: 30, unit: '%' },
      { key: 'shadow', label: 'Shadows', type: 'color', value: '#1d4a5c' },
      { key: 'high', label: 'Highlights', type: 'color', value: '#ffd8a0' },
    ],
    uniforms: (v) => ({ uA: [n(v.lift) / 100, n(v.cut) / 100, n(v.desat) / 100, n(v.split) / 100], uCol1: hex3(v.shadow), uCol2: hex3(v.high) }),
    glsl: `
vec3 overlay(vec3 a, vec3 b) { return mix(2.0 * a * b, 1.0 - 2.0 * (1.0 - a) * (1.0 - b), step(0.5, a)); }
vec4 fx(vec2 p, vec2 d) {
  vec4 c = src(p);
  float l = lum(c.rgb);
  c.rgb = mix(c.rgb, vec3(l), uA.z);
  vec3 tint = mix(uCol1, uCol2, smoothstep(0.15, 0.85, l));
  c.rgb = mix(c.rgb, overlay(c.rgb, tint), uA.w);
  c.rgb = uA.x + c.rgb * (1.0 - uA.x - uA.y);
  return c;
}`,
  },
  {
    kind: 'dust', label: 'Dust & Scratches', group: 'Film', seeded: true,
    params: [
      { key: 'amount', label: 'Dust', type: 'range', min: 0, max: 100, value: 30, unit: '%' },
      { key: 'size', label: 'Speck size', type: 'range', min: 0.5, max: 5, step: 0.1, value: 1.2 },
      { key: 'scratches', label: 'Scratches', type: 'range', min: 0, max: 100, value: 25, unit: '%' },
      { key: 'tone', label: 'Colour', type: 'select', value: 'mixed', options: [['dark', 'Dark'], ['light', 'Light'], ['mixed', 'Mixed']] },
    ],
    uniforms: (v) => ({ uA: [n(v.amount) / 100, n(v.size), n(v.scratches) / 100, [0, 1, 0.5][sel(v.tone, ['dark', 'light', 'mixed'])]] }),
    glsl: `
vec4 fx(vec2 p, vec2 d) {
  vec4 c = src(p);
  float cell = 14.0 * uA.y;
  vec2 g = d / cell, id = floor(g), f = fract(g) - 0.5;
  float spec = 0.0;
  if (hash(id) < uA.x * 0.12) {
    vec2 off = (vec2(hash(id + 3.1), hash(id + 7.7)) - 0.5) * 0.5;
    float r = 0.06 + 0.2 * hash(id + 1.3);
    spec = 1.0 - smoothstep(r * 0.6, r, length((f - off) * vec2(1.0, 0.6 + hash(id + 2.2))));
  }
  float lines = 0.0;
  vec2 ds = docSize();
  for (int i = 0; i < 8; i++) {
    float fi = float(i);
    if (hash1(fi) > uA.z) continue;
    float x = hash1(fi + 10.0) * ds.x + (vnoise(vec2(fi * 7.0, d.y / 220.0)) - 0.5) * 40.0;
    float w = (0.5 + hash1(fi + 20.0) * 1.2) * uA.y;
    float seg = step(0.4, vnoise(vec2(fi * 3.0 + 5.0, d.y / 500.0)));
    lines = max(lines, (1.0 - smoothstep(w * 0.4, w, abs(d.x - x))) * seg);
  }
  float m = max(spec, lines * 0.75);
  vec3 col = uA.w > 0.75 ? vec3(0.96) : uA.w < 0.25 ? vec3(0.03) : (hash(id + 9.0) > 0.5 ? vec3(0.96) : vec3(0.03));
  c.rgb = mix(c.rgb, col, m * 0.85);
  return c;
}`,
  },

  // ---------- Lens ----------
  {
    kind: 'distortion', label: 'Lens Distortion', group: 'Lens',
    params: [
      { key: 'amount', label: 'Barrel ↔ Pincushion', type: 'range', min: -100, max: 100, value: 25 },
      { key: 'zoom', label: 'Zoom', type: 'range', min: 50, max: 150, value: 100, unit: '%' },
      { key: 'edges', label: 'Edges', type: 'select', value: 'transparent', options: [['transparent', 'Transparent'], ['black', 'Black'], ['stretch', 'Stretch']] },
    ],
    uniforms: (v) => ({ uA: [n(v.amount) / 200, n(v.zoom) / 100, sel(v.edges, ['transparent', 'black', 'stretch']), 0] }),
    glsl: `
vec4 fx(vec2 p, vec2 d) {
  vec2 ds = docSize();
  vec2 nn = d / ds * 2.0 - 1.0;
  float asp = ds.x / ds.y;
  vec2 q = nn * vec2(asp, 1.0);
  float r2 = dot(q, q) / (asp * asp + 1.0);
  vec2 nd = nn * (1.0 + uA.x * r2) / uA.y;
  vec2 dd = (nd + 1.0) * 0.5 * ds;
  bool outside = dd.x < 0.0 || dd.y < 0.0 || dd.x > ds.x || dd.y > ds.y;
  if (outside && uA.z < 0.5) return vec4(0.0);
  if (outside && uA.z < 1.5) return vec4(0.0, 0.0, 0.0, 1.0);
  return srcDoc(clamp(dd, vec2(0.5), ds - 0.5));
}`,
  },
  {
    kind: 'chromatic', label: 'Chromatic Aberration', group: 'Lens', moves: true,
    params: [
      { key: 'amount', label: 'Amount', type: 'range', min: 0, max: 60, step: 0.5, value: 6, unit: 'px' },
      { key: 'mode', label: 'Type', type: 'select', value: 'radial', options: [['radial', 'Radial (lens)'], ['linear', 'Linear (shift)']] },
      { key: 'angle', label: 'Angle', type: 'range', min: 0, max: 360, value: 0, unit: '°' },
    ],
    uniforms: (v) => ({ uA: [n(v.amount), sel(v.mode, ['radial', 'linear']), (n(v.angle) * Math.PI) / 180, 0] }),
    glsl: `
vec4 fx(vec2 p, vec2 d) {
  vec2 ds = docSize();
  float amt = uA.x * (1.0 + 0.35 * sin(uTime * 4.0));
  vec2 off = uA.y < 0.5 ? (d - ds * 0.5) / (length(ds) * 0.5) * amt : vec2(cos(uA.z), sin(uA.z)) * amt;
  vec4 c = srcDoc(d);
  vec4 r = srcDoc(d + off), b = srcDoc(d - off);
  return vec4(r.r, c.g, b.b, max(c.a, max(r.a, b.a)));
}`,
  },
  {
    kind: 'vignette', label: 'Vignette', group: 'Lens',
    params: [
      { key: 'amount', label: 'Amount', type: 'range', min: 0, max: 100, value: 45, unit: '%' },
      { key: 'size', label: 'Clear centre', type: 'range', min: 0, max: 100, value: 45, unit: '%' },
      { key: 'feather', label: 'Feather', type: 'range', min: 0, max: 100, value: 55, unit: '%' },
      { key: 'round', label: 'Roundness', type: 'range', min: 0, max: 100, value: 30, unit: '%' },
      { key: 'color', label: 'Colour', type: 'color', value: '#000000' },
    ],
    uniforms: (v) => ({ uA: [n(v.amount) / 100, n(v.round) / 100, n(v.size) / 100, n(v.feather) / 100], uCol1: hex3(v.color) }),
    glsl: `
vec4 fx(vec2 p, vec2 d) {
  vec4 c = src(p);
  vec2 ds = docSize();
  vec2 nn = (d / ds - 0.5) * 2.0;
  float asp = ds.x / ds.y;
  vec2 q = mix(nn, nn * (asp > 1.0 ? vec2(1.0, 1.0 / asp) : vec2(asp, 1.0)), uA.y);
  float dist = length(q) / 1.4142;
  float mid = 0.2 + uA.z * 0.75, fe = 0.04 + uA.w * 0.6;
  float v = smoothstep(mid - fe, mid + fe, dist);
  c.rgb = mix(c.rgb, uCol1, v * uA.x);
  return c;
}`,
  },

  // ---------- CRT & VHS ----------
  {
    kind: 'crt', label: 'CRT Screen', group: 'CRT & VHS', moves: true,
    params: [
      { key: 'scan', label: 'Scanlines', type: 'range', min: 0, max: 100, value: 55, unit: '%' },
      { key: 'spacing', label: 'Line spacing', type: 'range', min: 2, max: 16, step: 0.5, value: 4, unit: 'px' },
      { key: 'mask', label: 'Phosphor mask', type: 'select', value: 'aperture', options: [['none', 'None'], ['aperture', 'Aperture grille'], ['shadow', 'Shadow mask'], ['slot', 'Slot mask']] },
      { key: 'maskStrength', label: 'Mask strength', type: 'range', min: 0, max: 100, value: 35, unit: '%' },
      { key: 'maskSize', label: 'Mask size', type: 'range', min: 1, max: 8, step: 0.5, value: 2, unit: 'px' },
      { key: 'curve', label: 'Curvature', type: 'range', min: 0, max: 100, value: 20, unit: '%' },
      { key: 'corner', label: 'Rounded corners', type: 'range', min: 0, max: 100, value: 15, unit: '%' },
      { key: 'glow', label: 'Glow', type: 'range', min: 0, max: 100, value: 35, unit: '%' },
      { key: 'bright', label: 'Brightness', type: 'range', min: 60, max: 200, value: 125, unit: '%' },
    ],
    aux: { radius: (v) => n(v.spacing) * 1.6 },
    uniforms: (v) => ({
      uA: [n(v.scan) / 100, n(v.spacing), n(v.maskStrength) / 100, sel(v.mask, ['none', 'aperture', 'shadow', 'slot'])],
      uB: [n(v.curve) / 100, n(v.corner) / 100, n(v.glow) / 100, n(v.bright) / 100],
      uC: [n(v.maskSize), 0, 0, 0],
    }),
    glsl: `
vec4 fx(vec2 p, vec2 d) {
  vec2 ds = docSize();
  vec2 nn = d / ds * 2.0 - 1.0;
  vec2 nd = nn * (1.0 + uB.x * 0.22 * dot(nn, nn));
  vec2 e = abs(nd);
  float cr = max(uB.y * 0.25, 1e-4);
  vec2 asp = vec2(1.0, ds.x / ds.y);
  float sd = length(max((e - (1.0 - cr)) * asp, 0.0)) - cr;
  if (e.x > 1.0 || e.y > 1.0 || (uB.y > 0.0 && sd > 0.0)) return vec4(0.0, 0.0, 0.0, 1.0);
  vec2 dd = (nd + 1.0) * 0.5 * ds;
  vec4 s = srcDoc(dd);
  vec3 c = s.rgb;
  vec3 glow = texOut(uAux, fromDoc(dd)).rgb;
  float l = lum(c);
  // In motion the scanlines roll slowly down the screen.
  float sl = pow(0.5 + 0.5 * cos(6.28318 * (dd.y - uTime * uA.y * 1.5) / uA.y), mix(2.5, 0.8, l));
  float scan = mix(1.0, sl, uA.x);
  scan = mix(1.0 - uA.x * 0.45, scan, smoothstep(1.5, 3.0, uA.y * uScale));
  vec3 mask = vec3(1.0);
  if (uA.w > 0.5) {
    float ms = uC.x;
    float shift = uA.w > 1.5 && uA.w < 2.5 ? mod(floor(dd.y / ms), 2.0) * 1.5 * ms : 0.0;
    float col = mod(floor((dd.x + shift) / ms), 3.0);
    vec3 m = vec3(col < 0.5 ? 1.0 : 0.0, col > 0.5 && col < 1.5 ? 1.0 : 0.0, col > 1.5 ? 1.0 : 0.0);
    if (uA.w > 2.5) m *= step(0.34, fract((dd.y + floor(dd.x / (ms * 3.0)) * ms * 1.5) / (ms * 3.0)));
    mask = mix(vec3(1.0), 0.3 + m * 1.6, uA.z);
    mask = mix(vec3(1.0 - uA.z * 0.2), mask, smoothstep(1.0, 2.5, ms * uScale));
  }
  float flick = 1.0 - 0.025 * (1.0 - cos(uTime * 47.0)) * 0.5;
  c = c * scan * mask * uB.w * flick;
  c = 1.0 - (1.0 - c) * (1.0 - glow * uB.z);
  return vec4(c, 1.0);
}`,
  },
  {
    kind: 'vhs', label: 'VHS Tape', group: 'CRT & VHS', seeded: true, moves: true,
    params: [
      { key: 'shift', label: 'Colour shift', type: 'range', min: 0, max: 30, step: 0.5, value: 4, unit: 'px' },
      { key: 'bleed', label: 'Colour bleed', type: 'range', min: 0, max: 100, value: 60, unit: '%' },
      { key: 'jitter', label: 'Tracking jitter', type: 'range', min: 0, max: 100, value: 25, unit: '%' },
      { key: 'noise', label: 'Tape noise', type: 'range', min: 0, max: 100, value: 25, unit: '%' },
      { key: 'bands', label: 'Noise bands', type: 'range', min: 0, max: 100, value: 20, unit: '%' },
      { key: 'soft', label: 'Softness', type: 'range', min: 0, max: 100, value: 40, unit: '%' },
      { key: 'sat', label: 'Saturation', type: 'range', min: 0, max: 150, value: 85, unit: '%' },
    ],
    aux: { radius: () => 1.8 },
    uniforms: (v) => ({ uA: [n(v.shift), n(v.bleed) / 100, n(v.jitter) / 100, n(v.noise) / 100], uB: [n(v.sat) / 100, n(v.soft) / 100, n(v.bands) / 100, 0] }),
    glsl: `
const mat3 toYIQ = mat3(0.299, 0.596, 0.211, 0.587, -0.274, -0.523, 0.114, -0.322, 0.312);
const mat3 toRGB = mat3(1.0, 1.0, 1.0, 0.956, -0.272, -1.106, 0.621, -0.647, 1.703);
vec4 fx(vec2 p, vec2 d) {
  float line = floor(d.y / 2.0);
  float j = (vnoise(vec2(line * 0.05, 3.7 + uTime * 3.0)) - 0.5) * 2.0;
  float tear = step(0.985 - uA.z * 0.03, hash(vec2(floor(d.y / 24.0), 3.0)));
  float shift = (j * 3.0 + tear * (hash(vec2(line, 9.0)) - 0.5) * 60.0) * uA.z;
  vec2 dd = d + vec2(shift, 0.0);
  vec4 s = srcDoc(dd);
  vec3 base = mix(s.rgb, texOut(uAux, fromDoc(dd)).rgb, uB.y);
  float y = (toYIQ * base).x;
  vec2 iq = vec2(0.0);
  for (int i = 0; i < 8; i++) {
    float t = float(i) / 7.0;
    iq += (toYIQ * srcDoc(dd + vec2(uA.x + (t - 0.5) * uA.y * 24.0, 0.0)).rgb).yz;
  }
  vec3 col = toRGB * vec3(y, iq / 8.0 * uB.x);
  float streak = step(1.0 - uA.w * 0.03, hash(vec2(floor(d.x / 8.0), line)));
  col = mix(col, vec3(0.95), streak * 0.8);
  col += (hash(d + 0.37) - 0.5) * uA.w * 0.12;
  // In motion the noise bands roll up the picture like bad tracking.
  float band = smoothstep(1.0 - 0.08 * uB.z, 1.0, vnoise(vec2(3.0, d.y / 50.0 + uTime * 1.2)));
  col = mix(col, vec3(hash(floor(d / vec2(3.0, 1.0)))), band * 0.7 * step(0.001, uB.z));
  return vec4(col, s.a);
}`,
  },

  // ---------- Damage & Print ----------
  {
    kind: 'compression', label: 'Compression Artifacts', group: 'Damage & Print',
    params: [
      { key: 'block', label: 'Block size', type: 'range', min: 4, max: 48, value: 8, unit: 'px' },
      { key: 'blocky', label: 'Blockiness', type: 'range', min: 0, max: 100, value: 45, unit: '%' },
      { key: 'chroma', label: 'Colour smearing', type: 'range', min: 0, max: 100, value: 60, unit: '%' },
      { key: 'banding', label: 'Banding', type: 'range', min: 0, max: 100, value: 30, unit: '%' },
    ],
    aux: { radius: (v) => n(v.block) * 0.45 },
    uniforms: (v) => ({ uA: [n(v.blocky) / 100, n(v.block), n(v.chroma) / 100, n(v.banding) / 100] }),
    glsl: `
vec4 fx(vec2 p, vec2 d) {
  vec4 s = src(p);
  float bs = uA.y;
  vec2 bid = floor(d / bs);
  vec3 blk = texOut(uAux, fromDoc((bid + 0.5) * bs)).rgb;
  vec3 r = mix(s.rgb, blk, uA.x * 0.85);
  vec3 cb = texOut(uAux, fromDoc((floor(d / (bs * 2.0)) + 0.5) * bs * 2.0)).rgb;
  r = mix(r, lum(r) + (cb - lum(cb)), uA.z);
  float lv = mix(256.0, 5.0, uA.w);
  r = floor(r * lv + 0.5) / lv;
  vec2 f = fract(d / bs);
  r += (hash(bid) - 0.5) * 0.06 * uA.x * (step(f.x, 1.0 / bs) + step(f.y, 1.0 / bs));
  return vec4(r, s.a);
}`,
  },
  {
    kind: 'dither', label: 'Bit Crush & Dither', group: 'Damage & Print',
    params: [
      { key: 'levels', label: 'Levels', type: 'range', min: 2, max: 16, value: 4 },
      { key: 'pattern', label: 'Pattern', type: 'select', value: 'bayer4', options: [['bayer4', 'Ordered 4×4'], ['bayer8', 'Ordered 8×8'], ['noise', 'Noise']] },
      { key: 'pixel', label: 'Pixel size', type: 'range', min: 1, max: 24, value: 2, unit: 'px' },
      { key: 'mono', label: 'Two-colour', type: 'bool', value: false },
      { key: 'ink', label: 'Dark colour', type: 'color', value: '#1b1f2a' },
      { key: 'paper', label: 'Light colour', type: 'color', value: '#e8e2d0' },
    ],
    uniforms: (v) => ({ uA: [n(v.levels), sel(v.pattern, ['bayer4', 'bayer8', 'noise']), n(v.pixel), v.mono ? 1 : 0], uCol1: hex3(v.ink), uCol2: hex3(v.paper) }),
    glsl: `
float bayer2(vec2 a) { a = floor(a); return fract(a.x / 2.0 + a.y * a.y * 0.75); }
float bayer4(vec2 a) { return bayer2(0.5 * a) * 0.25 + bayer2(a); }
float bayer8(vec2 a) { return bayer4(0.5 * a) * 0.25 + bayer2(a); }
vec4 fx(vec2 p, vec2 d) {
  vec2 cell = floor(d / uA.z);
  vec4 s = srcDoc((cell + 0.5) * uA.z);
  float th = uA.y < 0.5 ? bayer4(cell) : uA.y < 1.5 ? bayer8(cell) : hash(cell);
  float lv = uA.x - 1.0;
  vec3 c;
  if (uA.w > 0.5) c = mix(uCol1, uCol2, clamp(floor(lum(s.rgb) * lv + th) / lv, 0.0, 1.0));
  else c = floor(s.rgb * lv + th) / lv;
  return vec4(c, s.a);
}`,
  },
  {
    kind: 'glitch', label: 'Glitch', group: 'Damage & Print', seeded: true,
    params: [
      { key: 'amount', label: 'Amount', type: 'range', min: 0, max: 100, value: 40, unit: '%' },
      { key: 'slices', label: 'Slices', type: 'range', min: 2, max: 80, value: 18 },
      { key: 'offset', label: 'Offset', type: 'range', min: 0, max: 400, value: 60, unit: 'px' },
      { key: 'split', label: 'RGB split', type: 'range', min: 0, max: 60, value: 8, unit: 'px' },
    ],
    uniforms: (v) => ({ uA: [n(v.amount) / 100, n(v.slices), n(v.offset), n(v.split)] }),
    glsl: `
vec4 fx(vec2 p, vec2 d) {
  vec2 ds = docSize();
  float sl = floor(d.y / ds.y * uA.y);
  float on = step(1.0 - uA.x * 0.6, hash(vec2(sl, 1.7)));
  float off = (hash(vec2(sl, 5.3)) - 0.5) * 2.0 * uA.z * on;
  vec2 blk = floor(d / vec2(ds.x / 8.0, ds.y / uA.y / 2.0));
  float on2 = step(0.97 - uA.x * 0.05, hash(blk + 11.0));
  off += (hash(blk) - 0.5) * uA.z * 0.5 * on2;
  vec2 dd = d + vec2(off, 0.0);
  float sp = uA.w * (on + on2 > 0.0 ? 1.0 : 0.25);
  vec4 c = srcDoc(dd);
  c.r = srcDoc(dd + vec2(sp, 0.0)).r;
  c.b = srcDoc(dd - vec2(sp, 0.0)).b;
  if (hash(vec2(sl, 9.1)) > 1.0 - uA.x * 0.08) c.rgb = 1.0 - c.rgb;
  return c;
}`,
  },
  {
    kind: 'halftone', label: 'Halftone Dots', group: 'Damage & Print', moves: true,
    params: [
      { key: 'size', label: 'Dot spacing', type: 'range', min: 3, max: 80, value: 8, unit: 'px' },
      { key: 'angle', label: 'Angle', type: 'range', min: 0, max: 90, value: 45, unit: '°' },
      { key: 'mode', label: 'Style', type: 'select', value: 'mono', options: [['mono', 'One ink'], ['color', 'Coloured dots'], ['cmyk', 'CMYK print']] },
      { key: 'contrast', label: 'Contrast', type: 'range', min: 50, max: 250, value: 100, unit: '%' },
      { key: 'ink', label: 'Ink', type: 'color', value: '#111111' },
      { key: 'paper', label: 'Paper', type: 'color', value: '#f4f0e6' },
      { key: 'move', label: 'When animated', type: 'select', value: 'drift', options: [['drift', 'Dots drift'], ['rotate', 'Screen turns'], ['pulse', 'Dots pulse'], ['wave', 'Ripple']] },
    ],
    uniforms: (v) => ({
      uA: [n(v.size), (n(v.angle) * Math.PI) / 180, sel(v.mode, ['mono', 'color', 'cmyk']), n(v.contrast) / 100],
      uC: [sel(v.move, ['drift', 'rotate', 'pulse', 'wave']), 0, 0, 0], uCol1: hex3(v.ink), uCol2: hex3(v.paper),
    }),
    glsl: `
vec2 rot(vec2 v, float a) { float c = cos(a), s = sin(a); return vec2(c * v.x - s * v.y, s * v.x + c * v.y); }
vec2 cellCenter(vec2 d, float a) { vec2 q = rot(d, -a) / uA.x; return rot((floor(q) + 0.5) * uA.x, a); }
float dotAt(vec2 d, float a, float cov) {
  vec2 q = rot(d, -a) / uA.x;
  float r = sqrt(clamp(cov, 0.0, 1.0) / 3.14159) * 1.12;
  float aa = 0.7 / max(uA.x * uScale, 1.0);
  return 1.0 - smoothstep(r - aa, r + aa, length(fract(q) - 0.5));
}
vec4 fx(vec2 p, vec2 d) {
  vec4 s = src(p);
  // Motion (uTime is 0 for a still image): the dot screen slides over the picture, turns, pulses or ripples.
  // q is where we are on the screen; the picture is read back at q - off.
  vec2 off = uC.x < 0.5 ? vec2(uTime * uA.x * 2.0, uTime * uA.x * 0.7) : vec2(0.0);
  if (uC.x > 2.5) off = vec2(0.0, sin(d.x / (uA.x * 6.0) + uTime * 3.0) * uA.x * 0.5);
  float turn = uC.x > 0.5 && uC.x < 1.5 ? uTime * 0.25 : 0.0;
  float pulse = uC.x > 1.5 && uC.x < 2.5 ? 1.0 - 0.35 * (1.0 - cos(uTime * 4.0)) * 0.5 : 1.0;
  vec2 q = d + off;
  if (uA.z > 1.5) {
    vec3 col = vec3(1.0);
    float angs[4] = float[4](0.2618, 1.309, 0.0, 0.7854);
    for (int i = 0; i < 4; i++) {
      float a = angs[i] + turn;
      vec3 cc = srcDoc(cellCenter(q, a) - off).rgb;
      float k = 1.0 - max(cc.r, max(cc.g, cc.b));
      vec3 cmy = (1.0 - cc - k) / max(1.0 - k, 1e-3);
      float cov = i == 0 ? cmy.r : i == 1 ? cmy.g : i == 2 ? cmy.b : k;
      float m = dotAt(q, a, pow(cov, 1.0 / uA.w) * pulse);
      vec3 ink = i == 0 ? vec3(0.0, 0.68, 0.94) : i == 1 ? vec3(0.93, 0.0, 0.55) : i == 2 ? vec3(1.0, 0.94, 0.0) : vec3(0.1);
      col *= mix(vec3(1.0), ink, m);
    }
    return vec4(col * uCol2, s.a);
  }
  float a = uA.y + turn;
  vec3 cc = srcDoc(cellCenter(q, a) - off).rgb;
  float cov = pow(1.0 - lum(cc), 1.0 / uA.w) * pulse;
  float m = dotAt(q, a, cov);
  vec3 ink = uA.z > 0.5 ? cc * 0.85 : uCol1;
  return vec4(mix(uCol2, ink, m), s.a);
}`,
  },
];

export const FX_GROUPS = ['Film', 'Lens', 'CRT & VHS', 'Damage & Print'] as const;

export const fxDef = (kind: string) => FX_DEFS.find((d) => d.kind === kind);

export function defaultFx(kind: string): FxParams {
  const def = fxDef(kind)!;
  return { kind, seed: Math.floor(Math.random() * 1000), v: Object.fromEntries(def.params.map((p) => [p.key, p.value])) };
}

/** Whether an effect can animate (re-roll its texture or move). */
export const canMove = (kind: string) => { const d = fxDef(kind); return !!d && (!!d.seeded || !!d.moves); };
export const DEFAULT_MOTION = { on: true, speed: 1, flicker: 12 };
