import type { Pt, Rect } from './math';

/**
 * 3D layers: an image layer can carry a `model`, turning its picture into a lit 3D object that renders in place of
 * the flat pixels. Rendered on the GPU (WebGL2) and kept as settings, so it stays editable.
 * - Inflate puffs the picture's silhouette out on both sides, like a balloon or a pillow, the picture on the front.
 * - Extrude gives it straight sides and depth, like a cookie cutter, with an optional rounded bevel on the front.
 * - Revolve spins the silhouette around an upright axis, like a lathe: a vase, a bottle, a ring.
 */
export interface Model3D {
  kind: 'inflate' | 'extrude' | 'revolve';
  /** Inflate: how far it puffs out (100 = the thickest part is round). Extrude: thickness, % of the picture's shorter side. */
  depth: number;
  /** Inflate: 100 = round all the way across; lower = rounded edges with a flatter face. */
  round: number;
  /** Extrude: how wide the rounded bevel on the front edge is (0 = a sharp edge). */
  bevel?: number;
  /** Revolve: spin around the picture's middle (draw the whole object) or its left edge (draw half of it). */
  axis?: 'centre' | 'left';
  /** Turn, in degrees, about the horizontal (x), vertical (y) and facing (z) axes. */
  rotX: number; rotY: number; rotZ: number;
  /** Light direction (azimuth 0-360 measured from the right, counterclockwise; elevation 0-90 above the surface), strength and ambient light (0-100). */
  light: { az: number; el: number; strength: number; ambient: number };
  material: 'matte' | 'plastic' | 'metal';
  /** A solid colour, or null to use the layer's own picture. */
  color: string | null;
  /** An image laid over the surface (wood, stone, a label), on top of the picture or colour. */
  texture?: ModelTexture | null;
}

/**
 * A 3D layer's texture. The image is a copy kept with the document (`key`). It's fitted to cover the front (Inflate,
 * Extrude) or to wrap once round the widest part like a label (Revolve), keeping its proportions, then scaled, moved
 * and turned.
 */
export interface ModelTexture {
  key: string;
  /** Where it came from (a layer's or file's name), to show in Properties. */
  name: string;
  /** Size, % of the fitted size. */
  scale: number;
  /** Offset, % of the fitted area. */
  x: number; y: number;
  /** Turn, degrees. */
  rotate: number;
  /** Repeat it past its edges (Extrude's sides always repeat it). */
  tile: boolean;
  /** Replace the colour underneath, or multiply with it (keeps the picture's shading and colour). */
  blend: 'replace' | 'multiply';
  /** How strongly it shows, 0-100. */
  amount: number;
  /** Raised by its light areas, 0-100 (0 = flat). */
  bump: number;
  /** Extrude: on every surface, only the front and back, or only the sides. */
  where: 'all' | 'faces' | 'sides';
}

export const defaultTexture = (key: string, name: string): ModelTexture => ({
  key, name, scale: 100, x: 0, y: 0, rotate: 0, tile: false, blend: 'replace', amount: 100, bump: 0, where: 'all',
});

export const defaultModel = (kind: Model3D['kind'] = 'inflate'): Model3D => ({
  kind, depth: kind === 'extrude' ? 30 : 60, round: 70, bevel: 30, axis: 'centre',
  rotX: kind === 'revolve' ? -20 : -18, rotY: kind === 'revolve' ? 0 : 24, rotZ: 0,
  light: { az: 135, el: 45, strength: 100, ambient: 35 }, material: 'plastic', color: null,
});

const D2R = Math.PI / 180;

/** Rotation (x, then y, then z) as a 3x3 matrix, row-major. */
function rotation(m: Model3D): number[] {
  const [ax, ay, az] = [m.rotX * D2R, m.rotY * D2R, m.rotZ * D2R];
  const cx = Math.cos(ax), sx = Math.sin(ax), cy = Math.cos(ay), sy = Math.sin(ay), cz = Math.cos(az), sz = Math.sin(az);
  const X = [1, 0, 0, 0, cx, -sx, 0, sx, cx], Y = [cy, 0, sy, 0, 1, 0, -sy, 0, cy], Z = [cz, -sz, 0, sz, cz, 0, 0, 0, 1];
  const mul = (a: number[], b: number[]) => [0, 1, 2].flatMap((r) => [0, 1, 2].map((c) => a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c]));
  return mul(Z, mul(Y, X));
}

// ---------- the picture's silhouette ----------

/**
 * The silhouette sampled on a grid: coverage (0-1), which samples are inside, and how far each is from the edge (in
 * samples).
 */
interface Grid { gw: number; gh: number; cx: number; cy: number; a: Float32Array; inside: Uint8Array; d: Float32Array; maxD: number }
const gridCache = new Map<string, Grid>();

function silhouette(src: HTMLCanvasElement, key: string): Grid {
  const ck = `${key}|${src.width}x${src.height}`;
  const hit = gridCache.get(ck);
  if (hit) return hit;
  if (gridCache.size > 16) gridCache.clear();
  const W = src.width, H = src.height;
  // About every 2.5 pixels, between 64 and 320 samples along the long side.
  const cell = Math.max(W, H) / Math.min(320, Math.max(64, Math.max(W, H) / 2.5));
  const gw = Math.max(2, Math.round(W / cell) + 1), gh = Math.max(2, Math.round(H / cell) + 1);
  const c = document.createElement('canvas'); c.width = gw; c.height = gh;
  const x = c.getContext('2d', { willReadFrequently: true })!;
  x.drawImage(src, 0, 0, gw, gh);
  const px = x.getImageData(0, 0, gw, gh).data;
  const a = new Float32Array(gw * gh), inside = new Uint8Array(gw * gh);
  for (let i = 0; i < gw * gh; i++) { a[i] = px[i * 4 + 3] / 255; inside[i] = px[i * 4 + 3] >= 128 ? 1 : 0; }
  const d = edt(inside, gw, gh);
  let maxD = 0;
  for (let i = 0; i < d.length; i++) if (d[i] > maxD) maxD = d[i];
  const g = { gw, gh, cx: W / (gw - 1), cy: H / (gh - 1), a, inside, d, maxD };
  gridCache.set(ck, g);
  return g;
}

