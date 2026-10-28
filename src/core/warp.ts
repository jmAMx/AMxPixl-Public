import { apply, boundsOf, type Mat, type Pt, type Rect } from './math';
import type { Warp } from './types';

/** Projective map from the unit square to a quad (corners TL, TR, BR, BL). */
function homography(p: number[]) {
  const [x0, y0, x1, y1, x2, y2, x3, y3] = p;
  const dx1 = x1 - x2, dx2 = x3 - x2, dx3 = x0 - x1 + x2 - x3;
  const dy1 = y1 - y2, dy2 = y3 - y2, dy3 = y0 - y1 + y2 - y3;
  let g = 0, h = 0;
  if (Math.abs(dx3) > 1e-9 || Math.abs(dy3) > 1e-9) {
    const den = dx1 * dy2 - dx2 * dy1 || 1e-9;
    g = (dx3 * dy2 - dx2 * dy3) / den;
    h = (dx1 * dy3 - dx3 * dy1) / den;
  }
  const a = x1 - x0 + g * x1, b = x3 - x0 + h * x3, c = x0;
  const d = y1 - y0 + g * y1, e = y3 - y0 + h * y3, f = y0;
  return (u: number, v: number): Pt => {
    const w = g * u + h * v + 1;
    return { x: (a * u + b * v + c) / w, y: (d * u + e * v + f) / w };
  };
}

const cr = (p0: number, p1: number, p2: number, p3: number, t: number) =>
  0.5 * (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t * t + (-p0 + 3 * p1 - 3 * p2 + p3) * t * t * t);

/** Smooth curve through a row of points (Catmull-Rom, extended past the ends). */
function curve(xs: number[], s: number) {
  const n = xs.length;
  const x = s * (n - 1);
  const k = Math.min(Math.max(0, Math.floor(x)), n - 2);
  const t = x - k;
  const at = (i: number) => (i < 0 ? 2 * xs[0] - xs[1] : i >= n ? 2 * xs[n - 1] - xs[n - 2] : xs[i]);
  return cr(at(k - 1), at(k), at(k + 1), at(k + 2), t);
}

/** Where the point (u, v) of the original layer (0..1 each way) ends up, in the layer's own pixels. */
export function warpPoint(w: Warp, u: number, v: number): Pt {
  if (w.kind === 'perspective') return homography(w.pts)(u, v);
  const n = w.n;
  const colX: number[] = [], colY: number[] = [];
  for (let i = 0; i < n; i++) {
    const rx: number[] = [], ry: number[] = [];
    for (let j = 0; j < n; j++) { rx.push(w.pts[(i * n + j) * 2]); ry.push(w.pts[(i * n + j) * 2 + 1]); }
    colX.push(curve(rx, u));
    colY.push(curve(ry, u));
  }
  return { x: curve(colX, v), y: curve(colY, v) };
}

/** Bounding box of a warped layer, sampled along its edges. */
export function warpBounds(w: Warp): Rect {
  const pts: Pt[] = [];
  const N = 24;
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    pts.push(warpPoint(w, t, 0), warpPoint(w, t, 1), warpPoint(w, 0, t), warpPoint(w, 1, t));
  }
  return boundsOf(pts);
}

/** A fresh warp of `kind` covering `box`, or continuing from `prev` so switching modes keeps the current shape. */
export function initWarp(kind: Warp['kind'], box: Rect, prev?: Warp | null): Warp {
  const at = (u: number, v: number): Pt => (prev ? warpPoint(prev, u, v) : { x: box.x + u * box.w, y: box.y + v * box.h });
  if (kind === 'perspective') {
    const c = [at(0, 0), at(1, 0), at(1, 1), at(0, 1)];
    return { kind, n: 2, pts: c.flatMap((p) => [p.x, p.y]) };
  }
  const n = 4;
  const pts: number[] = [];
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) { const p = at(j / (n - 1), i / (n - 1)); pts.push(p.x, p.y); }
  return { kind, n, pts };
}

/** Control points of a warp as {u, v, x, y} handles (in layer pixels). */
export function warpHandles(w: Warp): { i: number; x: number; y: number }[] {
  const out = [];
  for (let i = 0; i < w.pts.length / 2; i++) out.push({ i, x: w.pts[i * 2], y: w.pts[i * 2 + 1] });
  return out;
}

