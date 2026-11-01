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
  light: {
    az: number; el: number; strength: number; ambient: number;
    /**
     * 'sun' (or unset): from far away, the same everywhere. 'lamp': from a point `dist` away (a multiple of the
     * object's size, from its middle), brighter up close, its shadows spreading out.
     */
    kind?: 'sun' | 'lamp'; dist?: number;
    /** Its colour (white if unset). */
    color?: string;
    /** It turns with the object, so the same side stays lit; otherwise it stays put in the picture as it turns. */
    follow?: boolean;
  };
  /** Shadows: parts of the object on each other, and the whole object on what's behind it. */
  shadow?: ModelShadow;
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

/**
 * A 3D layer's shadows. Behind the object is a wall facing the viewer, `gap` behind its back (% of its size), where
 * its shadow falls; the shadow is part of the layer, so it darkens the layers below. `opacity` how dark (0-100),
 * `soft` how blurred their edges are (0 = sharp).
 */
export interface ModelShadow { on: boolean; opacity: number; soft: number; gap: number }

export const defaultShadow = (): ModelShadow => ({ on: true, opacity: 60, soft: 35, gap: 15 });

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
 * samples). Sample (i, j) is at layer pixel (x0 + i·cx, y0 + j·cy); the grid reaches a sample past the picture.
 */
interface Grid { gw: number; gh: number; cx: number; cy: number; x0: number; y0: number; a: Float32Array; inside: Uint8Array; d: Float32Array; maxD: number }
const gridCache = new Map<string, Grid>();

function silhouette(src: HTMLCanvasElement, key: string): Grid {
  const ck = `${key}|${src.width}x${src.height}`;
  const hit = gridCache.get(ck);
  if (hit) return hit;
  if (gridCache.size > 16) gridCache.clear();
  const W = src.width, H = src.height;
  // About every 2.5 pixels, between 64 and 320 samples along the long side.
  const cell = Math.max(W, H) / Math.min(320, Math.max(64, Math.max(W, H) / 2.5));
  // Plus an empty sample all round: a shape touching the picture's border still has outside samples beyond it.
  const nw = Math.max(2, Math.round(W / cell) + 1), nh = Math.max(2, Math.round(H / cell) + 1);
  const gw = nw + 2, gh = nh + 2;
  const c = document.createElement('canvas'); c.width = gw; c.height = gh;
  const x = c.getContext('2d', { willReadFrequently: true })!;
  // Sample (i, j) sits at layer pixel ((i - 1)·cx, (j - 1)·cy), so its coverage is measured there: pixel centres
  // line up with the grid's points (the picture spanning nw - 1 by nh - 1 pixels, a sample and a half in).
  x.drawImage(src, 1.5, 1.5, nw - 1, nh - 1);
  const px = x.getImageData(0, 0, gw, gh).data;
  const a = new Float32Array(gw * gh), inside = new Uint8Array(gw * gh);
  for (let i = 0; i < gw * gh; i++) { a[i] = px[i * 4 + 3] / 255; inside[i] = px[i * 4 + 3] >= 128 ? 1 : 0; }
  const d = edt(inside, gw, gh);
  let maxD = 0;
  for (let i = 0; i < d.length; i++) if (d[i] > maxD) maxD = d[i];
  const cx = W / (nw - 1), cy = H / (nh - 1);
  const g = { gw, gh, cx, cy, x0: -cx, y0: -cy, a, inside, d, maxD };
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
 * A mesh: vertices [x, y, z, nx, ny, nz, u, v, kind, tx, ty] in layer pixels (z toward the viewer), shared by the
 * triangles in `index` (three vertex numbers each, `count` in all), and its extent. `kind` 1 = always drawn (sides,
 * revolved surfaces); 0 and 2 = the front and back faces, cut out by the picture's own edges. (tx, ty) is where a
 * texture goes, in pixels across the surface: the faces' own position, the distance around the outline and back from
 * the front on Extrude's sides, around and down on a revolved surface. `area` is the region a texture is fitted to:
 * its centre and size in those pixels.
 */
interface Mesh {
  data: Float32Array; index: Uint32Array; count: number; lo: [number, number, number]; hi: [number, number, number]; area: [number, number, number, number];
  /** Inflate's rounded profile, for shading by it near the edge: its height and how far in it reaches (pixels). */
  profile?: [number, number];
  /**
   * A plainer version for shadows, which are softened and only need its shape (Inflate: without the finer triangles
   * beside the edge, its facings unset). Without it, the mesh itself.
   */
  lite?: { data: Float32Array; index: Uint32Array; count: number };
}
/**
 * 11 numbers per vertex as above, then 5 for Inflate's edge: the distance to the picture's edge (pixels), the
 * direction straight in from it, how much the shader should shade by the exact rounded profile there (0-1, signed by
 * which face: + front, - back), and how far in that part of the shape reaches (pixels; see localRadius). Zero
 * elsewhere.
 */
const STRIDE = 16;
type EdgeInfo = readonly [number, number, number, number, number];
const meshCache = new Map<string, Mesh>();

/**
 * Collects a mesh: each vertex once, and triangles naming them (neighbouring triangles share their corners instead of
 * repeating them, so a mesh builds several times faster and the GPU works out each corner once).
 */
class MeshBuilder {
  private v = new Float32Array(STRIDE * 8192);
  private nv = 0;
  private ix = new Uint32Array(8192 * 3);
  private ni = 0;

  vert(x: number, y: number, z: number, nx: number, ny: number, nz: number, u: number, v: number, kind: number, tx: number, ty: number, edge?: EdgeInfo | null): number {
    if ((this.nv + 1) * STRIDE > this.v.length) { const n = new Float32Array(this.v.length * 2); n.set(this.v); this.v = n; }
    const a = this.v, o = this.nv * STRIDE;
    a[o] = x; a[o + 1] = y; a[o + 2] = z; a[o + 3] = nx; a[o + 4] = ny; a[o + 5] = nz;
    a[o + 6] = u; a[o + 7] = v; a[o + 8] = kind; a[o + 9] = tx; a[o + 10] = ty;
    for (let f = 0; f < 5; f++) a[o + 11 + f] = edge?.[f] ?? 0;
    return this.nv++;
  }

  /** How many vertices so far (the next one's number). */
  get count() { return this.nv; }

  /** The vertices' numbers so far (STRIDE each; replaced when it grows, so not to be kept). */
  get data() { return this.v; }

  /** A new vertex blended from existing ones p, q and r (-1 for none) by the weights. */
  blend(p: number, q: number, r: number, wp: number, wq: number, wr: number): number {
    if ((this.nv + 1) * STRIDE > this.v.length) { const n = new Float32Array(this.v.length * 2); n.set(this.v); this.v = n; }
    const a = this.v, o = this.nv * STRIDE, P = p * STRIDE, Q = q * STRIDE, R = r * STRIDE;
    if (r < 0) for (let f = 0; f < STRIDE; f++) a[o + f] = a[P + f] * wp + a[Q + f] * wq;
    else for (let f = 0; f < STRIDE; f++) a[o + f] = a[P + f] * wp + a[Q + f] * wq + a[R + f] * wr;
    const l = Math.sqrt(a[o + 3] * a[o + 3] + a[o + 4] * a[o + 4] + a[o + 5] * a[o + 5]) || 1;
    a[o + 3] /= l; a[o + 4] /= l; a[o + 5] /= l;
    return this.nv++;
  }

  tri(a: number, b: number, c: number) {
    if (this.ni + 3 > this.ix.length) { const n = new Uint32Array(this.ix.length * 2); n.set(this.ix); this.ix = n; }
    this.ix[this.ni++] = a; this.ix[this.ni++] = b; this.ix[this.ni++] = c;
  }

  /** Marks where a part of the mesh starts, for normalsFromFaces. */
  get mark() { return { v: this.nv, i: this.ni }; }

  /** See faceNormals: for the vertices and triangles made since `from`. */
  normalsFromFaces(from: { v: number; i: number }, side: 1 | -1, keep: (v: number) => boolean) {
    faceNormals(this.v, this.ix, from.v, this.nv, from.i, this.ni, side, keep);
  }

  /** The vertices and triangles so far. */
  get parts() { return { data: this.v.slice(0, this.nv * STRIDE), index: this.ix.slice(0, this.ni) }; }

  finish(area: [number, number, number, number]): Mesh {
    const { data, index } = this.parts;
    return meshOf(data, index, area);
  }
}

/**
 * Gives vertices v0 to v1 the average facing of triangles i0 to i1 around them (each weighted by its area), turned to
 * face `side` (+1 toward the viewer, -1 away). Vertices for which `keep` says so are left as they are.
 */
function faceNormals(a: Float32Array, ix: Uint32Array, v0: number, v1: number, i0: number, i1: number, side: number, keep: (v: number) => boolean) {
  const n = v1 - v0, acc = new Float32Array(n * 3);
  for (let t = i0; t < i1; t += 3) {
    const p0 = ix[t] * STRIDE, p1 = ix[t + 1] * STRIDE, p2 = ix[t + 2] * STRIDE;
    const ux = a[p1] - a[p0], uy = a[p1 + 1] - a[p0 + 1], uz = a[p1 + 2] - a[p0 + 2];
    const vx = a[p2] - a[p0], vy = a[p2 + 1] - a[p0 + 1], vz = a[p2 + 2] - a[p0 + 2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    if (nz * side < 0) { nx = -nx; ny = -ny; nz = -nz; }
    for (let c = 0; c < 3; c++) {
      const k = (ix[t + c] - v0) * 3;
      if (k < 0 || k >= acc.length) continue;
      acc[k] += nx; acc[k + 1] += ny; acc[k + 2] += nz;
    }
  }
  for (let i = 0; i < n; i++) {
    if (keep(v0 + i)) continue;
    const k = i * 3, l = Math.sqrt(acc[k] * acc[k] + acc[k + 1] * acc[k + 1] + acc[k + 2] * acc[k + 2]);
    if (!l) continue;
    const o = (v0 + i) * STRIDE;
    a[o + 3] = acc[k] / l; a[o + 4] = acc[k + 1] / l; a[o + 5] = acc[k + 2] / l;
  }
}

/** A mesh from its vertices and triangles, with its extent. */
function meshOf(data: Float32Array, index: Uint32Array, area: [number, number, number, number]): Mesh {
  const lo: [number, number, number] = [Infinity, Infinity, Infinity], hi: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  const nv = data.length / STRIDE;
  for (let i = 0; i < nv; i++) {
    const o = i * STRIDE;
    for (let k = 0; k < 3; k++) { const c = data[o + k]; if (c < lo[k]) lo[k] = c; if (c > hi[k]) hi[k] = c; }
  }
  if (!nv) { lo.fill(0); hi.fill(1); }
  return { data, index, count: index.length, lo, hi, area };
}

/**
 * Where each vertex of Inflate's surfaces comes from, so that when only the depth or roundness changes, the heights
 * and facings are worked out again on the same triangles instead of building them anew. Per vertex: what it is (see
 * the constants), its grid sample or the earlier vertices it's blended from and their weights, its distance in from
 * the edge and how far in its part of the shape reaches (samples), which face it's on, and whether it keeps its
 * facing; and per face, its vertices and triangles.
 */
class Recipe {
  static readonly SAMPLE = 0; static readonly RIM = 1; static readonly CURVED = 2; static readonly STRAIGHT = 3;
  n = 0;
  what = new Uint8Array(4096); from = new Int32Array(4096 * 3); w = new Float32Array(4096 * 3);
  d = new Float32Array(4096); r = new Float32Array(4096); side = new Int8Array(4096); keep = new Uint8Array(4096);
  faces: { v0: number; v1: number; i0: number; i1: number; side: number }[] = [];

  /** Records vertex number `v` (always the next one). */
  add(v: number, what: number, a: number, b: number, c: number, wa: number, wb: number, wc: number, d: number, r: number, side: number) {
    if (v >= this.what.length) {
      const grow = <T extends Uint8Array | Int8Array | Int32Array | Float32Array>(x: T): T => { const y = new (x.constructor as any)(x.length * 2) as T; y.set(x); return y; };
      this.what = grow(this.what); this.from = grow(this.from); this.w = grow(this.w);
      this.d = grow(this.d); this.r = grow(this.r); this.side = grow(this.side); this.keep = grow(this.keep);
    }
    this.what[v] = what; this.d[v] = d; this.r[v] = r; this.side[v] = side;
    this.from[v * 3] = a; this.from[v * 3 + 1] = b; this.from[v * 3 + 2] = c;
    this.w[v * 3] = wa; this.w[v * 3 + 1] = wb; this.w[v * 3 + 2] = wc;
    this.n = v + 1;
  }
}

/**
 * The picture's traced edge (contours: smooth and accurate between pixels) as short segments, each end with the
 * outward direction there (averaged over the neighbouring segments, so it turns smoothly), bucketed on a grid so the
 * nearest point of the edge to anywhere is quick to find. Per segment: ax, ay, bx, by, then the two directions; and
 * in `bend`, how sharply the edge bends there (1 / radius, layer pixels; + outward, - inward).
 */
interface Edge { seg: Float32Array; bend: Float32Array; size: number; buckets: Map<number, number[]> }

function edgeOf(loops: Pt[][], size: number): Edge {
  const segs: number[] = [], bends: number[] = [];
  for (const raw of loops) {
    const n = raw.length;
    if (n < 3) continue;
    const pts = evenOut(raw);
    const sn = pts.map((p, i) => {
      const q = pts[(i + 1) % n], dx = q.x - p.x, dy = q.y - p.y, l = Math.hypot(dx, dy) || 1;
      return [dy / l, -dx / l];
    });
    // A point's direction: its neighbouring segments' (two each way) averaged, which evens out pixel steps.
    const pn = pts.map((_, i) => {
      let x = 0, y = 0;
      for (let k = -2; k <= 1; k++) { const s = sn[(i + k + n) % n]; x += s[0]; y += s[1]; }
      const l = Math.hypot(x, y) || 1;
      return [x / l, y / l];
    });
    // How sharply it bends at each point (1 / the radius of the circle through it and the points two either side;
    // + where it bulges outward, - where it dents in): from how far the middle of that chord is from the point.
    const kp = pts.map((p, i) => {
      const a = pts[(i - 2 + n) % n], b = pts[(i + 2) % n], cx = (a.x + b.x) / 2 - p.x, cy = (a.y + b.y) / 2 - p.y;
      const half2 = ((b.x - a.x) ** 2 + (b.y - a.y) ** 2) / 4;
      return half2 > 1e-6 ? (2 * -(cx * pn[i][0] + cy * pn[i][1])) / half2 : 0;
    });
    for (let i = 0; i < n; i++) {
      const p = pts[i], q = pts[(i + 1) % n], a = pn[i], b = pn[(i + 1) % n];
      segs.push(p.x, p.y, q.x, q.y, a[0], a[1], b[0], b[1]);
      bends.push((kp[i] + kp[(i + 1) % n]) / 2);
    }
  }
  const seg = new Float32Array(segs), bend = new Float32Array(bends), buckets = new Map<number, number[]>();
  const key = (i: number, j: number) => j * 100003 + i;
  for (let s = 0; s < seg.length / 8; s++) {
    const o = s * 8;
    const i0 = Math.floor(Math.min(seg[o], seg[o + 2]) / size), i1 = Math.floor(Math.max(seg[o], seg[o + 2]) / size);
    const j0 = Math.floor(Math.min(seg[o + 1], seg[o + 3]) / size), j1 = Math.floor(Math.max(seg[o + 1], seg[o + 3]) / size);
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const k = key(i, j);
      const b = buckets.get(k);
      if (b) b.push(s); else buckets.set(k, [s]);
    }
  }
  return { seg, bend, size, buckets };
}

/**
 * A traced loop with its small wobbles evened out. Where an anti-aliased edge crosses half coverage is only roughly
 * where the true edge is (off by up to a tenth of a pixel or so, differently from one pixel to the next), and right
 * beside the edge Inflate's steep rounding magnifies that into streaks. Each point is averaged with its neighbours
 * (twice, two each way), but not across a corner, which stays sharp.
 */
function evenOut(pts: Pt[]): Pt[] {
  const n = pts.length;
  // A corner: the outline turns by more than about 35° from two points before to two after.
  const corner = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const a = pts[(i - 2 + n) % n], b = pts[i], c = pts[(i + 2) % n];
    const ux = b.x - a.x, uy = b.y - a.y, vx = c.x - b.x, vy = c.y - b.y;
    const l = Math.hypot(ux, uy) * Math.hypot(vx, vy);
    if (l && (ux * vx + uy * vy) / l < 0.82) corner[i] = 1;
  }
  const W = [6, 4, 1];
  let cur = pts;
  for (let pass = 0; pass < 2; pass++) {
    const next = cur.map((p, i) => {
      if (corner[i]) return p;
      let x = p.x * W[0], y = p.y * W[0], sum = W[0];
      for (const dir of [1, -1]) for (let k = 1; k <= 2; k++) {
        const q = (i + dir * k + n) % n;
        x += cur[q].x * W[k]; y += cur[q].y * W[k]; sum += W[k];
        if (corner[q]) break;
      }
      return { x: x / sum, y: y / sum };
    });
    cur = next;
  }
  return cur;
}