/**
 * Euclidean distance from each inside cell to the nearest outside one (Felzenszwalb & Huttenlocher's two-pass
 * method: exact, and linear in the number of cells). Outside cells are 0; the grid's border counts as outside.
 */
export function edt(inside: Uint8Array, W: number, H: number): Float32Array {
  const INF = 1e12;
  const f = new Float64Array(W * H);
  for (let i = 0; i < W * H; i++) f[i] = inside[i] ? INF : 0;
  const n = Math.max(W, H) + 2;
  const z = new Float64Array(n + 1), v = new Int32Array(n), line = new Float64Array(n), out = new Float64Array(n);
  // One dimension at a time: the lower envelope of parabolas rooted at each cell.
  const pass1 = (len: number) => {
    // `line` is padded with an outside cell at each end, so the grid's border counts as an edge.
    const L = len + 2;
    const sect = (q: number, p: number) => ((line[q] + q * q) - (line[p] + p * p)) / (2 * q - 2 * p);
    let k = 0;
    v[0] = 0; z[0] = -INF; z[1] = INF;
    for (let q = 1; q < L; q++) {
      let s = sect(q, v[k]);
      while (k > 0 && s <= z[k]) { k--; s = sect(q, v[k]); }
      k++; v[k] = q; z[k] = s; z[k + 1] = INF;
    }
    k = 0;
    for (let q = 0; q < L; q++) {
      while (z[k + 1] < q) k++;
      out[q] = (q - v[k]) * (q - v[k]) + line[v[k]];
    }
  };
  for (let x = 0; x < W; x++) {
    line[0] = 0; line[H + 1] = 0;
    for (let y = 0; y < H; y++) line[y + 1] = f[y * W + x];
    pass1(H);
    for (let y = 0; y < H; y++) f[y * W + x] = out[y + 1];
  }
  const d = new Float32Array(W * H);
  for (let y = 0; y < H; y++) {
    line[0] = 0; line[W + 1] = 0;
    for (let x = 0; x < W; x++) line[x + 1] = f[y * W + x];
    pass1(W);
    for (let x = 0; x < W; x++) d[y * W + x] = inside[y * W + x] ? Math.sqrt(out[x + 1]) : 0;
  }
  return d;
}

// ---------- meshes ----------

/**
 * A mesh: triangles of vertices [x, y, z, nx, ny, nz, u, v, kind, tx, ty] in layer pixels (z toward the viewer), and
 * its extent. `kind` 1 = always drawn (sides, revolved surfaces); 0 and 2 = the front and back faces, cut out by the
 * picture's own edges. (tx, ty) is where a texture goes, in pixels across the surface: the faces' own position, the
 * distance around the outline and back from the front on Extrude's sides, around and down on a revolved surface.
 * `area` is the region a texture is fitted to: its centre and size in those pixels.
 */
interface Mesh { data: Float32Array; count: number; lo: [number, number, number]; hi: [number, number, number]; area: [number, number, number, number] }
const STRIDE = 11;
const meshCache = new Map<string, Mesh>();

function finish(data: number[], area: [number, number, number, number]): Mesh {
  const lo: [number, number, number] = [Infinity, Infinity, Infinity], hi: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < data.length; i += STRIDE) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], data[i + k]); hi[k] = Math.max(hi[k], data[i + k]); }
  if (!data.length) { lo.fill(0); hi.fill(1); }
  return { data: new Float32Array(data), count: data.length / STRIDE, lo, hi, area };
}

/**
 * Front and back surfaces of a height field over the silhouette (`h` per grid sample; the back mirrors it). `back`
 * is the back face's kind: 2 when sides hide its edge, 0 to give it soft edges like the front.
 */
function heightSurfaces(g: Grid, h: Float32Array, W: number, H: number, out: number[], back: 0 | 2) {
  const { gw, gh, cx, cy } = g;
  const at = (i: number, j: number) => h[Math.min(gh - 1, Math.max(0, j)) * gw + Math.min(gw - 1, Math.max(0, i))];
  const ins = (i: number, j: number) => i >= 0 && j >= 0 && i < gw && j < gh && g.inside[j * gw + i] === 1;
  const vert = (i: number, j: number, side: 1 | -1) => {
    // Outward: both surfaces slope away from the middle; only the facing (z) flips for the back.
    const dx = (at(i + 1, j) - at(i - 1, j)) / (2 * cx), dy = (at(i, j + 1) - at(i, j - 1)) / (2 * cy);
    const n = [-dx, -dy, side], l = Math.hypot(n[0], n[1], n[2]);
    const x = i * cx, y = j * cy;
    return [x, y, at(i, j) * side, n[0] / l, n[1] / l, n[2] / l, x / W, y / H, side > 0 ? 0 : back, x, y];
  };
  for (const side of [1, -1] as const) {
    for (let j = 0; j < gh - 1; j++) for (let i = 0; i < gw - 1; i++) {
      // Only cells at or next to the silhouette (the rest is cut away anyway).
      let near = false;
      for (let dj = -1; dj <= 2 && !near; dj++) for (let di = -1; di <= 2 && !near; di++) near = ins(i + di, j + dj);
      if (!near) continue;
      const a = vert(i, j, side), b = vert(i + 1, j, side), c = vert(i, j + 1, side), d = vert(i + 1, j + 1, side);
      out.push(...a, ...b, ...c, ...b, ...d, ...c);
    }
  }
}

