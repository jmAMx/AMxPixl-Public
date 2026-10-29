import type { Rect } from './math';

/**
 * 3D layers: an image layer can carry a `model`, turning its picture into a lit 3D object that renders in place of
 * the flat pixels. Inflate puffs the picture's silhouette out on both sides, like a balloon or a pillow, with the
 * picture on the front. Rendered on the GPU (WebGL2) and kept as settings, so it stays editable.
 */
export interface Model3D {
  kind: 'inflate';
  /** How far it puffs out: 100 makes the thickest part as deep as it is wide (round, like a tube or a ball). */
  depth: number;
  /** 100 = round all the way across; lower = rounded edges with a flatter face. */
  round: number;
  /** Turn, in degrees, about the horizontal (x), vertical (y) and facing (z) axes. */
  rotX: number; rotY: number; rotZ: number;
  /** Light direction (azimuth 0-360 measured from the right, counterclockwise; elevation 0-90 above the surface), strength and ambient light (0-100). */
  light: { az: number; el: number; strength: number; ambient: number };
  material: 'matte' | 'plastic' | 'metal';
  /** A solid colour, or null to use the layer's own picture. */
  color: string | null;
}

export const defaultModel = (): Model3D => ({
  kind: 'inflate', depth: 60, round: 70, rotX: -18, rotY: 24, rotZ: 0,
  light: { az: 135, el: 45, strength: 100, ambient: 35 }, material: 'plastic', color: null,
});

// ---------- geometry ----------

const D2R = Math.PI / 180;

/** Rotation (x, then y, then z) as a 3x3 matrix, row-major. */
function rotation(m: Model3D): number[] {
  const [ax, ay, az] = [m.rotX * D2R, m.rotY * D2R, m.rotZ * D2R];
  const cx = Math.cos(ax), sx = Math.sin(ax), cy = Math.cos(ay), sy = Math.sin(ay), cz = Math.cos(az), sz = Math.sin(az);
  const X = [1, 0, 0, 0, cx, -sx, 0, sx, cx], Y = [cy, 0, sy, 0, 1, 0, -sy, 0, cy], Z = [cz, -sz, 0, sz, cz, 0, 0, 0, 1];
  const mul = (a: number[], b: number[]) => [0, 1, 2].flatMap((r) => [0, 1, 2].map((c) => a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c]));
  return mul(Z, mul(Y, X));
}

/** The height field of an inflated silhouette: grid size, cell size, heights (front; the back mirrors it). */
interface Field { gw: number; gh: number; cx: number; cy: number; h: Float32Array; depth: number }
const fieldCache = new Map<string, Field>();