const VS = `#version 300 es
in vec2 aPos; in vec2 aUV;
uniform vec2 uRes;
out vec2 vUV;
void main() { vUV = aUV; gl_Position = vec4(aPos.x / uRes.x * 2.0 - 1.0, 1.0 - aPos.y / uRes.y * 2.0, 0.0, 1.0); }`;
const FS = `#version 300 es
precision highp float;
in vec2 vUV; out vec4 o;
uniform sampler2D uTex;
void main() { o = texture(uTex, vUV); }`;

/** Draws warped layers as a finely subdivided textured mesh on the GPU. */
class WarpGL {
  readonly canvas = document.createElement('canvas');
  private gl: WebGL2RenderingContext | null = null;
  private prog: WebGLProgram | null = null;
  private tex: WebGLTexture | null = null;
  private buf: WebGLBuffer | null = null;
  private uRes: WebGLUniformLocation | null = null;

  constructor() {
    this.canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); this.gl = null; });
    this.canvas.addEventListener('webglcontextrestored', () => this.init());
    this.init();
  }

  private init() {
    const gl = this.canvas.getContext('webgl2', { premultipliedAlpha: true, preserveDrawingBuffer: true, antialias: true });
    if (!gl) return;
    const sh = (type: number, src: string) => { const s = gl.createShader(type)!; gl.shaderSource(s, src); gl.compileShader(s); return s; };
    const p = gl.createProgram()!;
    gl.attachShader(p, sh(gl.VERTEX_SHADER, VS));
    gl.attachShader(p, sh(gl.FRAGMENT_SHADER, FS));
    gl.bindAttribLocation(p, 0, 'aPos');
    gl.bindAttribLocation(p, 1, 'aUV');
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) { console.error('Warp shader failed', gl.getProgramInfoLog(p)); return; }
    this.gl = gl;
    this.prog = p;
    this.uRes = gl.getUniformLocation(p, 'uRes');
    this.buf = gl.createBuffer();
    this.tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }

  /**
   * Draws `img` warped by `w` through `m` (layer pixels -> target pixels) onto `ctx`, respecting the context's alpha
   * and blend mode. `img` may be a reduced preview: scaled up by `f` it covers the layer's `fullW` x `fullH` pixels.
   */
  draw(ctx: CanvasRenderingContext2D, img: HTMLCanvasElement, f: number, fullW: number, fullH: number, w: Warp, m: Mat) {
    this.drawMapped(ctx, img, f, fullW, fullH, (u, v) => warpPoint(w, u, v), m, w.kind === 'perspective' ? 20 : 28);
  }

  /**
   * Like draw, for any smooth mapping: `map(u, v)` says where the point (u, v) of the image (0..1 each way) lands in
   * the layer's pixels. Used for warp presets on text and shapes.
   */
  drawMapped(ctx: CanvasRenderingContext2D, img: HTMLCanvasElement, f: number, fullW: number, fullH: number, map: (u: number, v: number) => Pt, m: Mat, G = 32) {
    const gl = this.gl;
    if (!gl || !this.prog) return;
    const W = ctx.canvas.width, H = ctx.canvas.height;
    if (this.canvas.width !== W || this.canvas.height !== H) { this.canvas.width = W; this.canvas.height = H; }
    // A reduced preview (rounded up when halving) can extend slightly past the layer's real pixels.
    const su = fullW / (img.width * f), sv = fullH / (img.height * f);
    const pos: Pt[] = [];
    for (let i = 0; i <= G; i++) for (let j = 0; j <= G; j++) {
      const p = map(j / G, i / G);
      pos.push(apply(m, p.x, p.y));
    }
    const data = new Float32Array(G * G * 6 * 4);
    let k = 0;
    const put = (i: number, j: number) => {
      const p = pos[i * (G + 1) + j];
      data[k++] = p.x; data[k++] = p.y; data[k++] = (j / G) * su; data[k++] = (i / G) * sv;
    };
    for (let i = 0; i < G; i++) for (let j = 0; j < G; j++) {
      put(i, j); put(i, j + 1); put(i + 1, j);
      put(i, j + 1); put(i + 1, j + 1); put(i + 1, j);
    }
    gl.viewport(0, 0, W, H);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(this.prog);
    gl.uniform2f(this.uRes, W, H);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buf);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STREAM_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 16, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 16, 8);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.drawArrays(gl.TRIANGLES, 0, G * G * 6);
    gl.disable(gl.BLEND);
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(this.canvas, 0, 0);
    ctx.restore();
  }
}

export const warpGL = new WarpGL();