/** Inflate: rounded on both sides, steep at the edge and levelling off toward the middle. */
function inflateMesh(g: Grid, m: Model3D, W: number, H: number): Mesh {
  const radius = Math.max(1, g.maxD - 0.5), rr = radius * (0.15 + 0.85 * (m.round / 100));
  const depth = (m.depth / 100) * radius * Math.min(g.cx, g.cy);
  let h: Float32Array = new Float32Array(g.d.length);
  const { gw, gh } = g;
  const out4 = (k: number) => {
    const i = k % gw, j = (k - i) / gw;
    return i === 0 || j === 0 || i === gw - 1 || j === gh - 1 || !g.inside[k - 1] || !g.inside[k + 1] || !g.inside[k - gw] || !g.inside[k + gw];
  };
  for (let k = 0; k < h.length; k++) {
    if (!g.inside[k]) continue;
    // Distance in from the edge. Next to the edge, the coverage places it between samples (a sample half covered
    // sits on it); otherwise the edge would sit at the same half-sample everywhere and step along slanted edges.
    const dist = out4(k) ? Math.max(0, g.a[k] - 0.5) : g.d[k] - 0.5;
    const u = Math.min(1, dist / rr);
    h[k] = depth * Math.sqrt(Math.max(0, 1 - (1 - u) * (1 - u)));
  }
  // Soften the crease where the distances from opposite edges meet (the middle of a stroke) into a smooth crown.
  h = smooth(g, h, 3, 1.2);
  const out: number[] = [];
  heightSurfaces(g, h, W, H, out, 0);
  return finish(out, [W / 2, H / 2, W, H]);
}

/** Averages a height field with its neighbours `passes` times, inside the silhouette, past `edge` samples in. */
function smooth(g: Grid, h: Float32Array, passes: number, edge: number): Float32Array {
  const { gw, gh } = g;
  for (let pass = 0; pass < passes; pass++) {
    const s = new Float32Array(h.length);
    for (let j = 0; j < gh; j++) for (let i = 0; i < gw; i++) {
      const k = j * gw + i;
      if (!g.inside[k]) { s[k] = h[k]; continue; }
      let sum = 0, n = 0;
      for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
        const ii = i + di, jj = j + dj;
        if (ii < 0 || jj < 0 || ii >= gw || jj >= gh) continue;
        sum += h[jj * gw + ii]; n++;
      }
      s[k] = g.d[k] > edge ? sum / n : h[k];
    }
    h = s;
  }
  return h;
}

/** A blur close to a Gaussian (three box blurs of radius `r`, across then down). */
function boxBlur(src: Float32Array, w: number, h: number, r: number): Float32Array {
  let a = Float32Array.from(src), b = new Float32Array(src.length);
  const run = (len: number, stride: number, count: number, step: number) => {
    for (let c = 0; c < count; c++) {
      const o = c * step;
      let sum = 0;
      for (let k = -r; k <= r; k++) sum += a[o + Math.min(len - 1, Math.max(0, k)) * stride];
      for (let i = 0; i < len; i++) {
        b[o + i * stride] = sum / (2 * r + 1);
        sum += a[o + Math.min(len - 1, i + r + 1) * stride] - a[o + Math.max(0, i - r) * stride];
      }
    }
    [a, b] = [b, a];
  };
  for (let p = 0; p < 3; p++) { run(w, 1, h, w); run(h, w, w, 1); }
  return a;
}

/**
 * The picture's coverage (0-1) at up to 1600 px on its long side (scale `s`), with a transparent pixel border all
 * round: pixel (i, j) is centred on layer pixel ((i - 0.5) / s, (j - 0.5) / s).
 */
function coverage(src: HTMLCanvasElement) {
  const s = Math.min(1, 1600 / Math.max(src.width, src.height));
  const w = Math.max(1, Math.round(src.width * s)), hh = Math.max(1, Math.round(src.height * s));
  const PW = w + 2, PH = hh + 2;
  const c = document.createElement('canvas'); c.width = PW; c.height = PH;
  const x = c.getContext('2d', { willReadFrequently: true })!;
  x.drawImage(src, 1, 1, w, hh);
  const px = x.getImageData(0, 0, PW, PH).data;
  const val = new Float32Array(PW * PH);
  for (let i = 0; i < val.length; i++) val[i] = px[i * 4 + 3] / 255;
  return { s, PW, PH, val };
}

/**
 * The picture's edges (where it's half covered) as closed loops in layer pixels, found with marching squares so they
 * follow anti-aliased edges smoothly, between pixels. Each runs with the inside on its right (y down).
 */
function contours(src: HTMLCanvasElement): Pt[][] {
  const { s, PW, PH, val } = coverage(src);
  const at = (i: number, j: number) => val[j * PW + i];
  // Each crossing sits on a grid edge: horizontal (i,j)-(i+1,j) is 2k, vertical (i,j)-(i,j+1) is 2k+1.
  const nb = new Int32Array(PW * PH * 4).fill(-1);
  const link = (a: number, b: number) => {
    nb[a * 2 + (nb[a * 2] < 0 ? 0 : 1)] = b;
    nb[b * 2 + (nb[b * 2] < 0 ? 0 : 1)] = a;
  };
  for (let j = 0; j < PH - 1; j++) for (let i = 0; i < PW - 1; i++) {
    const tl = at(i, j), tr = at(i + 1, j), br = at(i + 1, j + 1), bl = at(i, j + 1);
    const code = (tl >= 0.5 ? 8 : 0) | (tr >= 0.5 ? 4 : 0) | (br >= 0.5 ? 2 : 0) | (bl >= 0.5 ? 1 : 0);
    if (code === 0 || code === 15) continue;
    const T = (j * PW + i) * 2, B = ((j + 1) * PW + i) * 2, L = (j * PW + i) * 2 + 1, R = (j * PW + i + 1) * 2 + 1;
    const mid = (tl + tr + br + bl) / 4 >= 0.5;
    switch (code) {
      case 1: case 14: link(L, B); break;
      case 2: case 13: link(B, R); break;
      case 3: case 12: link(L, R); break;
      case 4: case 11: link(T, R); break;
      case 6: case 9: link(T, B); break;
      case 7: case 8: link(T, L); break;
      case 5: if (mid) { link(T, L); link(B, R); } else { link(T, R); link(L, B); } break;
      case 10: if (mid) { link(T, R); link(L, B); } else { link(T, L); link(B, R); } break;
    }
  }
  const point = (e: number): Pt => {
    const k = e >> 1, i = k % PW, j = (k - i) / PW, vert = e & 1;
    const a = at(i, j), b = vert ? at(i, j + 1) : at(i + 1, j);
    const t = Math.min(1, Math.max(0, (0.5 - a) / (b - a || 1e-6)));
    // Pixel centres, back in layer pixels.
    return { x: ((vert ? i : i + t) - 1 + 0.5) / s, y: ((vert ? j + t : j) - 1 + 0.5) / s };
  };
  const seen = new Uint8Array(PW * PH * 2);
  const loops: Pt[][] = [];
  for (let e0 = 0; e0 < seen.length; e0++) {
    if (seen[e0] || nb[e0 * 2] < 0) continue;
    const loop: Pt[] = [];
    let prev = -1, e = e0;
    while (e >= 0 && !seen[e]) {
      seen[e] = 1;
      const p = point(e);
      // Skip points closer than about a pixel and a half to the last one kept.
      const q = loop[loop.length - 1];
      if (!q || Math.hypot(p.x - q.x, p.y - q.y) >= 1.5) loop.push(p);
      const next = nb[e * 2] !== prev ? nb[e * 2] : nb[e * 2 + 1];
      prev = e; e = next;
    }
    if (loop.length < 3) continue;
    // Which way round it runs: vote, a step outside the normal side of a few segments.
    let vote = 0;
    const n = loop.length, step = Math.max(1, Math.floor(n / 16));
    for (let i = 0; i < n; i += step) {
      const p = loop[i], q = loop[(i + 1) % n], dx = q.x - p.x, dy = q.y - p.y, l = Math.hypot(dx, dy) || 1;
      const sx = Math.round(((p.x + q.x) / 2 + (dy / l) * 1.5) * s + 0.5), sy = Math.round(((p.y + q.y) / 2 - (dx / l) * 1.5) * s + 0.5);
      if (sx >= 0 && sy >= 0 && sx < PW && sy < PH) vote += at(sx, sy) >= 0.5 ? 1 : -1;
    }
    loops.push(vote > 0 ? loop.reverse() : loop);
  }
  return loops;
}