function heightField(src: HTMLCanvasElement, m: Model3D, key: string): Field {
  const ck = `${key}|${src.width}x${src.height}|${m.depth}|${m.round}`;
  const hit = fieldCache.get(ck);
  if (hit) return hit;
  if (fieldCache.size > 16) fieldCache.clear();
  const W = src.width, H = src.height;
  // A grid of samples over the picture: about every 2.5 pixels, between 64 and 320 along the long side.
  const cell = Math.max(W, H) / Math.min(320, Math.max(64, Math.max(W, H) / 2.5));
  const gw = Math.max(2, Math.round(W / cell) + 1), gh = Math.max(2, Math.round(H / cell) + 1);
  const c = document.createElement('canvas'); c.width = gw; c.height = gh;
  const x = c.getContext('2d', { willReadFrequently: true })!;
  x.drawImage(src, 0, 0, gw, gh);
  const a = x.getImageData(0, 0, gw, gh).data;
  // Exact distance from the edge, inside the silhouette (in cells), so curves come out round, not faceted.
  const inside = new Uint8Array(gw * gh);
  for (let i = 0; i < gw * gh; i++) inside[i] = a[i * 4 + 3] >= 128 ? 1 : 0;
  const d = edt(inside, gw, gh);
  let maxD = 0;
  for (let i = 0; i < d.length; i++) if (d[i] > maxD) maxD = d[i];
  // A rounded profile: steep at the edge, levelling off toward the middle (flatter for lower Roundness).
  const radius = Math.max(1, maxD - 0.5), rr = radius * (0.15 + 0.85 * (m.round / 100));
  const depth = (m.depth / 100) * radius * cell;
  let h = new Float32Array(gw * gh);
  for (let i = 0; i < d.length; i++) {
    const u = Math.min(1, Math.max(0, d[i] - 0.5) / rr);
    h[i] = inside[i] ? depth * Math.sqrt(Math.max(0, 1 - (1 - u) * (1 - u))) : 0;
  }
  // Soften the crease where the distances from opposite edges meet (the middle of a stroke) into a smooth crown.
  for (let pass = 0; pass < 3; pass++) {
    const s = new Float32Array(h.length);
    for (let j = 0; j < gh; j++) for (let i = 0; i < gw; i++) {
      const k = j * gw + i;
      if (!inside[k]) continue;
      let sum = 0, n = 0;
      for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
        const ii = i + di, jj = j + dj;
        if (ii < 0 || jj < 0 || ii >= gw || jj >= gh) continue;
        sum += h[jj * gw + ii]; n++;
      }
      // Near the edge keep the steep rise; only the inside is smoothed.
      s[k] = d[k] > 1.5 ? sum / n : h[k];
    }
    h = s;
  }
  const f = { gw, gh, cx: W / (gw - 1), cy: H / (gh - 1), h, depth };
  fieldCache.set(ck, f);
  return f;
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

/** Camera distance, as a multiple of the picture's size (gentle perspective). */
const CAM = 4;

/** Where a layer pixel (x, y) at height z lands after turning, around the picture's centre. */
function projector(W: number, H: number, m: Model3D) {
  const R = rotation(m), cx = W / 2, cy = H / 2, f = CAM * Math.max(W, H);
  return (x: number, y: number, z: number) => {
    const px = x - cx, py = y - cy;
    const X = R[0] * px + R[1] * py + R[2] * z, Y = R[3] * px + R[4] * py + R[5] * z, Z = R[6] * px + R[7] * py + R[8] * z;
    const k = f / (f - Z);
    return { x: cx + X * k, y: cy + Y * k, z: Z };
  };
}

/** The 3D layer's box in its own pixels for the current turn (it can reach past the flat picture). */
export function modelBounds(W: number, H: number, m: Model3D, depth = (m.depth / 100) * Math.min(W, H) * 0.5): Rect {
  const P = projector(W, H, m);
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const x of [0, W]) for (const y of [0, H]) for (const z of [-depth, depth]) {
    const p = P(x, y, z);
    x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y);
  }
  return { x: Math.floor(x0) - 2, y: Math.floor(y0) - 2, w: Math.ceil(x1 - x0) + 4, h: Math.ceil(y1 - y0) + 4 };
}

// ---------- rendering ----------