/** A point of the edge: how far from where it was looked for, where, the outward direction there, and its segment. */
interface Near { d: number; px: number; py: number; nx: number; ny: number; s: number }

/** How far (x, y) is from segment `s` of the edge. */
function segDist(e: Edge, s: number, x: number, y: number): number {
  const o = s * 8, ax = e.seg[o], ay = e.seg[o + 1], dx = e.seg[o + 2] - ax, dy = e.seg[o + 3] - ay;
  const t = Math.min(1, Math.max(0, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy || 1)));
  return Math.hypot(x - ax - dx * t, y - ay - dy * t);
}

/** The nearest point of segment `s` of the edge to (x, y). */
function onSeg(e: Edge, s: number, x: number, y: number): Near {
  const o = s * 8, ax = e.seg[o], ay = e.seg[o + 1], dx = e.seg[o + 2] - ax, dy = e.seg[o + 3] - ay;
  const t = Math.min(1, Math.max(0, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy || 1)));
  const px = ax + dx * t, py = ay + dy * t;
  const nx = e.seg[o + 4] + (e.seg[o + 6] - e.seg[o + 4]) * t, ny = e.seg[o + 5] + (e.seg[o + 7] - e.seg[o + 5]) * t, l = Math.hypot(nx, ny) || 1;
  return { d: Math.hypot(x - px, y - py), px, py, nx: nx / l, ny: ny / l, s };
}

/** The nearest point of the edge to (x, y) within `maxR`. */
function nearestEdge(e: Edge, x: number, y: number, maxR: number): Near | null {
  const r = Math.ceil(maxR / e.size), ci = Math.floor(x / e.size), cj = Math.floor(y / e.size);
  let best = maxR, near = -1;
  for (let j = cj - r; j <= cj + r; j++) for (let i = ci - r; i <= ci + r; i++) {
    const b = e.buckets.get(j * 100003 + i);
    if (!b) continue;
    for (const s of b) {
      const d = segDist(e, s, x, y);
      if (d < best) { best = d; near = s; }
    }
  }
  return near < 0 ? null : onSeg(e, near, x, y);
}

/**
 * The silhouette's rim on the grid: each outside sample next to the inside, moved onto the picture's edge, with the
 * outward direction there. Front and back meet on it, closing the shape. With the traced `edge`, a rim point goes to
 * the nearest point of it (exact, and smooth from one point to the next); otherwise to where the grid's coverage
 * crosses half.
 */
interface Rim { on: Uint8Array; pos: Float32Array; nrm: Float32Array }

function rimOf(g: Grid, edge?: Edge): Rim {
  const { gw, gh, a } = g;
  const on = new Uint8Array(gw * gh), pos = new Float32Array(gw * gh * 2), nrm = new Float32Array(gw * gh * 2);
  const A = (i: number, j: number) => a[Math.min(gh - 1, Math.max(0, j)) * gw + Math.min(gw - 1, Math.max(0, i))];
  for (let j = 0; j < gh; j++) for (let i = 0; i < gw; i++) {
    const k = j * gw + i;
    if (g.inside[k]) continue;
    // Only samples right beside the inside (left, right, above, below): one that only touches it corner to corner is
    // too far out to move onto the edge, and would poke out as a spike. Its cells use just their inner triangle.
    let sx = 0, sy = 0, n = 0;
    for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const ii = i + di, jj = j + dj;
      if (ii >= 0 && jj >= 0 && ii < gw && jj < gh && g.inside[jj * gw + ii]) { sx += di; sy += dj; n++; }
    }
    if (!n) continue;
    // Coverage rises toward the inside; follow it to where it reaches half (at most a sample in).
    const gx = (A(i + 1, j) - A(i - 1, j)) / 2, gy = (A(i, j + 1) - A(i, j - 1)) / 2, len = Math.hypot(gx, gy);
    let ux: number, uy: number, t: number;
    if (len > 0.05 && gx * sx + gy * sy >= 0) { ux = gx / len; uy = gy / len; t = Math.min(0.95, Math.max(0, (0.5 - a[k]) / len)); }
    else if (sx || sy) { const l = Math.hypot(sx, sy); ux = sx / l; uy = sy / l; t = 0; }
    // (Inside on opposite sides, a one-sample gap: no way is "in", so any will do.)
    else { ux = 1; uy = 0; t = 0; }
    on[k] = 1;
    pos[k * 2] = g.x0 + (i + ux * t) * g.cx; pos[k * 2 + 1] = g.y0 + (j + uy * t) * g.cy;
    nrm[k * 2] = -ux; nrm[k * 2 + 1] = -uy;
    const q = edge && nearestEdge(edge, pos[k * 2], pos[k * 2 + 1], 1.5 * Math.max(g.cx, g.cy));
    if (q) { pos[k * 2] = q.px; pos[k * 2 + 1] = q.py; nrm[k * 2] = q.nx; nrm[k * 2 + 1] = q.ny; }
  }
  return { on, pos, nrm };
}

/**
 * Where a height field curves too sharply for the grid: each sample's distance in from the edge (`d`, in samples) and
 * how far in its part of the shape reaches (`r`); triangles with a corner nearer than `cut` are split `n` by `n`. A
 * new point between corners on opposite sides of a stroke's middle (going in opposite ways) gets its distance from
 * `exact` (at a layer pixel) instead: in between, the distance doesn't run straight from one corner to the other.
 */
interface Refine { d: (k: number) => number; r: (k: number) => number; cut: number; n: number; exact: (x: number, y: number) => number }

/**
 * Front and back surfaces of a height field over the silhouette (`h` per grid sample; the back mirrors it). `back`
 * is the back face's kind: 2 when sides hide its edge, 0 to give it soft edges like the front. With a `rim`, the
 * surfaces end on it (only triangles inside it), meeting there to close the shape; otherwise they're cut out by the
 * picture's edges. With `refine`, triangles where the surface curves too sharply for the grid are split finer: their
 * new points only get their heights from the `recipe` (see raise), where each vertex's origin is noted.
 */