/** Extrude: flat (or bevelled) faces front and back, joined by straight sides along the silhouette. */
function extrudeMesh(g: Grid, src: HTMLCanvasElement, m: Model3D, W: number, H: number): Mesh {
  const zf = ((m.depth / 100) * Math.min(W, H) * 0.5) / 2;
  const h = new Float32Array(g.d.length).fill(zf);
  if ((m.bevel ?? 0) > 0) {
    // The bevel: a rounded rise from the side up to the face, over part of each stroke's half-width. It follows a
    // blurred copy of the picture's coverage, which ramps evenly along any edge (a distance measured on the grid
    // would step along slanted edges).
    const bw = Math.max(1, ((m.bevel ?? 0) / 100) * Math.max(1, g.maxD - 0.5) * 0.7);
    const bh = bw * Math.min(g.cx, g.cy) * 0.7;
    const b = boxBlur(g.a, g.gw, g.gh, Math.max(1, Math.round(bw / 2)));
    for (let i = 0; i < h.length; i++) {
      // Rounded, but never quite upright at the edge (that would show the sampling grid as a dashed line).
      const u = Math.min(1, Math.max(0, (b[i] - 0.5) * 2));
      h[i] += bh * (1 - (1 - u) * (1 - u));
    }
  }
  const out: number[] = [];
  heightSurfaces(g, h, W, H, out, 2);
  // The sides, along the picture's edge, coloured from the picture just inside it.
  for (const pts of contours(src)) {
    const n = pts.length;
    // Each segment's outward normal: (dy, -dx) keeps the inside on the right; contours() runs that way.
    const seg = pts.map((p, i) => {
      const q = pts[(i + 1) % n], dx = q.x - p.x, dy = q.y - p.y, l = Math.hypot(dx, dy) || 1;
      return { x: dy / l, y: -dx / l };
    });
    // A segment's normal at one of its ends (vertex `v`): averaged over the neighbouring segments that run the same
    // way, which evens out the traced outline's pixel steps; a corner (a sharper turn) stays crisp.
    const K = 4;
    const vn = (i: number, v: number) => {
      const own = seg[i];
      let x = 0, y = 0;
      for (const dir of [-1, 1]) {
        for (let k = 0; k < K; k++) {
          const j = (((dir < 0 ? v - 1 - k : v + k) % n) + n) % n, sj = seg[j];
          if (own.x * sj.x + own.y * sj.y < 0.7) break;
          const w = K - k;
          x += sj.x * w; y += sj.y * w;
        }
      }
      const l = Math.hypot(x, y);
      return l ? { x: x / l, y: y / l } : own;
    };
    // A texture runs around the outline (distance along it) and back from the front.
    let run = 0;
    for (let i = 0; i < n; i++) {
      const p = pts[i], q = pts[(i + 1) % n], s = seg[i];
      const na = vn(i, i), nb = vn(i, (i + 1) % n);
      const r0 = run;
      run += Math.hypot(q.x - p.x, q.y - p.y);
      // Colour from just inside the edge.
      const ua = (p.x - s.x * 1.5) / W, va = (p.y - s.y * 1.5) / H, ub = (q.x - s.x * 1.5) / W, vb = (q.y - s.y * 1.5) / H;
      const A = [p.x, p.y, zf, na.x, na.y, 0, ua, va, 1, r0, 0], B = [q.x, q.y, zf, nb.x, nb.y, 0, ub, vb, 1, run, 0];
      const C = [q.x, q.y, -zf, nb.x, nb.y, 0, ub, vb, 1, run, 2 * zf], D = [p.x, p.y, -zf, na.x, na.y, 0, ua, va, 1, r0, 2 * zf];
      out.push(...A, ...B, ...C, ...A, ...C, ...D);
    }
  }
  return finish(out, [W / 2, H / 2, W, H]);
}

