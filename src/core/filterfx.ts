import type { FxDef, FxValue } from './effects';

/**
 * The classic filters (blur, sharpen, noise, distort, stylize, render) as effects: each works as an editable effect
 * layer, or applied to a layer's pixels from the Filter menu. They read the picture clamped to the canvas (srcC), so
 * edges don't fade in from outside it. Sizes are in document pixels, like every effect.
 */

const n = (v: FxValue) => Number(v);
const RAD = Math.PI / 180;
const hex3 = (h: FxValue): [number, number, number] => {
  const x = parseInt(String(h).slice(1), 16) || 0;
  return [((x >> 16) & 255) / 255, ((x >> 8) & 255) / 255, (x & 255) / 255];
};
const centre = [
  { key: 'cx', label: 'Centre across', type: 'range', min: 0, max: 100, value: 50, unit: '%' },
  { key: 'cy', label: 'Centre down', type: 'range', min: 0, max: 100, value: 50, unit: '%' },
] as const;

export const FILTER_FX: FxDef[] = [
  // ---------- Blur ----------
  {
    kind: 'gblur', label: 'Gaussian Blur', group: 'Blur',
    params: [{ key: 'radius', label: 'Radius', type: 'range', min: 0.1, max: 250, step: 0.1, value: 4, unit: 'px' }],
    aux: { radius: (v) => n(v.radius), clamp: true },
    uniforms: () => ({}),
    glsl: `
vec4 fx(vec2 p, vec2 d) { return aux(p); }`,
  },
  {
    kind: 'motionblur', label: 'Motion Blur', group: 'Blur',
    params: [
      { key: 'angle', label: 'Angle', type: 'range', min: -180, max: 180, value: 0, unit: '°' },
      { key: 'distance', label: 'Distance', type: 'range', min: 1, max: 1000, value: 30, unit: 'px' },
    ],
    margin: (v) => n(v.distance) / 2,
    uniforms: (v) => ({ uA: [Math.cos(n(v.angle) * RAD), Math.sin(n(v.angle) * RAD), n(v.distance), 0] }),
    glsl: `
vec4 fx(vec2 p, vec2 d) {
  vec2 len = vec2(uA.x, -uA.y) * uA.z * uScale;
  float k = clamp(ceil(length(len)), 1.0, 160.0);
  vec4 acc = vec4(0.0);
  for (int i = 0; i < 160; i++) {
    if (float(i) >= k) break;
    acc += pm(srcC(p + len * ((float(i) + 0.5) / k - 0.5)));
  }
  return unpm(acc / k);
}`,
  },
  {
    kind: 'spinblur', label: 'Radial Blur (Spin)', group: 'Blur',
    params: [{ key: 'amount', label: 'Turn', type: 'range', min: 0, max: 90, step: 0.5, value: 10, unit: '°' }, ...centre],
    margin: () => Infinity,
    uniforms: (v) => ({ uA: [n(v.amount) * RAD, n(v.cx) / 100, n(v.cy) / 100, 0] }),
    glsl: `
vec4 fx(vec2 p, vec2 d) {
  vec2 c = fromDoc(docSize() * uA.yz), v = p - c;
  float k = clamp(ceil(length(v) * uA.x), 1.0, 160.0);
  vec4 acc = vec4(0.0);
  for (int i = 0; i < 160; i++) {
    if (float(i) >= k) break;
    float a = uA.x * ((float(i) + 0.5) / k - 0.5), s = sin(a), co = cos(a);
    acc += pm(srcC(c + vec2(v.x * co - v.y * s, v.x * s + v.y * co)));
  }
  return unpm(acc / k);
}`,
  },
  {
    kind: 'zoomblur', label: 'Zoom Blur', group: 'Blur',
    params: [{ key: 'amount', label: 'Amount', type: 'range', min: 0, max: 100, value: 20, unit: '%' }, ...centre],
    margin: () => Infinity,
    uniforms: (v) => ({ uA: [n(v.amount) / 100, n(v.cx) / 100, n(v.cy) / 100, 0] }),
    glsl: `
vec4 fx(vec2 p, vec2 d) {
  vec2 c = fromDoc(docSize() * uA.yz), v = p - c;
  float k = clamp(ceil(length(v) * uA.x), 1.0, 160.0);
  vec4 acc = vec4(0.0);
  for (int i = 0; i < 160; i++) {
    if (float(i) >= k) break;
    acc += pm(srcC(c + v * (1.0 - uA.x * (float(i) + 0.5) / k)));
  }
  return unpm(acc / k);
}`,
  },
  {
    kind: 'surfaceblur', label: 'Surface Blur', group: 'Blur',
    params: [
      { key: 'radius', label: 'Radius', type: 'range', min: 1, max: 100, value: 5, unit: 'px' },
      { key: 'threshold', label: 'Threshold', type: 'range', min: 2, max: 255, value: 15, unit: 'lv' },
    ],
    margin: (v) => n(v.radius),
    uniforms: (v) => ({ uA: [n(v.radius), n(v.threshold) / 255, 0, 0] }),
    glsl: `
vec4 fx(vec2 p, vec2 d) {
  vec4 c = srcC(p);
  float R = uA.x * uScale;
  if (R < 0.75) return c;
  // Averages the pixels around that are close in colour (within the threshold), so edges stay sharp.
  vec4 acc = pm(c);
  float ws = 1.0;
  for (int i = 0; i < 64; i++) {
    float f = (float(i) + 0.5) / 64.0, a = float(i) * 2.39996;
    vec4 s = srcC(p + vec2(cos(a), sin(a)) * R * sqrt(f));
    vec3 df = abs(s.rgb - c.rgb);
    float w = max(0.0, 1.0 - max(df.r, max(df.g, df.b)) / (2.5 * uA.y));
    acc += pm(s) * w;
    ws += w;
  }
  return unpm(acc / ws);
}`,
  },
  // ---------- Sharpen ----------
  {
    kind: 'sharpen', label: 'Sharpen (Unsharp Mask)', group: 'Sharpen',
    params: [
      { key: 'amount', label: 'Amount', type: 'range', min: 1, max: 500, value: 100, unit: '%' },
      { key: 'radius', label: 'Radius', type: 'range', min: 0.1, max: 50, step: 0.1, value: 1.5, unit: 'px' },
      { key: 'threshold', label: 'Threshold', type: 'range', min: 0, max: 255, value: 0, unit: 'lv' },
    ],
    aux: { radius: (v) => n(v.radius), clamp: true },
    uniforms: (v) => ({ uA: [n(v.amount) / 100, n(v.threshold) / 255, 0, 0] }),
    glsl: `
vec4 fx(vec2 p, vec2 d) {
  vec4 c = src(p);
  vec3 df = c.rgb - aux(p).rgb;
  return vec4(c.rgb + df * uA.x * step(uA.y * 0.5, abs(df)), c.a);
}`,
  },
  {
    kind: 'highpass', label: 'High Pass', group: 'Sharpen',
    params: [{ key: 'radius', label: 'Radius', type: 'range', min: 0.1, max: 250, step: 0.1, value: 10, unit: 'px' }],
    aux: { radius: (v) => n(v.radius), clamp: true },
    uniforms: () => ({}),
    glsl: `
vec4 fx(vec2 p, vec2 d) {
  vec4 c = src(p);
  return vec4(vec3(0.5) + c.rgb - aux(p).rgb, c.a);
}`,
  },
  // ---------- Noise ----------
  {
    kind: 'addnoise', label: 'Add Noise', group: 'Noise', seeded: true,
    params: [
      { key: 'amount', label: 'Amount', type: 'range', min: 0, max: 100, step: 0.5, value: 10, unit: '%' },
      { key: 'dist', label: 'Spread', type: 'select', value: 'gaussian', options: [['uniform', 'Even'], ['gaussian', 'Gaussian']] },
      { key: 'mono', label: 'Monochromatic', type: 'bool', value: true },
    ],
    uniforms: (v) => ({ uA: [n(v.amount) / 100, v.dist === 'gaussian' ? 1 : 0, v.mono ? 1 : 0, 0] }),
    glsl: `
vec4 fx(vec2 p, vec2 d) {
  vec4 c = src(p);
  vec2 q = floor(d);
  vec3 r = vec3(hash(q), hash(q + 71.3), hash(q + 143.9));
  vec3 g = uA.y > 0.5
    ? (r + vec3(hash(q + 11.1), hash(q + 53.7), hash(q + 97.3)) + vec3(hash(q + 201.0), hash(q + 251.0), hash(q + 307.0)) - 1.5) * 1.15
    : (r - 0.5) * 2.0;
  if (uA.z > 0.5) g = vec3(g.r);
  return vec4(c.rgb + g * uA.x, c.a);
}`,
  },
  {
    kind: 'denoise', label: 'Reduce Noise', group: 'Noise',
    params: [
      { key: 'strength', label: 'Strength', type: 'range', min: 0, max: 100, value: 50, unit: '%' },
      { key: 'detail', label: 'Keep detail', type: 'range', min: 0, max: 100, value: 40, unit: '%' },
    ],
    margin: (v) => 1 + n(v.strength) / 20,
    uniforms: (v) => {
      const s = n(v.strength) / 100;
      return { uA: [1 + 5 * s, 0.015 + 0.18 * s * (1 - 0.85 * n(v.detail) / 100), 0, 0] };
    },
    glsl: `
vec4 fx(vec2 p, vec2 d) {
  vec4 c = srcC(p);
  float R = uA.x * uScale;
  if (R < 0.75) return c;
  // A bilateral blur: near pixels count most, and only those of a similar colour.
  vec4 acc = pm(c);
  float ws = 1.0, k = 1.0 / (2.0 * uA.y * uA.y);
  for (int i = 0; i < 48; i++) {
    float f = (float(i) + 0.5) / 48.0, a = float(i) * 2.39996;
    vec4 s = srcC(p + vec2(cos(a), sin(a)) * R * sqrt(f));
    vec3 df = s.rgb - c.rgb;
    float w = exp(-dot(df, df) / 3.0 * k - 2.0 * f);
    acc += pm(s) * w;
    ws += w;
  }
  return unpm(acc / ws);
}`,
  },
  {
    kind: 'median', label: 'Median', group: 'Noise',
    params: [{ key: 'radius', label: 'Radius', type: 'range', min: 1, max: 20, step: 0.5, value: 2, unit: 'px' }],
    margin: (v) => n(v.radius),
    uniforms: (v) => ({ uA: [n(v.radius), 0, 0, 0] }),
    glsl: `
// The middle value (per channel) of 3 × 3 samples across the radius, by a fixed network of swaps (Paeth's, as
// McGuire's shader does it): specks and scratches smaller than the radius go, edges stay.
#define s2(a, b) t = min(a, b); b = max(a, b); a = t;
#define mn3(a, b, c) s2(a, b); s2(a, c);
#define mx3(a, b, c) s2(b, c); s2(a, c);
#define mnmx3(a, b, c) mx3(a, b, c); s2(a, b);
#define mnmx4(a, b, c, d) s2(a, b); s2(c, d); s2(a, c); s2(b, d);
#define mnmx5(a, b, c, d, e) s2(a, b); s2(c, d); mn3(a, c, e); mx3(b, d, e);
#define mnmx6(a, b, c, d, e, f) s2(a, d); s2(b, e); s2(c, f); mn3(a, b, c); mx3(d, e, f);
vec4 fx(vec2 p, vec2 d) {
  float r = uA.x * uScale;
  if (r < 0.5) return src(p);
  vec4 v0 = srcC(p + vec2(-r, -r)), v1 = srcC(p + vec2(0.0, -r)), v2 = srcC(p + vec2(r, -r));
  vec4 v3 = srcC(p + vec2(-r, 0.0)), v4 = srcC(p), v5 = srcC(p + vec2(r, 0.0));
  vec4 v6 = srcC(p + vec2(-r, r)), v7 = srcC(p + vec2(0.0, r)), v8 = srcC(p + vec2(r, r));
  vec4 t;
  mnmx6(v0, v1, v2, v3, v4, v5);
  mnmx5(v1, v2, v3, v4, v6);
  mnmx4(v2, v3, v4, v7);
  mnmx3(v3, v4, v8);
  return v4;
}`,
  },
  // ---------- Distort ----------
  {
    kind: 'offset', label: 'Offset', group: 'Distort',
    params: [
      // In parts of the canvas, so half and half (the default) shows the seams of a tile in the middle.
      { key: 'x', label: 'Across', type: 'range', min: -100, max: 100, step: 0.1, value: 50, unit: '%' },
      { key: 'y', label: 'Down', type: 'range', min: -100, max: 100, step: 0.1, value: 50, unit: '%' },
      { key: 'edges', label: 'What comes in', type: 'select', value: 'wrap', options: [['wrap', 'Wrap around'], ['edge', 'Repeat edge'], ['none', 'Nothing']] },
    ],
    margin: () => Infinity,
    uniforms: (v) => ({ uA: [n(v.x) / 100, n(v.y) / 100, v.edges === 'wrap' ? 0 : v.edges === 'edge' ? 1 : 2, 0] }),
    glsl: `
vec4 fx(vec2 p, vec2 d) {
  vec2 S = docSize(), q = d - uA.xy * S;
  if (uA.z < 0.5) q = mod(q, S);
  else if (uA.z > 1.5 && (q.x < 0.0 || q.y < 0.0 || q.x > S.x || q.y > S.y)) return vec4(0.0);
  return srcDocC(q);
}`,
  },
  {
    kind: 'ripple', label: 'Ripple / Wave', group: 'Distort', moves: true,
    params: [
      { key: 'amount', label: 'Height', type: 'range', min: 0, max: 200, step: 0.5, value: 10, unit: 'px' },
      { key: 'length', label: 'Wavelength', type: 'range', min: 2, max: 1000, value: 60, unit: 'px' },
      { key: 'dir', label: 'Direction', type: 'select', value: 'across', options: [['across', 'Across'], ['down', 'Down'], ['both', 'Both']] },
    ],
    margin: (v) => n(v.amount),
    uniforms: (v) => ({ uA: [n(v.amount), n(v.length), v.dir === 'across' ? 0 : v.dir === 'down' ? 1 : 2, 0] }),
    glsl: `
vec4 fx(vec2 p, vec2 d) {
  float k = 6.28318 / max(uA.y, 1.0), ph = uTime * 6.28318;
  vec2 off = vec2(0.0);
  if (uA.z < 0.5 || uA.z > 1.5) off.x = sin(d.y * k + ph) * uA.x;
  if (uA.z > 0.5) off.y = sin(d.x * k + ph) * uA.x;
  return srcDocC(d + off);
}`,
  },
  {
    kind: 'twirl', label: 'Twirl', group: 'Distort',
    params: [
      { key: 'angle', label: 'Angle', type: 'range', min: -720, max: 720, value: 90, unit: '°' },
      { key: 'radius', label: 'Radius', type: 'range', min: 1, max: 200, value: 60, unit: '%' },
      ...centre,
    ],
    margin: () => Infinity,
    uniforms: (v) => ({ uA: [n(v.angle) * RAD, n(v.radius) / 100, n(v.cx) / 100, n(v.cy) / 100] }),
    glsl: `
vec4 fx(vec2 p, vec2 d) {
  vec2 S = docSize(), c = S * uA.zw, v = d - c;
  float R = uA.y * 0.5 * min(S.x, S.y), r = length(v);
  if (r < R) {
    float t = 1.0 - r / R, a = uA.x * t * t, s = sin(a), co = cos(a);
    v = vec2(v.x * co - v.y * s, v.x * s + v.y * co);
  }
  return srcDocC(c + v);
}`,
  },
  {
    kind: 'pinch', label: 'Pinch / Bulge', group: 'Distort',
    params: [
      { key: 'amount', label: 'Pinch (− bulges)', type: 'range', min: -100, max: 100, value: 50, unit: '%' },
      { key: 'radius', label: 'Radius', type: 'range', min: 1, max: 200, value: 60, unit: '%' },
      ...centre,
    ],
    margin: () => Infinity,
    uniforms: (v) => ({ uA: [n(v.amount) / 100, n(v.radius) / 100, n(v.cx) / 100, n(v.cy) / 100] }),
    glsl: `
vec4 fx(vec2 p, vec2 d) {
  vec2 S = docSize(), c = S * uA.zw, v = d - c;
  float R = uA.y * 0.5 * min(S.x, S.y), r = length(v);
  if (r < R && r > 0.0) v *= pow(r / R, exp2(-uA.x * 1.3)) * R / r;
  return srcDocC(c + v);
}`,
  },
  {
    kind: 'displace', label: 'Displace', group: 'Distort', seeded: true,
    params: [
      { key: 'amount', label: 'Amount', type: 'range', min: 0, max: 300, step: 0.5, value: 20, unit: 'px' },
      { key: 'size', label: 'Size', type: 'range', min: 2, max: 1000, value: 80, unit: 'px' },
      { key: 'detail', label: 'Detail', type: 'range', min: 1, max: 6, value: 3 },
    ],
    margin: (v) => n(v.amount) * 2,
    uniforms: (v) => ({ uA: [n(v.amount), n(v.size), n(v.detail), 0] }),
    glsl: `
vec4 fx(vec2 p, vec2 d) {
  vec2 q = d / max(uA.y, 1.0);
  vec2 off = (vec2(fbm(q, uA.z), fbm(q + vec2(31.7, 17.3), uA.z)) - 0.5) * 3.0 * uA.x;
  return srcDocC(d + off);
}`,
  },
  // ---------- Stylize ----------
  {
    kind: 'emboss', label: 'Emboss', group: 'Stylize',
    params: [
      { key: 'angle', label: 'Light from', type: 'range', min: -180, max: 180, value: 135, unit: '°' },
      { key: 'height', label: 'Height', type: 'range', min: 1, max: 20, step: 0.5, value: 3, unit: 'px' },
      { key: 'amount', label: 'Amount', type: 'range', min: 1, max: 500, value: 100, unit: '%' },
      { key: 'colour', label: 'Keep colours', type: 'bool', value: false },
    ],
    margin: (v) => n(v.height),
    uniforms: (v) => ({ uA: [Math.cos(n(v.angle) * RAD), Math.sin(n(v.angle) * RAD), n(v.height), n(v.amount) / 100], uB: [v.colour ? 1 : 0, 0, 0, 0] }),
    glsl: `
vec4 fx(vec2 p, vec2 d) {
  vec4 c = src(p);
  vec2 o = vec2(uA.x, -uA.y) * max(uA.z * uScale, 0.5);
  float e = (lum(srcC(p - o).rgb) - lum(srcC(p + o).rgb)) * uA.w;
  return vec4(uB.x > 0.5 ? c.rgb + e : vec3(0.5 + e), c.a);
}`,
  },
  {
    kind: 'edges', label: 'Find Edges', group: 'Stylize',
    params: [
      { key: 'strength', label: 'Strength', type: 'range', min: 0, max: 400, value: 100, unit: '%' },
      { key: 'width', label: 'Width', type: 'range', min: 0.5, max: 10, step: 0.5, value: 1, unit: 'px' },
      { key: 'style', label: 'Look', type: 'select', value: 'light', options: [['light', 'Lines on white'], ['dark', 'Glowing on black']] },
    ],
    margin: (v) => n(v.width) * 2,
    uniforms: (v) => ({ uA: [n(v.strength) / 100, n(v.width), v.style === 'dark' ? 1 : 0, 0] }),
    glsl: `
vec4 fx(vec2 p, vec2 d) {
  vec4 c = src(p);
  float w = max(uA.y * uScale, 0.5);
  vec3 tl = srcC(p + vec2(-w, -w)).rgb, t = srcC(p + vec2(0.0, -w)).rgb, tr = srcC(p + vec2(w, -w)).rgb;
  vec3 l = srcC(p + vec2(-w, 0.0)).rgb, r = srcC(p + vec2(w, 0.0)).rgb;
  vec3 bl = srcC(p + vec2(-w, w)).rgb, b = srcC(p + vec2(0.0, w)).rgb, br = srcC(p + vec2(w, w)).rgb;
  vec3 gx = (tr + 2.0 * r + br) - (tl + 2.0 * l + bl), gy = (bl + 2.0 * b + br) - (tl + 2.0 * t + tr);
  vec3 g = clamp(sqrt(gx * gx + gy * gy) * 0.25 * uA.x, 0.0, 1.0);
  return vec4(uA.z > 0.5 ? g : 1.0 - g, c.a);
}`,
  },
  {
    kind: 'pixelate', label: 'Pixelate', group: 'Stylize',
    params: [{ key: 'cell', label: 'Cell size', type: 'range', min: 2, max: 300, value: 12, unit: 'px' }],
    margin: (v) => n(v.cell),
    uniforms: (v) => ({ uA: [n(v.cell), 0, 0, 0] }),
    glsl: `
vec4 fx(vec2 p, vec2 d) {
  float s = uA.x;
  vec2 o = floor(d / s) * s;
  vec4 acc = vec4(0.0);
  for (int y = 0; y < 4; y++) for (int x = 0; x < 4; x++) acc += pm(srcDocC(o + (vec2(float(x), float(y)) + 0.5) / 4.0 * s));
  return unpm(acc / 16.0);
}`,
  },
  // ---------- Render ----------
  {
    kind: 'clouds', label: 'Clouds', group: 'Render', seeded: true,
    params: [
      { key: 'size', label: 'Size', type: 'range', min: 2, max: 2000, value: 200, unit: 'px' },
      { key: 'detail', label: 'Detail', type: 'range', min: 1, max: 8, value: 5 },
      { key: 'contrast', label: 'Contrast', type: 'range', min: 0, max: 400, value: 100, unit: '%' },
      { key: 'dark', label: 'Dark', type: 'color', value: '#000000' },
      { key: 'light', label: 'Light', type: 'color', value: '#ffffff' },
    ],
    uniforms: (v) => ({ uA: [n(v.size), n(v.detail), n(v.contrast) / 100, 0], uCol1: hex3(v.dark), uCol2: hex3(v.light) }),
    glsl: `
vec4 fx(vec2 p, vec2 d) {
  float v = fbm(d / max(uA.x, 1.0), uA.y);
  v = clamp((v - 0.5) * uA.z * 2.0 + 0.5, 0.0, 1.0);
  return vec4(mix(uCol1, uCol2, v), 1.0);
}`,
  },
];