function heightSurfaces(g: Grid, h: Float32Array, W: number, H: number, out: MeshBuilder, back: 0 | 2, rim?: Rim, edgeAt?: (k: number) => EdgeInfo | null, refine?: Refine, recipe?: Recipe) {
  const { gw, gh, cx, cy } = g;
  const at = (i: number, j: number) => h[Math.min(gh - 1, Math.max(0, j)) * gw + Math.min(gw - 1, Math.max(0, i))];
  const ins = (i: number, j: number) => i >= 0 && j >= 0 && i < gw && j < gh && g.inside[j * gw + i] === 1;
  const used = (i: number, j: number) => ins(i, j) || !!rim?.on[j * gw + i];
  // Each grid sample's vertex on this side, made the first time a triangle needs it.
  const made = new Int32Array(gw * gh);
  // The upright rim keeps its facing (a mark per vertex).
  let keep = new Uint8Array(1 << 14);
  const keepAdd = (v: number) => {
    if (v >= keep.length) { const n = new Uint8Array(Math.max(v + 1, keep.length * 2)); n.set(keep); keep = n; }
    keep[v] = 1;
    if (recipe) recipe.keep[v] = 1;
  };
  // A sample's vertex (a is its sample) or one blended from vertices a, b and c (-1 for none), into the recipe.
  const note = (v: number, what: number, a: number, b: number, c: number, wa: number, wb: number, wc: number) => {
    if (!recipe) return;
    const R = recipe, sample = what === Recipe.SAMPLE || what === Recipe.RIM;
    let d = sample ? refine?.d(a) ?? 0 : wa * R.d[a] + wb * R.d[b] + (c >= 0 ? wc * R.d[c] : 0);
    if (!sample && refine) {
      // Corners going in opposite ways (directions in, see STRIDE): measure this point's distance itself, and give it
      // to the shader too.
      const D = out.data, way = (p: number, q: number) => D[p * STRIDE + 12] * D[q * STRIDE + 12] + D[p * STRIDE + 13] * D[q * STRIDE + 13];
      if (way(a, b) < 0 || (c >= 0 && (way(a, c) < 0 || way(b, c) < 0))) {
        const o = v * STRIDE;
        d = refine.exact(D[o], D[o + 1]);
        D[o + 11] = d * (cx + cy) / 2;
      }
    }
    const r = sample ? refine?.r(a) ?? 0 : wa * R.r[a] + wb * R.r[b] + (c >= 0 ? wc * R.r[c] : 0);
    R.add(v, what, a, b, c, wa, wb, wc, d, r, side);
  };
  let side: 1 | -1 = 1;
  // The edge numbers for the shader (see STRIDE), with the weight signed by the face.
  const edgeOf = (k: number): EdgeInfo | null => { const e = edgeAt?.(k); return e ? [e[0], e[1], e[2], e[3] * side, e[4]] : null; };
  const vert = (i: number, j: number) => {
    const k = j * gw + i;
    if (made[k] >= 0) return made[k];
    const kind = side > 0 ? 0 : back;
    if (rim?.on[k]) {
      // On the rim: upright, facing outward.
      const x = rim.pos[k * 2], y = rim.pos[k * 2 + 1];
      made[k] = out.vert(x, y, 0, rim.nrm[k * 2], rim.nrm[k * 2 + 1], 0, x / W, y / H, kind, x, y, edgeOf(k));
      note(made[k], Recipe.RIM, k, -1, -1, 0, 0, 0);
      keepAdd(made[k]);
      return made[k];
    }
    // Outward: both surfaces slope away from the middle; only the facing (z) flips for the back.
    const dx = (at(i + 1, j) - at(i - 1, j)) / (2 * cx), dy = (at(i, j + 1) - at(i, j - 1)) / (2 * cy);
    const l = Math.hypot(dx, dy, 1);
    const x = g.x0 + i * cx, y = g.y0 + j * cy;
    made[k] = out.vert(x, y, at(i, j) * side, -dx / l, -dy / l, side / l, x / W, y / H, kind, x, y, edgeOf(k));
    note(made[k], Recipe.SAMPLE, k, -1, -1, 0, 0, 0);
    return made[k];
  };
  const vk = (k: number) => vert(k % gw, (k - (k % gw)) / gw);
  // Refining: a triangle with a corner in the steep band is split n by n (its new points are later raised onto the
  // curve where straight lines between its corners would cut under it). The points along an edge depend only on its
  // two ends, so the triangles either side of it split it alike and share them (no gaps); an edge with neither end in
  // the band stays straight, matching an unsplit neighbour.
  // Each split edge's new points are made together, in order from its lower sample: the first one's number, by that
  // sample and which way the edge runs from there (one of four).
  const splits = refine ? new Int32Array(gw * gh * 4) : null;
  const runs = [1, gw, gw - 1, gw + 1];
  const split = (ka: number, kb: number, r: Refine) => {
    const lo = Math.min(ka, kb), hi = Math.max(ka, kb), key = lo * 4 + runs.indexOf(hi - lo);
    if (splits![key] >= 0) return splits![key];
    const da = r.d(lo), db = r.d(hi), va = vk(lo), vb = vk(hi);
    // (Upright along the rim, not across a stroke from one side to the other.)
    const bent = Math.min(da, db) < r.cut, upright = !!rim?.on[lo] && !!rim.on[hi]
      && rim.nrm[lo * 2] * rim.nrm[hi * 2] + rim.nrm[lo * 2 + 1] * rim.nrm[hi * 2 + 1] > 0;
    const first = out.count;
    for (let s = 1; s < r.n; s++) {
      const f = s / r.n, v = out.blend(va, vb, -1, 1 - f, f, 0);
      note(v, bent ? Recipe.CURVED : Recipe.STRAIGHT, va, vb, -1, 1 - f, f, 0);
      if (upright) keepAdd(v);
    }
    return (splits![key] = first);
  };
  const pt = new Int32Array(((refine?.n ?? 1) + 1) ** 2);
  const face = (ka: number, kb: number, kc: number) => {
    const r = refine;
    if (!r) { out.tri(vk(ka), vk(kb), vk(kc)); return; }
    let da = r.d(ka), db = r.d(kb), dc = r.d(kc);
    const cut = r.cut;
    if (da >= cut && db >= cut && dc >= cut) { out.tri(vk(ka), vk(kb), vk(kc)); return; }
    // At most one edge has neither end in the band (its neighbour isn't split): turn the corners round so that's b-c.
    if (da >= cut && db >= cut) { const k = ka, d = da; ka = kc; da = dc; kc = kb; dc = db; kb = k; db = d; }
    else if (dc >= cut && da >= cut) { const k = ka, d = da; ka = kb; da = db; kb = kc; db = dc; kc = k; dc = d; }
    const n = r.n, N1 = n + 1, straight = db >= cut && dc >= cut;
    const a = vk(ka), b = vk(kb), c = vk(kc);
    const ab = split(ka, kb, r), ac = split(ka, kc, r), bc = straight ? 0 : split(kb, kc, r);
    // Point (i, j) is i steps from a toward b and j toward c.
    for (let j = 0; j <= n; j++) for (let i = 0; i + j <= n; i++) {
      let v: number;
      if (i === 0 && j === 0) v = a;
      else if (i === n) v = b;
      else if (j === n) v = c;
      else if (j === 0) v = ab + (ka < kb ? i : n - i) - 1;
      else if (i === 0) v = ac + (ka < kc ? j : n - j) - 1;
      else if (i + j === n) { if (straight) continue; v = bc + (kb < kc ? j : n - j) - 1; }
      else {
        const wb = i / n, wc = j / n, wa = 1 - wb - wc;
        v = out.blend(a, b, c, wa, wb, wc);
        note(v, Recipe.CURVED, a, b, c, wa, wb, wc);
      }
      pt[j * N1 + i] = v;
    }
    // With b-c left straight, its last row of points fans out to b and c instead (no points on b-c to leave a crack).
    const rows = straight ? n - 1 : n;
    for (let j = 0; j < rows; j++) for (let i = 0; i + j < rows; i++) {
      const p = j * N1 + i;
      out.tri(pt[p], pt[p + 1], pt[p + N1]);
      if (i + j < rows - 1) out.tri(pt[p + 1], pt[p + N1 + 1], pt[p + N1]);
    }
    if (straight) {
      // Row n - 1, from its end on a-b (t = 0) to its end on a-c.
      const m = (n - 1) >> 1, R = (t: number) => pt[t * N1 + n - 1 - t];
      for (let t = 0; t < m; t++) out.tri(R(t), b, R(t + 1));
      out.tri(R(m), b, c);
      for (let t = m; t < n - 1; t++) out.tri(R(t), c, R(t + 1));
    }
  };
  for (const s of [1, -1] as const) {
    side = s;
    made.fill(-1);
    splits?.fill(-1);
    const start = out.mark;
    for (let j = 0; j < gh - 1; j++) for (let i = 0; i < gw - 1; i++) {
      if (rim) {
        // Each half of the cell whose corners are all inside or on the rim.
        const A = used(i, j), B = used(i + 1, j), C = used(i, j + 1), D = used(i + 1, j + 1);
        if (!(A || B || C || D)) continue;
        const ka = j * gw + i, kb = ka + 1, kc = ka + gw, kd = kc + 1;
        // Split the cell along whichever diagonal keeps the most of it.
        if (A && B && C && D) { face(ka, kb, kc); face(kb, kd, kc); }
        else if (A && B && C) face(ka, kb, kc);
        else if (B && D && C) face(kb, kd, kc);
        else if (A && B && D) face(ka, kb, kd);
        else if (A && D && C) face(ka, kd, kc);
        continue;
      }
      // Only cells at or next to the silhouette (the rest is cut away anyway).
      let near = false;
      for (let dj = -1; dj <= 2 && !near; dj++) for (let di = -1; di <= 2 && !near; di++) near = ins(i + di, j + dj);
      if (!near) continue;
      const b = vert(i + 1, j), c = vert(i, j + 1);
      out.tri(vert(i, j), b, c);
      out.tri(b, vert(i + 1, j + 1), c);
    }
    // With a rim, its samples have moved onto the picture's edge, so a slope worked out across the grid's even
    // spacing is off beside them (by a different amount all along the edge, which shows as streaks when turned).
    // The triangles as built say which way the surface really faces there.
    // (With a recipe, that's done once the heights are known.)
    if (rim && !recipe) out.normalsFromFaces(start, s, (v) => v < keep.length && keep[v] === 1);
    recipe?.faces.push({ v0: start.v, v1: out.count, i0: start.i, i1: out.mark.i, side: s });
  }
}

/**
 * The parts of a shape that only depend on the picture, kept for as long as its silhouette is: while a slider
 * changes the depth, roundness or bevel, the mesh is rebuilt from these instead of from scratch.
 */
const shapeParts = new WeakMap<Grid, {
  rim?: Rim; outline?: Edge; edge?: { dist: Float32Array; dir: Float32Array; crease: Float32Array; reach: Float32Array }; contours?: Pt[][];
  surface?: { data: Float32Array; index: Uint32Array; recipe: Recipe };
  /** The plainer surfaces for shadows (see Mesh.lite), the same way. */
  lite?: { data: Float32Array; index: Uint32Array; recipe: Recipe };
}>();
const partsOf = (g: Grid) => { let p = shapeParts.get(g); if (!p) shapeParts.set(g, (p = {})); return p; };

/** Inflate: rounded on both sides, steep at the edge and levelling off toward the middle. */
function inflateMesh(g: Grid, src: HTMLCanvasElement, m: Model3D, W: number, H: number): Mesh {
  const radius = Math.max(1, g.maxD - 0.5), rr = radius * (0.15 + 0.85 * (m.round / 100));
  const depth = (m.depth / 100) * radius * Math.min(g.cx, g.cy);
  const parts = partsOf(g);
  // The picture's edge traced in detail (shared with Extrude's sides): the rim sits on it, and distances are measured
  // to it.
  const cell = (g.cx + g.cy) / 2;
  if (!parts.rim) {
    const edge = (parts.outline = edgeOf((parts.contours ??= contours(src, shapeBox(g, W, H))), Math.max(4, cell * 2)));
    parts.rim = rimOf(g, edge);
    const { dist, dir, bend } = edgeDistance(g, edge);
    // Creases to smooth are where the sides meet at an angle (at a corner); where they meet head on, the rounding
    // itself levels off there.
    const { reach, head } = localRadius(g, dist, dir, bend), crease = creases(g, dist, dir);
    for (let k = 0; k < crease.length; k++) crease[k] *= 1 - head[k];
    parts.edge = { dist: softenCreases(g, dist, crease), dir, crease, reach };
  }
  const rim = parts.rim, { dist, dir, crease, reach } = parts.edge!;
  // The rounded profile: its height at a distance in from the edge, in a part of the shape that reaches `r` in
  // (samples). A quarter of an ellipse, `rr` across, levelling off to the full depth. A narrower band (a thin stroke,
  // a round end) rises as high as that would in its middle, but in a quarter ellipse of its own width, level there, so
  // its two sides meet smoothly rather than in a ridge.
  const lift = (d: number, r: number) => {
    const e = Math.max(1e-3, Math.min(r, rr)), q = e / rr, v = Math.min(1, d / e);
    return depth * Math.sqrt(q * (2 - q)) * Math.sqrt(v * (2 - v));
  };
  const h = new Float32Array(g.d.length);
  for (let k = 0; k < h.length; k++) if (g.inside[k]) h[k] = lift(dist[k], reach[k]);
  // Soften the creases left where the distances from the sides of a corner meet into a smooth crown. Only there:
  // averaging the steep rounding beside the edge would bend it a little differently in each row of samples, which
  // shows as streaks when it's turned.
  const soft = smooth(g, h, 3, 1.2);
  for (let k = 0; k < h.length; k++) if (crease[k]) h[k] += (soft[k] - h[k]) * crease[k];
  // Next to the edge the surface rises almost straight up, faster than even finer triangles can follow. There, the
  // facing comes from the rounded profile itself and the smooth direction in from the traced edge, so it shades like
  // the smooth shape it stands for. That's done for every pixel in the shader, from each vertex's distance and
  // direction to the edge, which blend smoothly across a triangle. Fully right beside the edge, fading out three
  // samples in (a hard switch would itself fall a little differently in each row), and not at a crease (smoothed).
  const edgeAt = (k: number): EdgeInfo | null => {
    // On the rim: right on the edge, straight in is against its outward direction.
    if (rim.on[k]) return [0, -rim.nrm[k * 2], -rim.nrm[k * 2 + 1], 1, reach[k] * cell];
    if (!g.inside[k]) return null;
    const t = Math.min(1, Math.max(0, (dist[k] - 1.2) / 1.8));
    const w = dist[k] >= 4 || (!dir[k * 2] && !dir[k * 2 + 1]) ? 0 : (1 - t * t * (3 - 2 * t)) * (1 - crease[k]);
    return [dist[k] * cell, dir[k * 2], dir[k * 2 + 1], w, reach[k] * cell];
  };
  // The triangles within two samples of the edge are split three by three, following the rounding (its steepest
  // part) closely: with single triangles, how each row cuts across the curve differs along the edge, which shows as
  // streaks and a lumpy outline when it's turned. They only depend on the picture, so they're made once, noting where
  // each vertex comes from; for each depth and roundness only the heights and facings are worked out.
  if (!parts.surface) {
    const out = new MeshBuilder(), recipe = new Recipe();
    heightSurfaces(g, new Float32Array(g.d.length), W, H, out, 0, rim, edgeAt, { d: (k) => (rim.on[k] ? 0 : dist[k]), r: (k) => reach[k], cut: 2, n: 3, exact: (x, y) => (nearestEdge(parts.outline!, x, y, 6 * cell)?.d ?? 0) / cell }, recipe);
    parts.surface = { ...out.parts, recipe };
    // And for shadows, on the grid alone.
    const lo = new MeshBuilder(), lr = new Recipe();
    heightSurfaces(g, new Float32Array(g.d.length), W, H, lo, 0, rim, undefined, undefined, lr);
    parts.lite = { ...lo.parts, recipe: lr };
  }
  const mesh = raise(parts.surface, h, lift, [W / 2, H / 2, W, H]);
  // The plainer one only needs its heights.
  const L = parts.lite!, ld = L.data.slice(), lr = L.recipe;
  for (let v = 0; v < lr.n; v++) ld[v * STRIDE + 2] = lr.what[v] === Recipe.SAMPLE ? h[lr.from[v * 3]] * lr.side[v] : 0;
  // The rounded profile for the shader: its height and how far in it reaches (pixels).
  return { ...mesh, profile: [depth, rr * cell], lite: { data: ld, index: L.index, count: L.index.length } };
}

/** Inflate's surfaces from their recipe, at heights `h` (per grid sample) with the rounded profile `lift`. */
function raise(base: { data: Float32Array; index: Uint32Array; recipe: Recipe }, h: Float32Array, lift: (d: number, r: number) => number, area: [number, number, number, number]): Mesh {
  const { recipe: r, index } = base, a = base.data.slice(), n = r.n;
  const L = new Float32Array(n);
  for (let v = 0; v < n; v++) L[v] = lift(r.d[v], r.r[v]);
  for (let v = 0; v < n; v++) {
    const o = v * STRIDE, what = r.what[v];
    if (what === Recipe.SAMPLE) { a[o + 2] = h[r.from[v * 3]] * r.side[v]; continue; }
    if (what === Recipe.RIM) { a[o + 2] = 0; continue; }
    // Blended from earlier vertices, and raised onto the curve where straight lines between them cut under it.
    const p = r.from[v * 3], q = r.from[v * 3 + 1], c = r.from[v * 3 + 2], wp = r.w[v * 3], wq = r.w[v * 3 + 1], wc = r.w[v * 3 + 2];
    let z = wp * a[p * STRIDE + 2] + wq * a[q * STRIDE + 2], l = wp * L[p] + wq * L[q];
    if (c >= 0) { z += wc * a[c * STRIDE + 2]; l += wc * L[c]; }
    a[o + 2] = what === Recipe.CURVED ? z + r.side[v] * (L[v] - l) : z;
  }
  for (const f of r.faces) faceNormals(a, index, f.v0, f.v1, f.i0, f.i1, f.side, (v) => r.keep[v] === 1);
  return meshOf(a, index, area);
}