/** Revolve: each row of the silhouette becomes a ring around an upright axis through the picture's middle. */
function revolveMesh(g: Grid, src: HTMLCanvasElement, m: Model3D, W: number, H: number): Mesh {
  const { gh, cy } = g;
  const axisX = pivotX(W, m);
  // How far each row reaches from the axis (outer), and where a gap around the axis ends (inner, for hollow parts).
  // Each row's edges, read from the picture in detail and placed between pixels where the coverage crosses half (so
  // the radius changes smoothly from row to row, not in steps).
  const outer = new Float32Array(gh), inner = new Float32Array(gh), has = new Uint8Array(gh);
  const { s, PW, PH, val } = coverage(src);
  const row = new Float32Array(PW);
  const lx = (i: number) => (i - 0.5) / s;
  for (let j = 0; j < gh; j++) {
    const fy = Math.min(PH - 1, Math.max(0, j * cy * s + 0.5)), j0 = Math.floor(fy), j1 = Math.min(PH - 1, j0 + 1), t = fy - j0;
    for (let i = 0; i < PW; i++) row[i] = val[j0 * PW + i] * (1 - t) + val[j1 * PW + i] * t;
    const cross = (i: number, i2: number) => lx(i) + (lx(i2) - lx(i)) * ((row[i] - 0.5) / Math.max(1e-6, row[i] - row[i2]));
    // Only the right of a middle axis counts (the picture is drawn whole, so its left half mirrors it).
    const first = m.axis === 'left' ? 1 : Math.max(1, Math.ceil(axisX * s + 0.5));
    let hi = -1, lo = -1;
    for (let i = PW - 2; i >= first; i--) if (row[i] >= 0.5) { hi = cross(i, i + 1) - axisX; break; }
    if (hi < 0) continue;
    for (let i = first; i < PW - 1; i++) if (row[i] >= 0.5) { lo = i === first ? 0 : cross(i, i - 1) - axisX; break; }
    has[j] = 1; outer[j] = hi; inner[j] = lo <= 1.5 ? 0 : lo;
  }
  // Even out the sampled outline's small wobbles along the height (they'd show as rings in the shading).
  const soft = (r: Float32Array, passes: number) => {
    for (let p = 0; p < passes; p++) {
      const s = new Float32Array(r);
      for (let j = 1; j < gh - 1; j++) if (has[j - 1] && has[j] && has[j + 1]) s[j] = (r[j - 1] + 2 * r[j] + r[j + 1]) / 4;
      r = s;
    }
    return r;
  };
  const ro = soft(outer, 2), ri = soft(inner, 2);
  const N = 72;
  const out: number[] = [];
  // A texture wraps once around the widest part, like a label, centred on the front (three quarters of the way
  // round, as the texture's position runs).
  let widest = 1;
  for (let j = 0; j < gh; j++) if (has[j]) widest = Math.max(widest, ro[j]);
  const C = 2 * Math.PI * widest;
  const ring = (j: number, r: number, k: number, slope: number, sign: 1 | -1) => {
    const t = (k / N) * Math.PI * 2, c = Math.cos(t), s = Math.sin(t);
    // Normal: outward from the axis, tipped by how the radius changes with height.
    const nx = c * sign, ny = -slope * sign, nz = s * sign, l = Math.hypot(nx, ny, nz) || 1;
    // Colour from the picture just inside its edge on this row.
    // (Around runs against the angle, so seen from the front it reads left to right.)
    return [axisX + r * c, j * cy, r * s, nx / l, ny / l, nz / l, Math.min(1, Math.max(0, (axisX + Math.max(0, r - 1.5)) / W)), (j * cy) / H, 1, (1 - k / N) * C, j * cy];
  };
  const slopeAt = (r: Float32Array, j: number) => {
    const a = has[j - 1] ? r[j - 1] : r[j], b = has[j + 1] ? r[j + 1] : r[j];
    return (b - a) / (2 * cy);
  };
  for (let j = 0; j < gh - 1; j++) {
    if (!has[j] || !has[j + 1]) continue;
    for (const [r, sign] of [[ro, 1], [ri, -1]] as const) {
      if (sign === -1 && (ri[j] <= 0 || ri[j + 1] <= 0)) continue;
      const sa = slopeAt(r, j), sb = slopeAt(r, j + 1);
      for (let k = 0; k < N; k++) {
        const a = ring(j, r[j], k, sa, sign), b = ring(j, r[j], k + 1, sa, sign);
        const c = ring(j + 1, r[j + 1], k, sb, sign), d = ring(j + 1, r[j + 1], k + 1, sb, sign);
        out.push(...a, ...b, ...c, ...b, ...d, ...c);
      }
    }
  }
  // Flat caps where the shape starts and ends (a lid or a ring's rim, from the inner to the outer radius).
  for (let j = 0; j < gh; j++) {
    if (!has[j]) continue;
    for (const [end, ny] of [[!has[j - 1], -1], [!has[j + 1], 1]] as const) {
      if (!end) continue;
      for (let k = 0; k < N; k++) {
        const t0 = (k / N) * Math.PI * 2, t1 = ((k + 1) / N) * Math.PI * 2, y = j * cy, v = y / H;
        // The texture lies flat across a cap, as if seen from above.
        const P = (r: number, t: number) => [axisX + r * Math.cos(t), y, r * Math.sin(t), 0, ny, 0, Math.min(1, (axisX + Math.max(0, r - 1.5)) / W), v, 1, (3 * C) / 4 + r * Math.cos(t), y + r * Math.sin(t)];
        const a = P(ri[j], t0), b = P(ri[j], t1), c = P(ro[j], t0), d = P(ro[j], t1);
        out.push(...a, ...b, ...c, ...b, ...d, ...c);
      }
    }
  }
  return finish(out, [(3 * C) / 4, H / 2, C, H]);
}

function meshFor(src: HTMLCanvasElement, m: Model3D, key: string): Mesh {
  const ck = `${key}|${src.width}x${src.height}|${m.kind}|${m.depth}|${m.round}|${m.bevel ?? 0}|${m.axis ?? 'centre'}`;
  const hit = meshCache.get(ck);
  if (hit) return hit;
  if (meshCache.size > 16) meshCache.clear();
  const g = silhouette(src, key), W = src.width, H = src.height;
  const mesh = m.kind === 'extrude' ? extrudeMesh(g, src, m, W, H) : m.kind === 'revolve' ? revolveMesh(g, src, m, W, H) : inflateMesh(g, m, W, H);
  meshCache.set(ck, mesh);
  return mesh;
}