const VS = `#version 300 es
in vec3 aPos; in vec3 aNrm;
uniform mat3 uR; uniform vec2 uC; uniform float uF; uniform vec4 uBox; uniform float uZr; uniform vec2 uSize;
out vec3 vN; out vec2 vUV;
void main() {
  vec3 p = uR * vec3(aPos.xy - uC, aPos.z);
  float k = uF / (uF - p.z);
  vec2 s = uC + p.xy * k;
  vN = uR * aNrm;
  vUV = aPos.xy / uSize;
  gl_Position = vec4((s.x - uBox.x) / uBox.z * 2.0 - 1.0, 1.0 - (s.y - uBox.y) / uBox.w * 2.0, -p.z / uZr, 1.0);
}`;
const FS = `#version 300 es
precision highp float;
in vec3 vN; in vec2 vUV; out vec4 o;
uniform sampler2D uTex; uniform vec3 uL; uniform vec4 uCol; uniform vec4 uMat; uniform float uAmb; uniform float uStr;
void main() {
  vec4 t = texture(uTex, vUV);
  float a = smoothstep(0.3, 0.7, t.a);
  if (a < 0.01) discard;
  vec3 base = uCol.a > 0.5 ? uCol.rgb : t.rgb / max(t.a, 1e-4);
  vec3 N = normalize(vN);
  float diff = max(dot(N, uL), 0.0);
  vec3 H = normalize(uL + vec3(0.0, 0.0, 1.0));
  float spec = pow(max(dot(N, H), 0.0), uMat.z) * uMat.y;
  // uMat: x diffuse weight, y specular weight, z shininess, w metal (specular takes the surface colour).
  vec3 specCol = mix(vec3(1.0), base, uMat.w);
  vec3 c = base * (uAmb + uMat.x * diff * uStr) + specCol * spec * uStr;
  o = vec4(c * a, a);
}`;

const MATERIALS = { matte: [1, 0, 1, 0], plastic: [1, 0.45, 40, 0], metal: [0.35, 1, 60, 1] } as const;

class ModelGL {
  readonly canvas = document.createElement('canvas');
  private gl: WebGL2RenderingContext | null = null;
  private prog: WebGLProgram | null = null;
  private tex: WebGLTexture | null = null;
  private texKey = '';
  private buf: WebGLBuffer | null = null;
  private meshKey = '';
  private count = 0;
  private u: Record<string, WebGLUniformLocation | null> = {};