/**
 * How near each sample is to a crease in the distances (0-1): where those from opposite edges meet, in the middle of a
 * stroke, a step straight in from the edge no longer takes you further from it. Spread over a few samples, so what's
 * done there fades in.
 */
function creases(g: Grid, dist: Float32Array, dir: Float32Array): Float32Array {
  const { gw, gh } = g;
  const at = (x: number, y: number) => {
    const i = Math.min(gw - 2, Math.max(0, Math.floor(x))), j = Math.min(gh - 2, Math.max(0, Math.floor(y))), fx = x - i, fy = y - j;
    const d = (ii: number, jj: number) => dist[jj * gw + ii];
    return (d(i, j) * (1 - fx) + d(i + 1, j) * fx) * (1 - fy) + (d(i, j + 1) * (1 - fx) + d(i + 1, j + 1) * fx) * fy;
  };
  const c = new Float32Array(dist.length);
  for (let k = 0; k < c.length; k++) {
    if (!g.inside[k] || (!dir[k * 2] && !dir[k * 2 + 1])) continue;
    const i = k % gw, j = (k - i) / gw;
    if (at(i + dir[k * 2], j + dir[k * 2 + 1]) - dist[k] < 0.6) c[k] = 1;
  }
  const b = boxBlur(c, gw, gh, 1);
  for (let k = 0; k < c.length; k++) c[k] = g.inside[k] ? Math.min(1, b[k] * 3) : 0;
  return c;
}

/**
 * For averaging only over inside samples: 1 / the share of inside samples around each sample, at blur size `r`
 * (see boxBlur), 0 where there are none. Kept per grid and size, since several averages share it.
 */
const insideShares = new WeakMap<Grid, Map<number, Float32Array>>();
function insideShare(g: Grid, r: number): Float32Array {
  let byR = insideShares.get(g);
  if (!byR) insideShares.set(g, (byR = new Map()));
  let w = byR.get(r);
  if (!w) {
    const m = new Float32Array(g.inside.length);
    for (let k = 0; k < m.length; k++) m[k] = g.inside[k];
    w = boxBlur(m, g.gw, g.gh, r);
    for (let k = 0; k < w.length; k++) w[k] = w[k] > 1e-4 ? 1 / w[k] : 0;
    byR.set(r, w);
  }
  return w;
}

/**
 * The distances with the creases at corners (`crease`, 0-1) rounded off, more the further in they are: where a
 * corner's two sides' distances meet, the rounding would otherwise come to a sharp ridge running in from the corner.
 * Each crease sample is averaged with the samples around it, over about 40% of its distance from the edge (a few sizes
 * are made, and the nearest two mixed), leaving the steep part beside the edge as it is.
 */
function softenCreases(g: Grid, dist: Float32Array, crease: Float32Array): Float32Array {
  const { gw, gh } = g, n = dist.length, out = Float32Array.from(dist);
  let far = 0;
  for (let k = 0; k < n; k++) if (crease[k] > 0 && dist[k] > far) far = dist[k];
  if (far < 3) return out;
  // Averages over 1, 2, 4... samples (three box blurs each), of the distances and of the creases (so the rounding fades
  // in as wide as it reaches), counting only inside samples.
  const sizes: number[] = [], bd: Float32Array[] = [], bc: Float32Array[] = [];
  for (let r = 1; r <= Math.max(1, far / 2.5); r *= 2) {
    const w = insideShare(g, r), a = boxBlur(dist, gw, gh, r), c = boxBlur(crease, gw, gh, r);
    for (let k = 0; k < n; k++) { a[k] *= w[k]; c[k] *= w[k]; }
    sizes.push(r); bd.push(a); bc.push(c);
  }
  for (let k = 0; k < n; k++) {
    if (!g.inside[k] || dist[k] < 2) continue;
    const want = Math.log2(Math.max(1, dist[k] / 2.5)), lo = Math.min(sizes.length - 1, Math.floor(want)), hi = Math.min(sizes.length - 1, lo + 1);
    const f = Math.min(1, want - lo);
    // (A crease is a few samples wide, so its share of a wider average is smaller: scaled back up.)
    const c = (bc[lo][k] * sizes[lo] * (1 - f) + bc[hi][k] * sizes[hi] * f);
    if (c <= 0) continue;
    const near = Math.min(1, Math.max(0, (dist[k] - 2) / 2));
    const w = Math.min(1, c * 2) * near * near * (3 - 2 * near);
    out[k] = dist[k] + ((bd[lo][k] * (1 - f) + bd[hi][k] * f) - dist[k]) * w;
  }
  return out;
}

/**
 * Where the shape is a band of its own width, such as a stroke, or a round end: there the lines straight in from the
 * edge meet in the middle head on (from opposite edges) or all at once (at the centre of the end's curve). `reach` is
 * how far in that is (samples: a stroke's half width, a round end's radius; a million elsewhere) and `head` how much
 * the sample is in such a part (0-1; at a corner the lines meet at an angle, 0). Found from the middle outward, each
 * sample taking them from the sample a step further in, then evened out between neighbours (they shape the rounding,
 * so a step from one row to the next would show). Samples just outside, on the rim, get their neighbours'. `bend` is
 * how sharply the edge bends where each sample's line comes from (see edgeDistance).
 */
function localRadius(g: Grid, dist: Float32Array, dir: Float32Array, bend: Float32Array): { reach: Float32Array; head: Float32Array } {
  const { gw, gh } = g, n = dist.length;
  // The inside samples furthest in first (sorted by distance in quarter samples, by counting).
  let top = 0;
  for (let k = 0; k < n; k++) if (g.inside[k] && dist[k] > top) top = dist[k];
  const slots = Math.floor(top * 4) + 1, count = new Int32Array(slots + 1);
  for (let k = 0; k < n; k++) if (g.inside[k]) count[slots - 1 - Math.floor(dist[k] * 4) + 1]++;
  for (let s = 1; s <= slots; s++) count[s] += count[s - 1];
  const order = new Int32Array(count[slots]);
  for (let k = 0; k < n; k++) if (g.inside[k]) order[count[slots - 1 - Math.floor(dist[k] * 4)]++] = k;
  // Per sample: how squarely, and 1 / reach (0 for no limit), so averaging leans to the narrower part.
  const head = new Float32Array(n), inv = new Float32Array(n), done = new Uint8Array(n);
  for (const k of order) {
    const dx = dir[k * 2], dy = dir[k * 2 + 1];
    done[k] = 1;
    if (!dx && !dy) continue;
    const i = k % gw, j = (k - i) / gw, ii = Math.round(i + dx), jj = Math.round(j + dy);
    const q = jj * gw + ii;
    if (ii >= 0 && jj >= 0 && ii < gw && jj < gh && done[q] && g.inside[q] && dist[q] > dist[k] + 0.3) { head[k] = head[q]; inv[k] = inv[q]; continue; }
    // A step in doesn't take us further from the edge: this is the middle. Across it, in a band, whose sides run
    // alongside each other, a neighbouring sample faces the other way (at a corner, or in a tapering point, which keep
    // their mitred look, at an angle); at a round end the edge curves around this point, its radius as far away as the
    // edge is. (A sharp corner bends far more tightly than that.)
    let facing = 0, across = -1;
    for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
      const a = (j + dj) * gw + i + di;
      if ((!di && !dj) || i + di < 0 || j + dj < 0 || i + di >= gw || j + dj >= gh || !g.inside[a]) continue;
      const f = -(dx * dir[a * 2] + dy * dir[a * 2 + 1]);
      if (f > Math.max(facing, 0.3)) { facing = f; across = a; }
    }
    const round = 1 - Math.abs(dist[k] * bend[k] - 1) / 0.4;
    // (A stroke only a sample or so wide may have no sample across: this one is its middle.)
    const slim = across < 0 && dist[k] < 1.5 ? 1 : 0;
    const t = Math.min(1, Math.max(0, (facing - 0.86) / 0.1, round * 2, slim));
    head[k] = t * t * (3 - 2 * t);
    // The middle usually falls between this sample and the one across: the distance rises toward it from one and falls
    // from it to the other, so it's where those meet (half their distances plus the gap between them, along the way in).
    let far = slim ? dist[k] + 0.25 : dist[k];
    if (across >= 0) {
      const ai = across % gw, gap = (ai - i) * dx + ((across - ai) / gw - j) * dy;
      if (gap > 0) far = Math.max(far, (dist[k] + dist[across] + gap) / 2);
    }
    inv[k] = head[k] / Math.max(0.5, far);
  }
  // Evened out over about half the reach (a few sizes are made, and the nearest two mixed): wide enough that where a
  // stroke runs into a broader part it rises into it gradually, rather than in a step.
  // (How squarely only needs evening out between neighbours.)
  const w2 = insideShare(g, 2), bh = boxBlur(head, gw, gh, 2);
  for (let k = 0; k < n; k++) head[k] = bh[k] * w2[k];
  const sizes: number[] = [], bi: Float32Array[] = [];
  for (let r = 2; r <= 32; r *= 2) {
    const w = insideShare(g, r), b = boxBlur(inv, gw, gh, r);
    let wide = false;
    for (let k = 0; k < n; k++) { b[k] *= w[k]; if (b[k] > 0.02 && b[k] * r < 0.5) wide = true; }
    sizes.push(r); bi.push(b);
    // (No band is wide enough to want a bigger size.)
    if (!wide) break;
  }
  const reach = new Float32Array(n);
  for (let k = 0; k < n; k++) {
    const near = 1 / Math.max(1e-6, bi[0][k]);
    const want = Math.log2(Math.max(1, Math.min(near, 64) / 4));
    const lo = Math.min(sizes.length - 1, Math.floor(want)), hi = Math.min(sizes.length - 1, lo + 1), f = Math.min(1, want - lo);
    reach[k] = 1 / Math.max(1e-6, bi[lo][k] * (1 - f) + bi[hi][k] * f);
  }
  return { reach, head };
}

/**
 * How far each inside sample is from the picture's traced edge, in samples, which way is straight in from the
 * nearest point of it (a unit vector), and how sharply the edge bends there (see Edge; per sample). Smooth along the
 * edge, so neither the distance nor the direction steps from one sample to the next.
 */