// ---------- projection ----------

/** Camera distance, as a multiple of the picture's size (gentle perspective). */
const CAM = 4;

/** What it turns around: the picture's centre, or for Revolve around the left edge, that edge (its own axis). */
const pivotX = (W: number, m: Model3D) => (m.kind === 'revolve' && m.axis === 'left' ? 0 : W / 2);

/** Where a layer pixel (x, y) at depth z lands after turning, around the pivot. */
function projector(W: number, H: number, m: Model3D) {
  const R = rotation(m), cx = pivotX(W, m), cy = H / 2, f = CAM * Math.max(W, H);
  return (x: number, y: number, z: number) => {
    const px = x - cx, py = y - cy;
    const X = R[0] * px + R[1] * py + R[2] * z, Y = R[3] * px + R[4] * py + R[5] * z, Z = R[6] * px + R[7] * py + R[8] * z;
    const k = f / (f - Z);
    return { x: cx + X * k, y: cy + Y * k, z: Z };
  };
}

/** The box (layer pixels) around a mesh's extent once turned. */
function boundsOf(W: number, H: number, m: Model3D, mesh: Mesh): Rect {
  const P = projector(W, H, m);
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const x of [mesh.lo[0], mesh.hi[0]]) for (const y of [mesh.lo[1], mesh.hi[1]]) for (const z of [mesh.lo[2], mesh.hi[2]]) {
    const p = P(x, y, z);
    x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y);
  }
  return { x: Math.floor(x0) - 2, y: Math.floor(y0) - 2, w: Math.ceil(x1 - x0) + 4, h: Math.ceil(y1 - y0) + 4 };
}

// ---------- rendering ----------

const VS = `#version 300 es
in vec3 aPos; in vec3 aNrm; in vec2 aUV; in float aSolid; in vec2 aT;
uniform mat3 uR; uniform vec2 uC; uniform float uF; uniform vec4 uBox; uniform float uZr;
out vec3 vN; out vec2 vUV; out float vSolid; out float vZ; out vec2 vT; out vec3 vP;
void main() {
  vec3 p = uR * vec3(aPos.xy - uC, aPos.z);
  float k = uF / (uF - p.z);
  vec2 s = uC + p.xy * k;
  vN = uR * aNrm;
  vZ = p.z;
  vP = p;
  vT = aT;
  vUV = aUV;
  vSolid = aSolid;
  gl_Position = vec4((s.x - uBox.x) / uBox.z * 2.0 - 1.0, 1.0 - (s.y - uBox.y) / uBox.w * 2.0, -p.z / uZr, 1.0);
}`;
const FS = `#version 300 es
precision highp float;
in vec3 vN; in vec2 vUV; in float vSolid; in float vZ; in vec2 vT; in vec3 vP; out vec4 o;
uniform int uOut; uniform vec2 uZ;
uniform sampler2D uTex; uniform sampler2D uBled; uniform int uPass; uniform mat3 uR;
uniform vec3 uL; uniform vec4 uCol; uniform vec4 uMat; uniform float uAmb; uniform float uStr;
// The texture: on/off, where it sits (centre and size in surface pixels), its turn, and
// uTxOpt: x multiply (else replace), y amount, z tile, w where (0 all, 1 front and back, 2 sides). uKind 1 = Extrude.
uniform sampler2D uTx; uniform int uTxOn; uniform vec4 uTxFit; uniform float uTxRot; uniform vec4 uTxOpt;
uniform float uBump; uniform int uKind;
float lum(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
void main() {
  // Faces are cut out by the picture's own edges; sides and revolved surfaces are always solid. Pass 0 draws it all
  // solid (faces cut where they're half covered), pass 1 adds the faces' soft edges over whatever is behind them.
  bool solid = vSolid > 0.5 && vSolid < 1.5;
  float a = solid ? 1.0 : smoothstep(0.3, 0.7, texture(uTex, vUV).a);
  if (uPass == 0) { if (a < 0.5) discard; a = 1.0; }
  // (Only the face turned toward the viewer: the other one's edge would peek out past the sides.)
  else if (solid || a < 0.01 || a > 0.99 || (vSolid > 1.5 ? -uR[2][2] : uR[2][2]) < 0.0) discard;
  // Colours come from a copy of the picture with its edge colours spread outward, so the sides never pick up
  // the empty (black) pixels just past the edge.
  vec4 t = texture(uBled, vUV);
  vec3 base = uCol.a > 0.5 ? uCol.rgb : t.rgb / max(t.a, 1e-4);
  vec3 N = normalize(vN);
  // Two-sided: a surface seen from behind is lit from its other side.
  if (!gl_FrontFacing && solid && dot(N, vec3(0.0, 0.0, 1.0)) < 0.0) N = -N;
  bool side = solid && uKind == 1;
  float w = 0.0;
  if (uTxOn == 1 && (uTxOpt.w < 0.5 || (uTxOpt.w < 1.5 ? !side : side))) {
    float cr = cos(uTxRot), sr = sin(uTxRot);
    vec2 d = vT - uTxFit.xy;
    vec2 q = vec2(cr * d.x + sr * d.y, -sr * d.x + cr * d.y) / uTxFit.zw + 0.5;
    bool rep = uTxOpt.z > 0.5 || side;
    float inside = rep ? 1.0 : step(0.0, q.x) * step(q.x, 1.0) * step(0.0, q.y) * step(q.y, 1.0);
    vec4 tc = texture(uTx, q);
    vec3 tcol = tc.rgb / max(tc.a, 1e-4);
    w = tc.a * uTxOpt.y * inside;
    base = mix(base, uTxOpt.x > 0.5 ? base * tcol : tcol, w);
    // Bump: its light areas stand out. The surface's slope comes from how the height changes across the screen
    // (no stored tangents needed).
    if (uBump > 0.0) {
      float hh = lum(tcol) * w * uBump;
      vec3 dpx = dFdx(vP), dpy = dFdy(vP);
      vec3 r1 = cross(dpy, N), r2 = cross(N, dpx);
      float det = dot(dpx, r1);
      vec3 g = sign(det) * (dFdx(hh) * r1 + dFdy(hh) * r2);
      N = normalize(abs(det) * N - g);
    }
  }
  float diff = max(dot(N, uL), 0.0);
  vec3 H = normalize(uL + vec3(0.0, 0.0, 1.0));
  float spec = pow(max(dot(N, H), 0.0), uMat.z) * uMat.y;
  // uMat: x diffuse weight, y specular weight, z shininess, w metal (specular takes the surface colour).
  vec3 specCol = mix(vec3(1.0), base, uMat.w);
  vec3 c = base * (uAmb + uMat.x * diff * uStr) + specCol * spec * uStr;
  // A depth map instead: its nearest point white, its farthest dark grey.
  if (uOut == 1) c = vec3(mix(0.2, 1.0, clamp((vZ - uZ.x) / max(uZ.y - uZ.x, 1e-3), 0.0, 1.0)));
  o = vec4(c * a, a);
}`;