  private init() {
    if (this.gl) return this.gl;
    const gl = this.canvas.getContext('webgl2', { premultipliedAlpha: true, antialias: true, preserveDrawingBuffer: true });
    if (!gl) return null;
    const sh = (type: number, src: string) => { const s = gl.createShader(type)!; gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) console.error(gl.getShaderInfoLog(s)); return s; };
    const p = gl.createProgram()!;
    gl.attachShader(p, sh(gl.VERTEX_SHADER, VS));
    gl.attachShader(p, sh(gl.FRAGMENT_SHADER, FS));
    gl.bindAttribLocation(p, 0, 'aPos');
    gl.bindAttribLocation(p, 1, 'aNrm');
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) { console.error('3D shader failed', gl.getProgramInfoLog(p)); return null; }
    for (const n of ['uR', 'uC', 'uF', 'uBox', 'uZr', 'uSize', 'uTex', 'uL', 'uCol', 'uMat', 'uAmb', 'uStr']) this.u[n] = gl.getUniformLocation(p, n);
    this.tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.buf = gl.createBuffer();
    this.gl = gl;
    this.prog = p;
    return gl;
  }

  /** Front and back surfaces of the height field as triangles: position (x, y, z) and normal per vertex. */
  private mesh(gl: WebGL2RenderingContext, f: Field, key: string) {
    if (this.meshKey === key) return;
    const { gw, gh, cx, cy, h } = f;
    const H = (i: number, j: number) => h[Math.min(gh - 1, Math.max(0, j)) * gw + Math.min(gw - 1, Math.max(0, i))];
    const vert = (i: number, j: number, side: 1 | -1) => {
      const dx = (H(i + 1, j) - H(i - 1, j)) / (2 * cx), dy = (H(i, j + 1) - H(i, j - 1)) / (2 * cy);
      const n = [-dx * side, -dy * side, side], l = Math.hypot(n[0], n[1], n[2]);
      return [i * cx, j * cy, H(i, j) * side, n[0] / l, n[1] / l, n[2] / l];
    };
    const data: number[] = [];
    for (const side of [1, -1] as const) {
      for (let j = 0; j < gh - 1; j++) for (let i = 0; i < gw - 1; i++) {
        // Skip cells entirely outside the silhouette.
        if (!H(i, j) && !H(i + 1, j) && !H(i, j + 1) && !H(i + 1, j + 1)) {
          if (!(H(i - 1, j) || H(i + 2, j) || H(i, j - 1) || H(i, j + 2))) continue;
        }
        const a = vert(i, j, side), b = vert(i + 1, j, side), c = vert(i, j + 1, side), d = vert(i + 1, j + 1, side);
        data.push(...a, ...b, ...c, ...b, ...d, ...c);
      }
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(data), gl.STATIC_DRAW);
    this.count = data.length / 6;
    this.meshKey = key;
  }

  /** The 3D layer drawn into its box (layer pixels) at `scale` output pixels per layer pixel. */
  render(src: HTMLCanvasElement, m: Model3D, key: string, scale: number): { canvas: HTMLCanvasElement; box: Rect } | null {
    const gl = this.init();
    if (!gl || !this.prog) return null;
    const W = src.width, H = src.height;
    const f = heightField(src, m, key);
    const box = modelBounds(W, H, m, f.depth);
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
    this.mesh(gl, f, `${key}|${W}x${H}|${m.depth}|${m.round}`);
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    const tk = `${key}|${W}x${H}`;
    if (this.texKey !== tk) {
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
      this.texKey = tk;
    }
    const R = rotation(m);
    // GLSL mat3 is column-major: pass the transpose of the row-major rotation.
    gl.uniformMatrix3fv(this.u.uR, false, [R[0], R[3], R[6], R[1], R[4], R[7], R[2], R[5], R[8]]);
    gl.uniform2f(this.u.uC, W / 2, H / 2);
    gl.uniform1f(this.u.uF, CAM * Math.max(W, H));
    gl.uniform4f(this.u.uBox, box.x, box.y, box.w, box.h);
    gl.uniform1f(this.u.uZr, Math.hypot(W, H) + f.depth * 2);
    gl.uniform2f(this.u.uSize, W, H);
    gl.uniform1i(this.u.uTex, 0);
    const el = m.light.el * D2R, az = m.light.az * D2R;
    gl.uniform3f(this.u.uL, Math.cos(el) * Math.cos(az), -Math.cos(el) * Math.sin(az), Math.sin(el));
    const col = m.color ? [parseInt(m.color.slice(1, 3), 16) / 255, parseInt(m.color.slice(3, 5), 16) / 255, parseInt(m.color.slice(5, 7), 16) / 255, 1] : [0, 0, 0, 0];
    gl.uniform4f(this.u.uCol, col[0], col[1], col[2], col[3]);
    gl.uniform4fv(this.u.uMat, MATERIALS[m.material]);
    gl.uniform1f(this.u.uAmb, m.light.ambient / 100);
    gl.uniform1f(this.u.uStr, m.light.strength / 100);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buf);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 24, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 24, 12);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.drawArrays(gl.TRIANGLES, 0, this.count);
    gl.disable(gl.BLEND);
    gl.disable(gl.DEPTH_TEST);
    return { canvas: this.canvas, box };
  }
}

const engine = new ModelGL();
const outCache = new Map<string, { canvas: HTMLCanvasElement; box: Rect }>();

/**
 * The rendered 3D layer (a copy that stays valid) and its box in layer pixels; cached by its settings and the
 * output resolution (a power of two, so zooming reuses it). Null if WebGL2 isn't available.
 */
export function renderModel(src: HTMLCanvasElement, m: Model3D, key: string, scale: number): { canvas: HTMLCanvasElement; box: Rect } | null {
  const s = 2 ** Math.ceil(Math.log2(Math.max(0.125, Math.min(4, scale))));
  const ck = `${key}|${src.width}x${src.height}|${JSON.stringify(m)}|${s}`;
  const hit = outCache.get(ck);
  if (hit) return hit;
  const r = engine.render(src, m, key, s);
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
  return modelBounds(src.width, src.height, m, heightField(src, m, key).depth);
}