function edgeDistance(g: Grid, edge: Edge): { dist: Float32Array; dir: Float32Array; bend: Float32Array } {
  const { gw, gh } = g;
  const dist = new Float32Array(g.d.length), dir = new Float32Array(g.d.length * 2), bend = new Float32Array(g.d.length);
  const cell = (g.cx + g.cy) / 2;
  const X = (i: number) => g.x0 + i * g.cx, Y = (j: number) => g.y0 + j * g.cy;
  // Each sample's nearest segment of the edge. Right beside the edge, found by looking around.
  const near = new Int32Array(dist.length).fill(-1), best = new Float32Array(dist.length).fill(Infinity);
  for (let k = 0; k < dist.length; k++) {
    dist[k] = g.inside[k] ? g.d[k] - 0.5 : 0;
    if (!g.inside[k] || g.d[k] > 1.5) continue;
    const i = k % gw, j = (k - i) / gw;
    const q = nearestEdge(edge, X(i), Y(j), 3 * cell);
    if (q) { near[k] = q.s; best[k] = q.d; }
  }
  // Further in, handed on from neighbour to neighbour (forward, then back): each sample tries its neighbours' nearest
  // segments and the two either side of those (a step between samples can pass more than one).
  const segs = edge.seg.length / 8;
  const pass = (from: number, to: number, step: number, nbr: readonly number[]) => {
    for (let k = from; k !== to; k += step) {
      if (!g.inside[k] || g.d[k] <= 1.5) continue;
      const i = k % gw, j = (k - i) / gw, x = X(i), y = Y(j);
      // (Neighbours' segments are mostly the same or next to each other: each is tried once.)
      let lo = 1, hi = 0;
      for (let n = 0; n < nbr.length; n += 2) {
        const ii = i + nbr[n], jj = j + nbr[n + 1];
        if (ii < 0 || jj < 0 || ii >= gw || jj >= gh) continue;
        const s0 = near[jj * gw + ii];
        if (s0 < 0) continue;
        const a = Math.max(0, s0 - 2), b = Math.min(segs - 1, s0 + 2);
        for (let s = a; s <= b; s++) {
          if (s >= lo && s <= hi) continue;
          const d = segDist(edge, s, x, y);
          if (d < best[k]) { best[k] = d; near[k] = s; }
        }
        if (lo > hi) { lo = a; hi = b; }
        else if (a <= hi + 1 && b >= lo - 1) { lo = Math.min(lo, a); hi = Math.max(hi, b); }
      }
    }
  };
  pass(0, dist.length, 1, [-1, 0, -1, -1, 0, -1, 1, -1]);
  pass(dist.length - 1, -1, -1, [1, 0, 1, 1, 0, 1, -1, 1]);
  for (let k = 0; k < dist.length; k++) {
    if (near[k] < 0) continue;
    const i = k % gw, j = (k - i) / gw, x = X(i), y = Y(j), q = onSeg(edge, near[k], x, y);
    // (Right on the edge, or a hair outside it, straight in is against its outward direction.)
    if (q.d < 1e-3 * cell || (x - q.px) * q.nx + (y - q.py) * q.ny > 0) { dist[k] = 0; dir[k * 2] = -q.nx; dir[k * 2 + 1] = -q.ny; }
    else { dist[k] = q.d / cell; dir[k * 2] = (x - q.px) / q.d; dir[k * 2 + 1] = (y - q.py) / q.d; }
    bend[k] = edge.bend[q.s] * cell;
  }
  return { dist, dir, bend };
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
 * The picture's coverage (0-1) within `box` (all of it if none) at up to 1600 px on its long side (scale `s`), with a
 * transparent pixel border all round: pixel (i, j) is centred on layer pixel (ox + (i - 0.5) / s, oy + (j - 0.5) / s).
 */
function coverage(src: HTMLCanvasElement, box?: Rect) {
  const ox = box?.x ?? 0, oy = box?.y ?? 0, bw = box?.w ?? src.width, bh = box?.h ?? src.height;
  const s = Math.min(1, 1600 / Math.max(bw, bh));
  const w = Math.max(1, Math.round(bw * s)), hh = Math.max(1, Math.round(bh * s));
  const PW = w + 2, PH = hh + 2;
  const c = document.createElement('canvas'); c.width = PW; c.height = PH;
  const x = c.getContext('2d', { willReadFrequently: true })!;
  x.drawImage(src, ox, oy, bw, bh, 1, 1, w, hh);
  const px = x.getImageData(0, 0, PW, PH).data;
  const val = new Float32Array(PW * PH);
  for (let i = 0; i < val.length; i++) val[i] = px[i * 4 + 3] / 255;
  return { s, PW, PH, val, ox, oy };
}

/**
 * Where the silhouette is in the picture (layer pixels, whole ones): around every sample with any coverage, with two
 * samples to spare, so the picture's edges all fall inside.
 */
function shapeBox(g: Grid, W: number, H: number): Rect {
  let i0 = Infinity, j0 = Infinity, i1 = -Infinity, j1 = -Infinity;
  for (let j = 0; j < g.gh; j++) for (let i = 0; i < g.gw; i++) {
    if (!g.a[j * g.gw + i]) continue;
    if (i < i0) i0 = i; if (i > i1) i1 = i; if (j < j0) j0 = j; if (j > j1) j1 = j;
  }
  if (i0 > i1) return { x: 0, y: 0, w: W, h: H };
  const x0 = Math.max(0, Math.floor(g.x0 + (i0 - 2) * g.cx)), y0 = Math.max(0, Math.floor(g.y0 + (j0 - 2) * g.cy));
  const x1 = Math.min(W, Math.ceil(g.x0 + (i1 + 2) * g.cx)), y1 = Math.min(H, Math.ceil(g.y0 + (j1 + 2) * g.cy));
  return { x: x0, y: y0, w: Math.max(1, x1 - x0), h: Math.max(1, y1 - y0) };
}

/**
 * The picture's edges (where it's half covered) as closed loops in layer pixels, found with marching squares so they
 * follow anti-aliased edges smoothly, between pixels. Each runs with the inside on its right (y down). Only within
 * `box` (all of it if none), which should hold them all.
 */
function contours(src: HTMLCanvasElement, box?: Rect): Pt[][] {
  const { s, PW, PH, val, ox, oy } = coverage(src, box);
  const at = (i: number, j: number) => val[j * PW + i];
  // Each crossing sits on a grid edge: horizontal (i,j)-(i+1,j) is 2k, vertical (i,j)-(i,j+1) is 2k+1. Its two
  // neighbours along the loop, each stored plus one (0 for none yet, so the table needs no filling first).
  const nb = new Int32Array(PW * PH * 4);
  const link = (a: number, b: number) => {
    nb[a * 2 + (nb[a * 2] ? 1 : 0)] = b + 1;
    nb[b * 2 + (nb[b * 2] ? 1 : 0)] = a + 1;
  };
  // Which pixels are at least half covered.
  const on = new Uint8Array(PW * PH);
  for (let k = 0; k < on.length; k++) on[k] = val[k] >= 0.5 ? 1 : 0;
  for (let j = 0; j < PH - 1; j++) for (let i = 0; i < PW - 1; i++) {
    const k = j * PW + i, code = (on[k] << 3) | (on[k + 1] << 2) | (on[k + PW + 1] << 1) | on[k + PW];
    if (code === 0 || code === 15) continue;
    const tl = val[k], tr = val[k + 1], br = val[k + PW + 1], bl = val[k + PW];
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
    return { x: ox + ((vert ? i : i + t) - 1 + 0.5) / s, y: oy + ((vert ? j + t : j) - 1 + 0.5) / s };
  };
  const seen = new Uint8Array(PW * PH * 2);
  const loops: Pt[][] = [];
  for (let e0 = 0; e0 < seen.length; e0++) {
    if (seen[e0] || !nb[e0 * 2]) continue;
    const loop: Pt[] = [];
    let prev = -1, e = e0;
    while (e >= 0 && !seen[e]) {
      seen[e] = 1;
      const p = point(e);
      // Skip points closer than about a pixel and a half to the last one kept.
      const q = loop[loop.length - 1];
      if (!q || Math.hypot(p.x - q.x, p.y - q.y) >= 1.5) loop.push(p);
      const next = nb[e * 2] - 1 !== prev ? nb[e * 2] - 1 : nb[e * 2 + 1] - 1;
      prev = e; e = next;
    }
    if (loop.length < 3) continue;
    // Which way round it runs: vote, a step outside the normal side of a few segments.
    let vote = 0;
    const n = loop.length, step = Math.max(1, Math.floor(n / 16));
    for (let i = 0; i < n; i += step) {
      const p = loop[i], q = loop[(i + 1) % n], dx = q.x - p.x, dy = q.y - p.y, l = Math.hypot(dx, dy) || 1;
      const sx = Math.round(((p.x + q.x) / 2 + (dy / l) * 1.5 - ox) * s + 0.5), sy = Math.round(((p.y + q.y) / 2 - (dx / l) * 1.5 - oy) * s + 0.5);
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
  const out = new MeshBuilder();
  heightSurfaces(g, h, W, H, out, 2);
  // How high the face is at a point, read off its triangles exactly as they're drawn (each grid cell split from its
  // top-right to its bottom-left corner). With a bevel, the face is already partway up its rise where the picture's
  // edge cuts it, so the sides reach up to there instead of stopping at the flat thickness (which left a gap).
  const at = (i: number, j: number) => h[Math.min(g.gh - 1, Math.max(0, j)) * g.gw + Math.min(g.gw - 1, Math.max(0, i))];
  const faceH = (x: number, y: number) => {
    const fi = (x - g.x0) / g.cx, fj = (y - g.y0) / g.cy, i = Math.floor(fi), j = Math.floor(fj), fx = fi - i, fy = fj - j;
    const ha = at(i, j), hb = at(i + 1, j), hc = at(i, j + 1), hd = at(i + 1, j + 1);
    return fx + fy <= 1 ? ha + fx * (hb - ha) + fy * (hc - ha) : hd + (1 - fx) * (hc - hd) + (1 - fy) * (hb - hd);
  };
  // The sides, along the picture's edge, coloured from the picture just inside it. (The outline is traced once per
  // picture, not again for every change of thickness or bevel.)
  const parts = partsOf(g);
  for (const pts of (parts.contours ??= contours(src, shapeBox(g, W, H)))) {
    const top = pts.map((p) => faceH(p.x, p.y));
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
      const p = pts[i], q = pts[(i + 1) % n], s = seg[i], ta = top[i], tb = top[(i + 1) % n];
      const na = vn(i, i), nb = vn(i, (i + 1) % n);
      const r0 = run;
      run += Math.hypot(q.x - p.x, q.y - p.y);
      // Colour from just inside the edge.
      const ua = (p.x - s.x * 1.5) / W, va = (p.y - s.y * 1.5) / H, ub = (q.x - s.x * 1.5) / W, vb = (q.y - s.y * 1.5) / H;
      const A = out.vert(p.x, p.y, ta, na.x, na.y, 0, ua, va, 1, r0, 0), B = out.vert(q.x, q.y, tb, nb.x, nb.y, 0, ub, vb, 1, run, 0);
      const C = out.vert(q.x, q.y, -tb, nb.x, nb.y, 0, ub, vb, 1, run, 2 * tb), D = out.vert(p.x, p.y, -ta, na.x, na.y, 0, ua, va, 1, r0, 2 * ta);
      out.tri(A, B, C);
      out.tri(A, C, D);
    }
  }
  return out.finish([W / 2, H / 2, W, H]);
}

/** Revolve: each row of the silhouette becomes a ring around an upright axis through the picture's middle. */
function revolveMesh(g: Grid, src: HTMLCanvasElement, m: Model3D, W: number, H: number): Mesh {
  const { gh, cy } = g;
  // Row j's height in the picture (the grid starts a row above it, so the first and last rows are empty).
  const Y = (j: number) => g.y0 + j * cy;
  const axisX = pivotX(W, m);
  // How far each row reaches from the axis (outer), and where a gap around the axis ends (inner, for hollow parts).
  // Each row's edges, read from the picture in detail and placed between pixels where the coverage crosses half (so
  // the radius changes smoothly from row to row, not in steps).
  const outer = new Float32Array(gh), inner = new Float32Array(gh), has = new Uint8Array(gh);
  const { s, PW, PH, val } = coverage(src);
  const row = new Float32Array(PW);
  const lx = (i: number) => (i - 0.5) / s;
  for (let j = 0; j < gh; j++) {
    const fy = Math.min(PH - 1, Math.max(0, Y(j) * s + 0.5)), j0 = Math.floor(fy), j1 = Math.min(PH - 1, j0 + 1), t = fy - j0;
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
  const out = new MeshBuilder();
  // A texture wraps once around the widest part, like a label, centred on the front (three quarters of the way
  // round, as the texture's position runs).
  let widest = 1;
  for (let j = 0; j < gh; j++) if (has[j]) widest = Math.max(widest, ro[j]);
  const C = 2 * Math.PI * widest;
  const slopeAt = (r: Float32Array, j: number) => {
    const a = has[j - 1] ? r[j - 1] : r[j], b = has[j + 1] ? r[j + 1] : r[j];
    return (b - a) / (2 * cy);
  };
  // One ring of vertices per row and surface, made when first needed and shared by the bands above and below it.
  const rings = [new Map<number, number>(), new Map<number, number>()];
  const ring = (j: number, r: Float32Array, sign: 1 | -1): number => {
    const made = rings[sign > 0 ? 0 : 1];
    const hit = made.get(j);
    if (hit !== undefined) return hit;
    const slope = slopeAt(r, j), y = Y(j), rr = r[j];
    // Colour from the picture just inside its edge on this row.
    const u = Math.min(1, Math.max(0, (axisX + Math.max(0, rr - 1.5)) / W));
    let first = -1;
    for (let k = 0; k <= N; k++) {
      const t = (k / N) * Math.PI * 2, c = Math.cos(t), s = Math.sin(t);
      // Normal: outward from the axis, tipped by how the radius changes with height.
      const nx = c * sign, ny = -slope * sign, nz = s * sign, l = Math.hypot(nx, ny, nz) || 1;
      // (Around runs against the angle, so seen from the front it reads left to right.)
      const v = out.vert(axisX + rr * c, y, rr * s, nx / l, ny / l, nz / l, u, y / H, 1, (1 - k / N) * C, y);
      if (k === 0) first = v;
    }
    made.set(j, first);
    return first;
  };
  for (let j = 0; j < gh - 1; j++) {
    if (!has[j] || !has[j + 1]) continue;
    for (const [r, sign] of [[ro, 1], [ri, -1]] as const) {
      if (sign === -1 && (ri[j] <= 0 || ri[j + 1] <= 0)) continue;
      const a0 = ring(j, r, sign), c0 = ring(j + 1, r, sign);
      for (let k = 0; k < N; k++) {
        out.tri(a0 + k, a0 + k + 1, c0 + k);
        out.tri(a0 + k + 1, c0 + k + 1, c0 + k);
      }
    }
  }
  // Flat caps where the shape starts and ends (a lid or a ring's rim, from the inner to the outer radius).
  for (let j = 0; j < gh; j++) {
    if (!has[j]) continue;
    for (const [end, ny] of [[!has[j - 1], -1], [!has[j + 1], 1]] as const) {
      if (!end) continue;
      const y = Y(j), v = y / H;
      // The texture lies flat across a cap, as if seen from above.
      const P = (r: number, k: number) => {
        const t = (k / N) * Math.PI * 2;
        return out.vert(axisX + r * Math.cos(t), y, r * Math.sin(t), 0, ny, 0, Math.min(1, (axisX + Math.max(0, r - 1.5)) / W), v, 1, (3 * C) / 4 + r * Math.cos(t), y + r * Math.sin(t));
      };
      let pi = P(ri[j], 0), po = P(ro[j], 0);
      for (let k = 0; k < N; k++) {
        const qi = P(ri[j], k + 1), qo = P(ro[j], k + 1);
        out.tri(pi, qi, po);
        out.tri(qi, qo, po);
        pi = qi; po = qo;
      }
    }
  }
  return out.finish([(3 * C) / 4, H / 2, C, H]);
}

function meshFor(src: HTMLCanvasElement, m: Model3D, key: string): Mesh {
  const ck = `${key}|${src.width}x${src.height}|${m.kind}|${m.depth}|${m.round}|${m.bevel ?? 0}|${m.axis ?? 'centre'}`;
  const hit = meshCache.get(ck);
  if (hit) return hit;
  if (meshCache.size > 16) meshCache.clear();
  const g = silhouette(src, key), W = src.width, H = src.height;
  const mesh = m.kind === 'extrude' ? extrudeMesh(g, src, m, W, H) : m.kind === 'revolve' ? revolveMesh(g, src, m, W, H) : inflateMesh(g, src, m, W, H);
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

type V3 = [number, number, number];

/**
 * Everything about how a 3D layer is turned and lit, in the turned object's frame (x right, y down, z toward the
 * viewer, layer pixels from the pivot): the turn, how far the object reaches from the pivot (`ext`), its nearest and
 * farthest depth, which way the light comes from (`dir`, a unit vector toward it), a lamp's position, the light's
 * colour, and for shadows, the wall behind (its depth) and how soft they are (layer pixels).
 */
interface Scene {
  R: number[]; px: number; cy: number; f: number; ext: number; z0: number; z1: number;
  dir: V3; lamp: V3 | null; color: V3; wall: number; blur: number;
}

function sceneOf(W: number, H: number, m: Model3D, mesh: Mesh): Scene {
  const R = rotation(m), px = pivotX(W, m), cy = H / 2;
  const ext = Math.max(1, ...[mesh.lo, mesh.hi].flatMap((p) => p.map((v, i) => Math.abs(v - (i === 0 ? px : i === 1 ? cy : 0)))));
  let z0 = Infinity, z1 = -Infinity;
  for (const x of [mesh.lo[0], mesh.hi[0]]) for (const y of [mesh.lo[1], mesh.hi[1]]) for (const z of [mesh.lo[2], mesh.hi[2]]) {
    const pz = R[6] * (x - px) + R[7] * (y - cy) + R[8] * z;
    z0 = Math.min(z0, pz); z1 = Math.max(z1, pz);
  }
  const L = m.light, el = L.el * D2R, az = L.az * D2R;
  let dir: V3 = [Math.cos(el) * Math.cos(az), -Math.cos(el) * Math.sin(az), Math.sin(el)];
  // Turning with the object: the direction is the object's own, turned with it.
  if (L.follow) dir = [R[0] * dir[0] + R[1] * dir[1] + R[2] * dir[2], R[3] * dir[0] + R[4] * dir[1] + R[5] * dir[2], R[6] * dir[0] + R[7] * dir[1] + R[8] * dir[2]];
  const d = (L.dist ?? 2) * ext;
  const lamp: V3 | null = L.kind === 'lamp' ? [dir[0] * d, dir[1] * d, dir[2] * d] : null;
  const hex = L.color ?? '#ffffff';
  const color: V3 = [parseInt(hex.slice(1, 3), 16) / 255, parseInt(hex.slice(3, 5), 16) / 255, parseInt(hex.slice(5, 7), 16) / 255];
  const sh = m.shadow;
  return {
    R, px, cy, f: CAM * Math.max(W, H), ext, z0, z1, dir, lamp, color,
    wall: z0 - ((sh?.gap ?? 15) / 100) * 2 * ext, blur: ((sh?.soft ?? 35) / 100) * ext * 0.12,
  };
}

/** Where a point of the turned object (relative to the pivot) throws its shadow on the wall behind. */
function onWall(s: Scene, p: V3): V3 {
  if (s.lamp) {
    // Along the line from the lamp through the point (not too far, where it's almost level with the lamp).
    const d: V3 = [p[0] - s.lamp[0], p[1] - s.lamp[1], p[2] - s.lamp[2]];
    const t = Math.min(50, (s.wall - s.lamp[2]) / Math.min(d[2], -1e-3));
    return [s.lamp[0] + d[0] * t, s.lamp[1] + d[1] * t, s.wall];
  }
  const t = (p[2] - s.wall) / Math.max(s.dir[2], 0.03);
  return [p[0] - s.dir[0] * t, p[1] - s.dir[1] * t, s.wall];
}

/** The box (layer pixels) around a 3D layer's shadow on the wall, its blur included. */
function shadowBounds(s: Scene, mesh: Mesh): Rect {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const x of [mesh.lo[0], mesh.hi[0]]) for (const y of [mesh.lo[1], mesh.hi[1]]) for (const z of [mesh.lo[2], mesh.hi[2]]) {
    const R = s.R, a = x - s.px, b = y - s.cy;
    const q = onWall(s, [R[0] * a + R[1] * b + R[2] * z, R[3] * a + R[4] * b + R[5] * z, R[6] * a + R[7] * b + R[8] * z]);
    const k = s.f / (s.f - q[2]);
    const sx = s.px + q[0] * k, sy = s.cy + q[1] * k;
    x0 = Math.min(x0, sx); y0 = Math.min(y0, sy); x1 = Math.max(x1, sx); y1 = Math.max(y1, sy);
  }
  // (A lamp nearly level with part of the object throws that part very far: kept to a few sizes away.)
  const lim = 4 * s.ext, pad = 3 * s.blur + 2;
  x0 = Math.max(x0, s.px - lim) - pad; x1 = Math.min(x1, s.px + lim) + pad;
  y0 = Math.max(y0, s.cy - lim) - pad; y1 = Math.min(y1, s.cy + lim) + pad;
  return { x: Math.floor(x0), y: Math.floor(y0), w: Math.ceil(x1 - x0), h: Math.ceil(y1 - y0) };
}

/** A 3D layer's box: the turned object, and with shadows on, its shadow behind it. */
function frameOf(W: number, H: number, m: Model3D, mesh: Mesh, withShadow: boolean): Rect {
  const b = boundsOf(W, H, m, mesh);
  if (!withShadow || !m.shadow?.on) return b;
  const s = shadowBounds(sceneOf(W, H, m, mesh), mesh);
  const x0 = Math.min(b.x, s.x), y0 = Math.min(b.y, s.y);
  return { x: x0, y: y0, w: Math.max(b.x + b.w, s.x + s.w) - x0, h: Math.max(b.y + b.h, s.y + s.h) - y0 };
}

/**
 * The light's view for the shadow map, as a 4×4 matrix (column-major, for GLSL) from the turned object's frame:
 * looking along the sunlight, square-on and just wide enough for the object; or from the lamp toward the object's
 * middle, in perspective. Depth runs from near the light (-1) to far (+1).
 */
function lightView(s: Scene): Float32Array {
  const E = s.ext * 1.75;
  const fw: V3 = s.lamp ? (() => { const l = Math.hypot(...s.lamp!) || 1; return [-s.lamp![0] / l, -s.lamp![1] / l, -s.lamp![2] / l] as V3; })() : [-s.dir[0], -s.dir[1], -s.dir[2]];
  const up: V3 = Math.abs(fw[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const r0 = cross(up, fw), rl = Math.hypot(...r0), r: V3 = [r0[0] / rl, r0[1] / rl, r0[2] / rl], u = cross(fw, r);
  const M = new Float32Array(16);
  // Columns: M[c * 4 + row].
  const set = (row: number, v: V3, w: number) => { M[row] = v[0]; M[4 + row] = v[1]; M[8 + row] = v[2]; M[12 + row] = w; };
  if (!s.lamp) {
    set(0, [r[0] / E, r[1] / E, r[2] / E], 0);
    set(1, [u[0] / E, u[1] / E, u[2] / E], 0);
    set(2, [fw[0] / E, fw[1] / E, fw[2] / E], 0);
    set(3, [0, 0, 0], 1);
    return M;
  }
  const P = s.lamp, D = Math.hypot(...P);
  const n = Math.max(D - E, D * 0.05, 1), far = D + E;
  const t = Math.min(4, E / Math.sqrt(Math.max(D * D - E * E, (D * 0.2) ** 2)));
  // Rows of view (eye at the lamp, looking along fw) then the projection.
  const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const a = (far + n) / (far - n), b = (-2 * far * n) / (far - n);
  set(0, [r[0] / t, r[1] / t, r[2] / t], -dot(r, P) / t);
  set(1, [u[0] / t, u[1] / t, u[2] / t], -dot(u, P) / t);
  set(2, [fw[0] * a, fw[1] * a, fw[2] * a], -dot(fw, P) * a + b);
  set(3, fw, -dot(fw, P));
  return M;
}

// ---------- rendering ----------

/** The shadow map's size (pixels across). */
const SM = 1024;

const VS = `#version 300 es
in vec3 aPos; in vec3 aNrm; in vec2 aUV; in float aSolid; in vec2 aT; in vec4 aEdge; in float aReach;
uniform mat3 uR; uniform vec2 uC; uniform float uF; uniform vec4 uBox; uniform float uZr;
out vec3 vN; out vec2 vUV; out float vSolid; out float vZ; out vec2 vT; out vec3 vP; out vec4 vEdge; out float vReach;
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
  vEdge = aEdge;
  vReach = aReach;
  gl_Position = vec4((s.x - uBox.x) / uBox.z * 2.0 - 1.0, 1.0 - (s.y - uBox.y) / uBox.w * 2.0, -p.z / uZr, 1.0);
}`;
const FS = `#version 300 es
precision highp float;
in vec3 vN; in vec2 vUV; in float vSolid; in float vZ; in vec2 vT; in vec3 vP; in vec4 vEdge; in float vReach; out vec4 o;
// Inflate's rounded profile (height and how far in it reaches, pixels; a narrower part of the shape is rounded by its
// own reach, vReach); y = 0 for other shapes.
uniform vec2 uProf;
uniform int uOut; uniform vec2 uZ;
uniform sampler2D uTex; uniform sampler2D uBled; uniform int uPass; uniform mat3 uR;
uniform vec3 uL; uniform vec4 uCol; uniform vec4 uMat; uniform float uAmb; uniform float uStr;
// The texture: on/off, where it sits (centre and size in surface pixels), its turn, and
// uTxOpt: x multiply (else replace), y amount, z tile, w where (0 all, 1 front and back, 2 sides). uKind 1 = Extrude.
uniform sampler2D uTx; uniform int uTxOn; uniform vec4 uTxFit; uniform float uTxRot; uniform vec4 uTxOpt;
uniform float uBump; uniform int uKind;
// A lamp (uLampOn 1) at uLamp instead of light from direction uL; the light's colour.
uniform int uLampOn; uniform vec3 uLamp; uniform vec3 uLCol;
// Shadows: the light's view (see lightView) and its depths, and uSh: x on, y how dark, z how soft (in the depth map's
// width), w how far to step off the surface toward the light before looking (so it doesn't shadow itself).
uniform highp sampler2DShadow uSM; uniform mat4 uLM; uniform vec4 uSh;
const vec2 DISC[8] = vec2[](vec2(-0.613, 0.617), vec2(0.170, -0.040), vec2(-0.299, -0.792), vec2(0.645, 0.493),
  vec2(-0.651, -0.172), vec2(0.421, -0.703), vec2(-0.002, 0.989), vec2(0.952, -0.104));
float lum(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
// How much light reaches this point (0-1): whether the light's view sees something nearer to it here, over a few
// spots around it (softer the wider they're spread). g: the surface's facing as built (for stepping off it: smooth
// facings may not match its triangles).
float lit(vec3 p, vec3 toward, vec3 g) {
  if (uSh.x < 0.5) return 1.0;
  // Where the light only grazes it, the depth map's pixels span more depth across the surface: it steps further off,
  // and allows more.
  if (dot(g, toward) < 0.0) g = -g;
  float ct = clamp(dot(g, toward), 0.0, 1.0), slope = min(10.0, sqrt(1.0 - ct * ct) / max(ct, 0.05));
  vec4 q = uLM * vec4(p + g * uSh.w * (1.0 + 2.0 * (1.0 - ct)), 1.0);
  vec3 c = q.xyz / q.w * 0.5 + 0.5;
  if (c.x < 0.0 || c.y < 0.0 || c.x > 1.0 || c.y > 1.0 || c.z > 1.0) return 1.0;
  float bias = (1.5 + 2.0 * slope) / ${SM}.0, s = 0.0;
  for (int i = 0; i < 8; i++) s += texture(uSM, vec3(c.xy + DISC[i] * uSh.z, c.z - bias));
  return s / 8.0;
}
void main() {
  // Faces are cut out by the picture's own edges; sides and revolved surfaces are always solid. Pass 0 draws it all
  // solid (faces cut where they're half covered), pass 1 adds the faces' soft edges over whatever is behind them.
  bool solid = vSolid > 0.5 && vSolid < 1.5;
  // (Inflate's surfaces end on the picture's edge themselves, so they aren't cut out.)
  // (Nothing past the picture's border, where its edge pixels would otherwise repeat.)
  vec2 inPic = step(vec2(0.0), vUV) * step(vUV, vec2(1.0));
  float a = solid || uKind == 0 ? 1.0 : smoothstep(0.3, 0.7, texture(uTex, vUV).a) * inPic.x * inPic.y;
  if (uPass == 0) { if (a < 0.5) discard; a = 1.0; }
  // (Only the face turned toward the viewer: the other one's edge would peek out past the sides.)
  else if (solid || a < 0.01 || a > 0.99 || (vSolid > 1.5 ? -uR[2][2] : uR[2][2]) < 0.0) discard;
  // Colours come from a copy of the picture with its edge colours spread outward, so the sides never pick up
  // the empty (black) pixels just past the edge.
  vec4 t = texture(uBled, vUV);
  vec3 base = uCol.a > 0.5 ? uCol.rgb : t.rgb / max(t.a, 1e-4);
  vec3 N = normalize(vN);
  // Inflate, near the edge: face the way the rounded profile does at this exact distance from the edge (it turns
  // from upright to level faster than the grid's points can show), mixed in by the weight.
  float ew = abs(vEdge.w);
  if (uProf.y > 0.0 && ew > 0.001) {
    // (Where a triangle spans the middle of a thin stroke, the directions in from its two sides average out shorter,
    // and the slope with them, to level on top.)
    vec2 dir = vEdge.yz;
    float e = max(1e-3, min(vReach, uProf.y)), q = e / uProf.y, u = clamp(vEdge.x / e, 0.002, 1.0);
    float rise = uProf.x * sqrt(q * (2.0 - q)) * (1.0 - u) / sqrt(max(1e-6, u * (2.0 - u))) / e;
    vec3 exact = normalize(uR * vec3(-rise * dir, sign(vEdge.w)));
    N = normalize(mix(N, exact, min(1.0, ew)));
  }
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
  // Toward the light: a lamp's direction changes from point to point, and it's brighter nearer (by the square of how
  // much nearer than the object's middle, up to three times).
  vec3 Ld = uL;
  float near = 1.0;
  if (uLampOn == 1) {
    vec3 d = uLamp - vP;
    Ld = normalize(d);
    near = min(3.0, dot(uLamp, uLamp) / max(dot(d, d), 1.0));
  }
  float diff = max(dot(N, Ld), 0.0);
  vec3 H = normalize(Ld + vec3(0.0, 0.0, 1.0));
  float spec = pow(max(dot(N, H), 0.0), uMat.z) * uMat.y;
  // (Only looked up where the light reaches it at all.)
  vec3 g = normalize(cross(dFdx(vP), dFdy(vP)));
  float shade = diff > 0.0 || spec > 0.002 ? lit(vP, Ld, g) : 1.0;
  vec3 light = uLCol * uStr * near * mix(1.0, shade, uSh.y);
  // uMat: x diffuse weight, y specular weight, z shininess, w metal (specular takes the surface colour).
  vec3 specCol = mix(vec3(1.0), base, uMat.w);
  vec3 c = base * (uAmb + uMat.x * diff * light) + specCol * spec * light;
  // A depth map instead: its nearest point white, its farthest dark grey.
  if (uOut == 1) c = vec3(mix(0.2, 1.0, clamp((vZ - uZ.x) / max(uZ.y - uZ.x, 1e-3), 0.0, 1.0)));
  o = vec4(c * a, a);
}`;

/**
 * Flat drawing of the object, for shadows. uMode 0: from the light (see lightView), for the shadow map's depths.
 * uMode 1: its shadow on the wall behind (depth uWall), along the light (see onWall), drawn black into its box.
 */
const FLAT_VS = `#version 300 es
in vec3 aPos; in vec2 aUV; in float aSolid;
uniform mat3 uR; uniform vec2 uC; uniform float uF; uniform vec4 uBox; uniform mat4 uLM; uniform int uMode;
uniform vec3 uL; uniform int uLampOn; uniform vec3 uLamp; uniform float uWall;
out vec2 vUV; out float vSolid;
void main() {
  vec3 p = uR * vec3(aPos.xy - uC, aPos.z);
  vUV = aUV;
  vSolid = aSolid;
  if (uMode == 0) { gl_Position = uLM * vec4(p, 1.0); return; }
  vec3 s;
  if (uLampOn == 1) { vec3 d = p - uLamp; s = uLamp + d * min(50.0, (uWall - uLamp.z) / min(d.z, -1e-3)); }
  else s = p - uL * ((p.z - uWall) / max(uL.z, 0.03));
  vec2 q = uC + s.xy * (uF / (uF - uWall));
  gl_Position = vec4((q.x - uBox.x) / uBox.z * 2.0 - 1.0, 1.0 - (q.y - uBox.y) / uBox.w * 2.0, 0.0, 1.0);
}`;
const FLAT_FS = `#version 300 es
precision highp float;
in vec2 vUV; in float vSolid; out vec4 o;
uniform sampler2D uTex; uniform int uKind;
void main() {
  // (Faces cut out by the picture's edges, as when drawn.)
  if (!(vSolid > 0.5 && vSolid < 1.5) && uKind != 0) {
    vec2 inPic = step(vec2(0.0), vUV) * step(vUV, vec2(1.0));
    if (texture(uTex, vUV).a * inPic.x * inPic.y < 0.5) discard;
  }
  o = vec4(0.0, 0.0, 0.0, 1.0);
}`;

/**
 * The shadow on the wall, softened and laid down, over the whole canvas. uMode 0: a blur along uStep (a Gaussian
 * of uSigma pixels, 25 looks across ±3 sigma); 1: laid down as black, as dark as uOpacity.
 */
const QUAD_VS = `#version 300 es
in vec2 aQ; out vec2 vQ;
void main() { vQ = aQ * 0.5 + 0.5; gl_Position = vec4(aQ, 0.0, 1.0); }`;
const QUAD_FS = `#version 300 es
precision highp float;
in vec2 vQ; out vec4 o;
uniform sampler2D uImg; uniform int uMode; uniform vec2 uStep; uniform float uSigma; uniform float uOpacity;
void main() {
  if (uMode == 1) { o = vec4(0.0, 0.0, 0.0, texture(uImg, vQ).a * uOpacity); return; }
  float a = 0.0, wsum = 0.0;
  for (int i = -12; i <= 12; i++) {
    float x = float(i) / 4.0 * uSigma, w = exp(-0.5 * x * x / (uSigma * uSigma));
    a += texture(uImg, vQ + uStep * x).a * w;
    wsum += w;
  }
  o = vec4(0.0, 0.0, 0.0, a / wsum);
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
  /** The mesh's triangles (vertex numbers). */
  private ibuf: WebGLBuffer | null = null;
  private bufMesh: Mesh | null = null;
  private u: Record<string, WebGLUniformLocation | null> = {};
  /** The flat program (shadows) and its uniforms; the shadow map's depths and its framebuffer. */
  private flat: WebGLProgram | null = null;
  private fu: Record<string, WebGLUniformLocation | null> = {};
  private smTex: WebGLTexture | null = null;
  private smFbo: WebGLFramebuffer | null = null;
  /** The quad program (softening and laying down the wall shadow), its corners, and two canvas-sized images for it. */
  private quad: WebGLProgram | null = null;
  private qu: Record<string, WebGLUniformLocation | null> = {};
  private qVao: WebGLVertexArrayObject | null = null;
  private shTex: WebGLTexture[] = [];
  private shFbo: WebGLFramebuffer[] = [];
  private shSize = '';
  /** The plainer mesh for shadows (Mesh.lite): its own vertex setup and buffers, and which one is in them. */
  private liteVao: WebGLVertexArrayObject | null = null;
  private liteBuf: WebGLBuffer | null = null;
  private liteIx: WebGLBuffer | null = null;
  private liteData: Float32Array | null = null;
  /** What the shadow map holds: the mesh, the light's view of it, and the shape's kind. */
  private smMesh: Mesh | null = null;
  private smView: Float32Array | null = null;
  private smKind = -1;

  /** Draws the mesh for shadows (its plainer version, if it has one) with the flat program set up. */
  private drawFlat(gl: WebGL2RenderingContext, mesh: Mesh) {
    const lite = mesh.lite;
    if (!lite) { gl.drawElements(gl.TRIANGLES, mesh.count, gl.UNSIGNED_INT, 0); return; }
    if (!this.liteVao) {
      this.liteVao = gl.createVertexArray();
      this.liteBuf = gl.createBuffer();
      this.liteIx = gl.createBuffer();
      gl.bindVertexArray(this.liteVao);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.liteBuf);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.liteIx);
      const F = 4 * STRIDE;
      gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, F, 0);
      gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 2, gl.FLOAT, false, F, 24);
      gl.enableVertexAttribArray(3); gl.vertexAttribPointer(3, 1, gl.FLOAT, false, F, 32);
    } else gl.bindVertexArray(this.liteVao);
    if (this.liteData !== lite.data) {
      gl.bindBuffer(gl.ARRAY_BUFFER, this.liteBuf);
      gl.bufferData(gl.ARRAY_BUFFER, lite.data, gl.STATIC_DRAW);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, lite.index, gl.STATIC_DRAW);
      this.liteData = lite.data;
    }
    gl.drawElements(gl.TRIANGLES, lite.count, gl.UNSIGNED_INT, 0);
    gl.bindVertexArray(null);
    // (Back to the full mesh's buffer for whatever's drawn next.)
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buf);
  }

  private init() {
    if (this.gl) return this.gl;
    const gl = this.canvas.getContext('webgl2', { premultipliedAlpha: true, antialias: true, preserveDrawingBuffer: true });
    if (!gl) return null;
    const sh = (type: number, src: string) => { const s = gl.createShader(type)!; gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) console.error(gl.getShaderInfoLog(s)); return s; };
    const link = (vs: string, fs: string, attrs: [string, number][]) => {
      const p = gl.createProgram()!;
      gl.attachShader(p, sh(gl.VERTEX_SHADER, vs));
      gl.attachShader(p, sh(gl.FRAGMENT_SHADER, fs));
      for (const [n, i] of attrs) gl.bindAttribLocation(p, i, n);
      gl.linkProgram(p);
      if (!gl.getProgramParameter(p, gl.LINK_STATUS)) { console.error('3D shader failed', gl.getProgramInfoLog(p)); return null; }
      return p;
    };
    const p = link(VS, FS, ['aPos', 'aNrm', 'aUV', 'aSolid', 'aT', 'aEdge', 'aReach'].map((n, i) => [n, i]));
    const fp = link(FLAT_VS, FLAT_FS, [['aPos', 0], ['aUV', 2], ['aSolid', 3]]);
    const qp = link(QUAD_VS, QUAD_FS, [['aQ', 0]]);
    if (!p || !fp || !qp) return null;
    this.quad = qp;
    for (const n of ['uImg', 'uMode', 'uStep', 'uSigma', 'uOpacity']) this.qu[n] = gl.getUniformLocation(qp, n);
    this.qVao = gl.createVertexArray();
    gl.bindVertexArray(this.qVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
    for (const n of ['uR', 'uC', 'uF', 'uBox', 'uZr', 'uTex', 'uBled', 'uPass', 'uOut', 'uZ', 'uL', 'uCol', 'uMat', 'uAmb', 'uStr',
      'uTx', 'uTxOn', 'uTxFit', 'uTxRot', 'uTxOpt', 'uBump', 'uKind', 'uProf', 'uLampOn', 'uLamp', 'uLCol', 'uSM', 'uLM', 'uSh']) this.u[n] = gl.getUniformLocation(p, n);
    for (const n of ['uR', 'uC', 'uF', 'uBox', 'uLM', 'uMode', 'uL', 'uLampOn', 'uLamp', 'uWall', 'uTex', 'uKind']) this.fu[n] = gl.getUniformLocation(fp, n);
    this.flat = fp;
    // The shadow map: depths only, compared when read (each look gives how much of the spot is lit, smoothly).
    this.smTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.smTex);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.DEPTH_COMPONENT24, SM, SM);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_MODE, gl.COMPARE_REF_TO_TEXTURE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_FUNC, gl.LEQUAL);
    this.smFbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.smFbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, this.smTex, 0);
    gl.drawBuffers([gl.NONE]);
    gl.readBuffer(gl.NONE);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
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
    this.ibuf = gl.createBuffer();
    this.gl = gl;
    this.prog = p;
    return gl;
  }

  /**
   * Gets a render ready: the mesh in its buffers, the picture as textures, the canvas sized to the turned object's box
   * (layer pixels) at `scale`, and the turn and light.
   */
  private prepare(src: HTMLCanvasElement, m: Model3D, key: string, scale: number) {
    const gl = this.init();
    if (!gl || !this.prog) return null;
    const W = src.width, H = src.height;
    const mesh = meshFor(src, m, key);
    const box = boundsOf(W, H, m, mesh);
    let s = Math.max(0.1, scale);
    while (s > 0.1 && Math.max(box.w, box.h) * s > 4096) s /= 2;
    const cw = Math.max(1, Math.ceil(box.w * s)), ch = Math.max(1, Math.ceil(box.h * s));
    if (this.canvas.width !== cw || this.canvas.height !== ch) { this.canvas.width = cw; this.canvas.height = ch; }
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buf);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.ibuf);
    if (this.bufMesh !== mesh) {
      gl.bufferData(gl.ARRAY_BUFFER, mesh.data, gl.STATIC_DRAW);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, mesh.index, gl.STATIC_DRAW);
      this.bufMesh = mesh;
    }
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
    const F = 4 * STRIDE;
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, F, 0);
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 3, gl.FLOAT, false, F, 12);
    gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 2, gl.FLOAT, false, F, 24);
    gl.enableVertexAttribArray(3); gl.vertexAttribPointer(3, 1, gl.FLOAT, false, F, 32);
    gl.enableVertexAttribArray(4); gl.vertexAttribPointer(4, 2, gl.FLOAT, false, F, 36);
    gl.enableVertexAttribArray(5); gl.vertexAttribPointer(5, 4, gl.FLOAT, false, F, 44);
    gl.enableVertexAttribArray(6); gl.vertexAttribPointer(6, 1, gl.FLOAT, false, F, 60);
    return { gl, mesh, box, s, cw, ch, scene: sceneOf(W, H, m, mesh), kind: m.kind === 'extrude' ? 1 : m.kind === 'revolve' ? 2 : 0 };
  }

  /** The flat program's turn, light and wall (see FLAT_VS). */
  private flatSetup(gl: WebGL2RenderingContext, sc: Scene, box: Rect, kind: number, mode: number) {
    const u = this.fu, R = sc.R;
    gl.useProgram(this.flat);
    gl.uniformMatrix3fv(u.uR, false, [R[0], R[3], R[6], R[1], R[4], R[7], R[2], R[5], R[8]]);
    gl.uniform2f(u.uC, sc.px, sc.cy);
    gl.uniform1f(u.uF, sc.f);
    gl.uniform4f(u.uBox, box.x, box.y, box.w, box.h);
    gl.uniformMatrix4fv(u.uLM, false, lightView(sc));
    gl.uniform1i(u.uMode, mode);
    gl.uniform3f(u.uL, sc.dir[0], sc.dir[1], sc.dir[2]);
    gl.uniform1i(u.uLampOn, sc.lamp ? 1 : 0);
    if (sc.lamp) gl.uniform3f(u.uLamp, sc.lamp[0], sc.lamp[1], sc.lamp[2]);
    gl.uniform1f(u.uWall, sc.wall);
    gl.uniform1i(u.uTex, 0);
    gl.uniform1i(u.uKind, kind);
  }

  /** Two images `w` by `h` for the wall shadow, made (or remade) at that size. */
  private shadowImages(gl: WebGL2RenderingContext, w: number, h: number) {
    const size = `${w}x${h}`;
    if (this.shSize === size) return;
    for (let i = 0; i < 2; i++) {
      if (!this.shTex[i]) { this.shTex[i] = gl.createTexture()!; this.shFbo[i] = gl.createFramebuffer()!; }
      gl.bindTexture(gl.TEXTURE_2D, this.shTex[i]);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.shFbo[i]);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.shTex[i], 0);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.shSize = size;
  }

  /**
   * The 3D layer's shadow on the wall behind it, black on clear, softened and as dark as set, small: at a half, a
   * quarter or less of the object's resolution (it's softened anyway), so it fits in the top-left corner of the canvas
   * as sized for the object, where it's drawn (`w` by `h` pixels). `box` is where it goes (layer pixels), its blur
   * included. Null without shadows.
   */
  renderWall(src: HTMLCanvasElement, m: Model3D, key: string, scale: number): { w: number; h: number; box: Rect } | null {
    if (!m.shadow?.on) return null;
    const r = this.prepare(src, m, key, scale);
    if (!r) return null;
    const { gl, mesh, s, cw, ch, scene } = r;
    const box = shadowBounds(scene, mesh), blur = scene.blur * s;
    let f = blur >= 4 ? 4 : 2;
    while (f < 64 && (box.w * s > cw * f || box.h * s > ch * f)) f *= 2;
    const w = Math.max(1, Math.min(cw, Math.ceil((box.w * s) / f))), h = Math.max(1, Math.min(ch, Math.ceil((box.h * s) / f)));
    this.shadowImages(gl, w, h);
    gl.disable(gl.DEPTH_TEST);
    gl.viewport(0, 0, w, h);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.shFbo[0]);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    this.flatSetup(gl, scene, box, r.kind, 1);
    this.drawFlat(gl, mesh);
    // Blurred (at least a little, which also smooths its stair-stepped edge), across into the other image, and back.
    gl.useProgram(this.quad);
    gl.bindVertexArray(this.qVao);
    gl.activeTexture(gl.TEXTURE4);
    gl.uniform1i(this.qu.uImg, 4);
    gl.uniform1i(this.qu.uMode, 0);
    gl.uniform1f(this.qu.uSigma, Math.max(0.6, blur / f));
    for (const [from, to, sx, sy] of [[0, 1, 1 / w, 0], [1, 0, 0, 1 / h]] as const) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.shFbo[to]);
      gl.bindTexture(gl.TEXTURE_2D, this.shTex[from]);
      gl.uniform2f(this.qu.uStep, sx, sy);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }
    // Laid down in the canvas's top-left corner (GL counts rows from the bottom).
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, cw, ch);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.viewport(0, ch - h, w, h);
    gl.bindTexture(gl.TEXTURE_2D, this.shTex[0]);
    gl.uniform1i(this.qu.uMode, 1);
    gl.uniform1f(this.qu.uOpacity, m.shadow!.opacity / 100);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.bindVertexArray(null);
    gl.activeTexture(gl.TEXTURE0);
    return { w, h, box };
  }

  /**
   * The 3D layer (or its depth map) drawn into its box (layer pixels) at `scale` output pixels per layer pixel.
   * `tex` is its texture's image, if it has one.
   */
  render(src: HTMLCanvasElement, m: Model3D, key: string, scale: number, depth = false, tex?: HTMLCanvasElement | null): { canvas: HTMLCanvasElement; box: Rect } | null {
    const r = this.prepare(src, m, key, scale);
    if (!r) return null;
    const { gl, mesh, box, cw, ch, scene: sc } = r;
    const shadows = !depth && !!m.shadow?.on;
    // First the shadow map: the object's depths as the light sees it. (Kept while the shape, its turn and the light
    // stay the same: zooming, or changing the colour, finish or how dark the shadows are, doesn't need it again.)
    const view = shadows ? lightView(sc) : null;
    if (view && !(this.smMesh === mesh && this.smView?.every((v, i) => v === view[i]) && this.smKind === r.kind)) {
      this.smMesh = mesh; this.smView = view; this.smKind = r.kind;
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.smFbo);
      gl.viewport(0, 0, SM, SM);
      gl.clearDepth(1);
      gl.clear(gl.DEPTH_BUFFER_BIT);
      gl.enable(gl.DEPTH_TEST);
      gl.depthFunc(gl.LESS);
      gl.enable(gl.POLYGON_OFFSET_FILL);
      gl.polygonOffset(2, 4);
      this.flatSetup(gl, sc, box, r.kind, 0);
      this.drawFlat(gl, mesh);
      gl.disable(gl.POLYGON_OFFSET_FILL);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    }
    gl.viewport(0, 0, cw, ch);
    gl.clearColor(0, 0, 0, 0);
    gl.clearDepth(1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LESS);
    gl.useProgram(this.prog);
    const R = sc.R;
    // GLSL mat3 is column-major: pass the transpose of the row-major rotation.
    gl.uniformMatrix3fv(this.u.uR, false, [R[0], R[3], R[6], R[1], R[4], R[7], R[2], R[5], R[8]]);
    gl.uniform2f(this.u.uC, sc.px, sc.cy);
    gl.uniform1f(this.u.uF, sc.f);
    gl.uniform4f(this.u.uBox, box.x, box.y, box.w, box.h);
    gl.uniform1f(this.u.uZr, sc.ext * 2 + 1);
    gl.uniform1i(this.u.uTex, 0);
    gl.uniform1i(this.u.uBled, 1);
    gl.uniform1i(this.u.uOut, depth ? 1 : 0);
    // (For the depth map: the nearest and farthest the turned object reaches, its box's corners.)
    if (depth) gl.uniform2f(this.u.uZ, sc.z0, sc.z1);
    gl.uniform3f(this.u.uL, sc.dir[0], sc.dir[1], sc.dir[2]);
    gl.uniform1i(this.u.uLampOn, sc.lamp ? 1 : 0);
    if (sc.lamp) gl.uniform3f(this.u.uLamp, sc.lamp[0], sc.lamp[1], sc.lamp[2]);
    gl.uniform3f(this.u.uLCol, sc.color[0], sc.color[1], sc.color[2]);
    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_2D, this.smTex);
    gl.uniform1i(this.u.uSM, 3);
    if (view) {
      gl.uniformMatrix4fv(this.u.uLM, false, view);
      // Softness: up to 20 of the map's pixels across; a step of a pixel and a half off the surface.
      gl.uniform4f(this.u.uSh, 1, m.shadow!.opacity / 100, (0.75 + (m.shadow!.soft / 100) * 20) / SM, (1.5 * 3.5 * sc.ext) / SM);
    } else gl.uniform4f(this.u.uSh, 0, 0, 0, 0);
    const col = m.color ? [parseInt(m.color.slice(1, 3), 16) / 255, parseInt(m.color.slice(3, 5), 16) / 255, parseInt(m.color.slice(5, 7), 16) / 255, 1] : [0, 0, 0, 0];
    gl.uniform4f(this.u.uCol, col[0], col[1], col[2], col[3]);
    gl.uniform4fv(this.u.uMat, MATERIALS[m.material]);
    gl.uniform1f(this.u.uAmb, m.light.ambient / 100);
    gl.uniform1f(this.u.uStr, m.light.strength / 100);
    gl.uniform1i(this.u.uKind, r.kind);
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
    gl.uniform2f(this.u.uProf, mesh.profile?.[0] ?? 0, mesh.profile?.[1] ?? 0);
    gl.uniform1i(this.u.uPass, 0);
    gl.drawElements(gl.TRIANGLES, mesh.count, gl.UNSIGNED_INT, 0);
    // The faces' soft edges, blended over what's already drawn behind them (without hiding anything else).
    gl.uniform1i(this.u.uPass, 1);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.depthFunc(gl.LEQUAL);
    gl.depthMask(false);
    gl.drawElements(gl.TRIANGLES, mesh.count, gl.UNSIGNED_INT, 0);
    gl.depthMask(true);
    gl.disable(gl.BLEND);
    gl.disable(gl.DEPTH_TEST);
    gl.activeTexture(gl.TEXTURE0);
    return { canvas: this.canvas, box };
  }
}

const engine = new ModelGL();

/** A rendered 3D layer: the object and its box (layer pixels), and with shadows, its shadow behind it, the same way. */
export interface ModelRender { canvas: HTMLCanvasElement; box: Rect; shadow?: { canvas: HTMLCanvasElement; box: Rect } }

const outCache = new Map<string, ModelRender>();
const wallCache = new Map<string, NonNullable<ModelRender['shadow']>>();

/**
 * The rendered 3D layer (copies that stay valid); cached by its settings and the output resolution (a power of two, so
 * zooming reuses it). Its shadow is a separate, smaller image (it's soft, and mostly empty space), to be drawn
 * stretched to its box under the object. `depth`: its depth map instead (nearest white, farthest dark grey), no
 * shadow. `texture` is the image of its texture (m.texture.key), if it has one. Null if WebGL2 isn't available.
 */
export function renderModel(src: HTMLCanvasElement, m: Model3D, key: string, scale: number, depth = false, texture?: HTMLCanvasElement | null): ModelRender | null {
  const s = 2 ** Math.ceil(Math.log2(Math.max(0.125, Math.min(4, scale))));
  const ck = `${key}|${src.width}x${src.height}|${JSON.stringify(m)}|${s}|${depth}|${!!texture}`;
  const hit = outCache.get(ck);
  if (hit) return hit;
  let shadow: ModelRender['shadow'];
  if (!depth && m.shadow?.on) {
    // (The shadow only depends on the shape, its turn, the light's place and the shadow settings: changing the
    // colour, finish or texture keeps it.)
    const L = m.light;
    const wk = `${key}|${src.width}x${src.height}|${m.kind}|${m.depth}|${m.round}|${m.bevel}|${m.axis}|${m.rotX},${m.rotY},${m.rotZ}|${L.az},${L.el},${L.kind},${L.dist},${L.follow}|${JSON.stringify(m.shadow)}|${s}`;
    shadow = wallCache.get(wk);
    const wall = shadow ? null : engine.renderWall(src, m, key, s);
    if (wall) {
      const c = document.createElement('canvas');
      c.width = wall.w; c.height = wall.h;
      c.getContext('2d')!.drawImage(engine.canvas, 0, 0, wall.w, wall.h, 0, 0, wall.w, wall.h);
      shadow = { canvas: c, box: wall.box };
      if (wallCache.size > 24) wallCache.clear();
      wallCache.set(wk, shadow);
    }
  }
  const r = engine.render(src, m, key, s, depth, texture);
  if (!r) return null;
  if (outCache.size > 24) outCache.clear();
  const c = document.createElement('canvas');
  c.width = r.canvas.width; c.height = r.canvas.height;
  c.getContext('2d')!.drawImage(r.canvas, 0, 0);
  const out = { canvas: c, box: r.box, shadow };
  outCache.set(ck, out);
  return out;
}

/** A rendered 3D layer as one image (its shadow under it) and its box, at the object's resolution. */
export function flattenRender(r: ModelRender): { canvas: HTMLCanvasElement; box: Rect } {
  if (!r.shadow) return r;
  const k = r.canvas.width / r.box.w, b = r.box, sb = r.shadow.box;
  const x0 = Math.min(b.x, sb.x), y0 = Math.min(b.y, sb.y), x1 = Math.max(b.x + b.w, sb.x + sb.w), y1 = Math.max(b.y + b.h, sb.y + sb.h);
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round((x1 - x0) * k)); c.height = Math.max(1, Math.round((y1 - y0) * k));
  const x = c.getContext('2d')!;
  x.imageSmoothingQuality = 'high';
  x.drawImage(r.shadow.canvas, (sb.x - x0) * k, (sb.y - y0) * k, sb.w * k, sb.h * k);
  x.drawImage(r.canvas, (b.x - x0) * k, (b.y - y0) * k, b.w * k, b.h * k);
  return { canvas: c, box: { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } };
}

/** The 3D layer's box (layer pixels) without rendering it: its shadow included, or the object alone. */
export function modelBox(src: HTMLCanvasElement, m: Model3D, key: string, withShadow = true): Rect {
  return frameOf(src.width, src.height, m, meshFor(src, m, key), withShadow);
}

/**
 * For placing the light by dragging (layer pixels): the point the object turns around, and how far out the light's
 * ring is drawn. A light straight on is at the middle, and one level with the picture on the ring; the direction around
 * is the light's direction.
 */
export function lightRing(src: HTMLCanvasElement, m: Model3D, key: string): { x: number; y: number; r: number } {
  const mesh = meshFor(src, m, key), b = boundsOf(src.width, src.height, m, mesh);
  return { x: pivotX(src.width, m), y: src.height / 2, r: Math.max(24, Math.max(b.w, b.h) * 0.6) };
}

/**
 * Which way the light comes from as seen (x right, y down, z toward the viewer): its own direction, or with Turns with
 * object, that direction turned with the object.
 */
export function lightSeen(m: Model3D): V3 {
  const el = m.light.el * D2R, az = m.light.az * D2R;
  const d: V3 = [Math.cos(el) * Math.cos(az), -Math.cos(el) * Math.sin(az), Math.sin(el)];
  if (!m.light.follow) return d;
  const R = rotation(m);
  return [R[0] * d[0] + R[1] * d[1] + R[2] * d[2], R[3] * d[0] + R[4] * d[1] + R[5] * d[2], R[6] * d[0] + R[7] * d[1] + R[8] * d[2]];
}

/**
 * The light's direction and height from where it's seen to come from (as lightSeen): back into the object's own
 * frame with Turns with object. Height stays 0-90 (a light from behind is put level with the picture).
 */
export function lightFromSeen(m: Model3D, d: V3): { az: number; el: number } {
  let v = d;
  if (m.light.follow) {
    // The turn's inverse is its transpose.
    const R = rotation(m);
    v = [R[0] * d[0] + R[3] * d[1] + R[6] * d[2], R[1] * d[0] + R[4] * d[1] + R[7] * d[2], R[2] * d[0] + R[5] * d[1] + R[8] * d[2]];
  }
  const az = ((Math.atan2(-v[1], v[0]) / D2R) + 360) % 360;
  const el = Math.max(0, Math.asin(Math.max(-1, Math.min(1, v[2]))) / D2R);
  return { az: Math.round(az), el: Math.round(el) };
}