const MATERIALS = { matte: [1, 0, 1, 0], plastic: [1, 0.45, 40, 0], metal: [0.35, 1, 60, 1] } as const;

/** The picture with its edge colours spread about 10 px outward (copies shifted every way, slipped underneath). */
function bleed(src: HTMLCanvasElement): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = src.width; c.height = src.height;
  const x = c.getContext('2d')!;
  x.drawImage(src, 0, 0);
  x.globalCompositeOperation = 'destination-over';
  for (const r of [1, 2, 3, 5, 7, 10]) for (let k = 0; k < 8; k++) {
    const t = (k / 8) * Math.PI * 2;
    x.drawImage(src, Math.round(Math.cos(t) * r), Math.round(Math.sin(t) * r));
  }
  return c;
}

class ModelGL {
  readonly canvas = document.createElement('canvas');
  private gl: WebGL2RenderingContext | null = null;
  private prog: WebGLProgram | null = null;
  private tex: WebGLTexture | null = null;
  private bled: WebGLTexture | null = null;
  private texKey = '';
  /** The 3D layer's texture image, and which one is loaded. */
  private tx: WebGLTexture | null = null;
  private txKey = '';
  private buf: WebGLBuffer | null = null;
  private bufMesh: Mesh | null = null;
  private u: Record<string, WebGLUniformLocation | null> = {};

  private init() {
    if (this.gl) return this.gl;
    const gl = this.canvas.getContext('webgl2', { premultipliedAlpha: true, antialias: true, preserveDrawingBuffer: true });
    if (!gl) return null;
    const sh = (type: number, src: string) => { const s = gl.createShader(type)!; gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) console.error(gl.getShaderInfoLog(s)); return s; };
    const p = gl.createProgram()!;
    gl.attachShader(p, sh(gl.VERTEX_SHADER, VS));
    gl.attachShader(p, sh(gl.FRAGMENT_SHADER, FS));
    ['aPos', 'aNrm', 'aUV', 'aSolid', 'aT'].forEach((n, i) => gl.bindAttribLocation(p, i, n));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) { console.error('3D shader failed', gl.getProgramInfoLog(p)); return null; }
    for (const n of ['uR', 'uC', 'uF', 'uBox', 'uZr', 'uTex', 'uBled', 'uPass', 'uOut', 'uZ', 'uL', 'uCol', 'uMat', 'uAmb', 'uStr',
      'uTx', 'uTxOn', 'uTxFit', 'uTxRot', 'uTxOpt', 'uBump', 'uKind']) this.u[n] = gl.getUniformLocation(p, n);
    const mk = (wrap: number) => {
      const t = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap);
      return t;
    };
    this.tex = mk(gl.CLAMP_TO_EDGE);
    this.bled = mk(gl.CLAMP_TO_EDGE);
    this.tx = mk(gl.REPEAT);
    this.buf = gl.createBuffer();
    this.gl = gl;
    this.prog = p;
    return gl;
  }

  /**
   * The 3D layer (or its depth map) drawn into its box (layer pixels) at `scale` output pixels per layer pixel.
   * `tex` is its texture's image, if it has one.
   */
  render(src: HTMLCanvasElement, m: Model3D, key: string, scale: number, depth = false, tex?: HTMLCanvasElement | null): { canvas: HTMLCanvasElement; box: Rect } | null {
    const gl = this.init();
    if (!gl || !this.prog) return null;
    const W = src.width, H = src.height;
    const mesh = meshFor(src, m, key);
    const box = boundsOf(W, H, m, mesh);
    let s = Math.max(0.1, scale);
    while (s > 0.1 && Math.max(box.w, box.h) * s > 4096) s /= 2;
    const cw = Math.max(1, Math.ceil(box.w * s)), ch = Math.max(1, Math.ceil(box.h * s));
    if (this.canvas.width !== cw || this.canvas.height !== ch) { this.canvas.width = cw; this.canvas.height = ch; }
    gl.viewport(0, 0, cw, ch);
    gl.clearColor(0, 0, 0, 0);
    gl.clearDepth(1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LESS);
    gl.useProgram(this.prog);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buf);
    if (this.bufMesh !== mesh) { gl.bufferData(gl.ARRAY_BUFFER, mesh.data, gl.STATIC_DRAW); this.bufMesh = mesh; }
    const tk = `${key}|${W}x${H}`;
    if (this.texKey !== tk) {
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, this.bled);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, bleed(src));
      this.texKey = tk;
    }
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.bled);
    const R = rotation(m);
    // GLSL mat3 is column-major: pass the transpose of the row-major rotation.
    gl.uniformMatrix3fv(this.u.uR, false, [R[0], R[3], R[6], R[1], R[4], R[7], R[2], R[5], R[8]]);
    const px = pivotX(W, m);
    gl.uniform2f(this.u.uC, px, H / 2);
    gl.uniform1f(this.u.uF, CAM * Math.max(W, H));
    gl.uniform4f(this.u.uBox, box.x, box.y, box.w, box.h);
    const ext = Math.max(...[mesh.lo, mesh.hi].flatMap((p) => p.map((v, i) => Math.abs(v - (i === 0 ? px : i === 1 ? H / 2 : 0)))));
    gl.uniform1f(this.u.uZr, ext * 2 + 1);
    gl.uniform1i(this.u.uTex, 0);
    gl.uniform1i(this.u.uBled, 1);
    gl.uniform1i(this.u.uOut, depth ? 1 : 0);
    if (depth) {
      // The nearest and farthest the turned object reaches (its box's corners).
      const P = projector(W, H, m);
      let z0 = Infinity, z1 = -Infinity;
      for (const x of [mesh.lo[0], mesh.hi[0]]) for (const y of [mesh.lo[1], mesh.hi[1]]) for (const z of [mesh.lo[2], mesh.hi[2]]) {
        const pz = P(x, y, z).z;
        z0 = Math.min(z0, pz); z1 = Math.max(z1, pz);
      }
      gl.uniform2f(this.u.uZ, z0, z1);
    }
    const el = m.light.el * D2R, az = m.light.az * D2R;
    gl.uniform3f(this.u.uL, Math.cos(el) * Math.cos(az), -Math.cos(el) * Math.sin(az), Math.sin(el));
    const col = m.color ? [parseInt(m.color.slice(1, 3), 16) / 255, parseInt(m.color.slice(3, 5), 16) / 255, parseInt(m.color.slice(5, 7), 16) / 255, 1] : [0, 0, 0, 0];
    gl.uniform4f(this.u.uCol, col[0], col[1], col[2], col[3]);
    gl.uniform4fv(this.u.uMat, MATERIALS[m.material]);
    gl.uniform1f(this.u.uAmb, m.light.ambient / 100);
    gl.uniform1f(this.u.uStr, m.light.strength / 100);
    gl.uniform1i(this.u.uKind, m.kind === 'extrude' ? 1 : m.kind === 'revolve' ? 2 : 0);
    const t = m.texture;
    gl.uniform1i(this.u.uTxOn, t && tex && !depth ? 1 : 0);
    gl.uniform1i(this.u.uTx, 2);
    if (t && tex && !depth) {
      gl.activeTexture(gl.TEXTURE2);
      gl.bindTexture(gl.TEXTURE_2D, this.tx);
      if (this.txKey !== t.key) {
        gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, tex);
        this.txKey = t.key;
      }
      // Fitted keeping its proportions (covering the front, or once round a revolved shape like a label), then the
      // user's size, place and turn.
      const [ax, ay, aw, ah] = mesh.area;
      const k = (m.kind === 'revolve' ? aw / tex.width : Math.max(aw / tex.width, ah / tex.height)) * (t.scale / 100);
      gl.uniform4f(this.u.uTxFit, ax + (t.x / 100) * aw, ay + (t.y / 100) * ah, tex.width * k, tex.height * k);
      gl.uniform1f(this.u.uTxRot, t.rotate * D2R);
      gl.uniform4f(this.u.uTxOpt, t.blend === 'multiply' ? 1 : 0, t.amount / 100, t.tile ? 1 : 0, m.kind !== 'extrude' ? 0 : t.where === 'faces' ? 1 : t.where === 'sides' ? 2 : 0);
      // Bump height: up to 30 layer pixels between black and white (textures rarely use the whole range).
      gl.uniform1f(this.u.uBump, (t.bump / 100) * 30);
    }
    const F = 4 * STRIDE;
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, F, 0);
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 3, gl.FLOAT, false, F, 12);
    gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 2, gl.FLOAT, false, F, 24);
    gl.enableVertexAttribArray(3); gl.vertexAttribPointer(3, 1, gl.FLOAT, false, F, 32);
    gl.enableVertexAttribArray(4); gl.vertexAttribPointer(4, 2, gl.FLOAT, false, F, 36);
    gl.uniform1i(this.u.uPass, 0);
    gl.drawArrays(gl.TRIANGLES, 0, mesh.count);
    // The faces' soft edges, blended over what's already drawn behind them (without hiding anything else).
    gl.uniform1i(this.u.uPass, 1);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.depthFunc(gl.LEQUAL);
    gl.depthMask(false);
    gl.drawArrays(gl.TRIANGLES, 0, mesh.count);
    gl.depthMask(true);
    gl.disable(gl.BLEND);
    gl.disable(gl.DEPTH_TEST);
    gl.activeTexture(gl.TEXTURE0);
    return { canvas: this.canvas, box };
  }
}

const engine = new ModelGL();
const outCache = new Map<string, { canvas: HTMLCanvasElement; box: Rect }>();

/**
 * The rendered 3D layer (a copy that stays valid) and its box in layer pixels; cached by its settings and the
 * output resolution (a power of two, so zooming reuses it). `depth`: its depth map instead (nearest white, farthest
 * dark grey). `texture` is the image of its texture (m.texture.key), if it has one. Null if WebGL2 isn't available.
 */
export function renderModel(src: HTMLCanvasElement, m: Model3D, key: string, scale: number, depth = false, texture?: HTMLCanvasElement | null): { canvas: HTMLCanvasElement; box: Rect } | null {
  const s = 2 ** Math.ceil(Math.log2(Math.max(0.125, Math.min(4, scale))));
  const ck = `${key}|${src.width}x${src.height}|${JSON.stringify(m)}|${s}|${depth}|${!!texture}`;
  const hit = outCache.get(ck);
  if (hit) return hit;
  const r = engine.render(src, m, key, s, depth, texture);
  if (!r) return null;
  if (outCache.size > 24) outCache.clear();
  const c = document.createElement('canvas');
  c.width = r.canvas.width; c.height = r.canvas.height;
  c.getContext('2d')!.drawImage(r.canvas, 0, 0);
  const out = { canvas: c, box: r.box };
  outCache.set(ck, out);
  return out;
}

/** The 3D layer's box (layer pixels) without rendering it. */
export function modelBox(src: HTMLCanvasElement, m: Model3D, key: string): Rect {
  return boundsOf(src.width, src.height, m, meshFor(src, m, key));
}
