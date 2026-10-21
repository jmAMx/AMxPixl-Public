import { fxDef, type FxDef, type FxEnv } from './effects';
import { ctx2d } from './layers';
import type { FxParams } from './types';

const VS = `#version 300 es
in vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }`;

/** Shared GLSL for every effect: coordinate helpers (output <-> document pixels), sampling and noise. */
const PRELUDE = `#version 300 es
precision highp float;
out vec4 o;
uniform sampler2D uSrc;
uniform sampler2D uAux;
uniform vec2 uRes;
uniform float uScale;
uniform vec4 uDoc;
uniform float uSeed;
uniform vec4 uA, uB, uC;
uniform vec3 uCol1, uCol2;
vec2 fromDoc(vec2 d) { return uDoc.xy + d * uScale; }
vec2 toDoc(vec2 p) { return (p - uDoc.xy) / uScale; }
vec2 docSize() { return uDoc.zw / uScale; }
vec4 texOut(sampler2D s, vec2 p) { return texture(s, vec2(p.x / uRes.x, 1.0 - p.y / uRes.y)); }
vec4 src(vec2 p) { return texOut(uSrc, p); }
vec4 aux(vec2 p) { return texOut(uAux, p); }
vec4 srcDoc(vec2 d) { return texOut(uSrc, fromDoc(d)); }
float lum(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
float hash(vec2 q) {
  vec3 p3 = fract(vec3(q.xyx) * 0.1031 + uSeed * 0.0137);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float hash1(float n) { return hash(vec2(n, n * 1.618 + 7.0)); }
float vnoise(vec2 q) {
  vec2 i = floor(q), f = fract(q);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
}
`;

const MAIN = `
void main() {
  vec2 p = vec2(gl_FragCoord.x, uRes.y - gl_FragCoord.y);
  o = clamp(fx(p, toDoc(p)), 0.0, 1.0);
}`;

/** Keeps only the highlights above a threshold (soft knee), for bloom and halation. */
const EXTRACT = `
uniform float uThreshold;
vec4 fx(vec2 p, vec2 d) {
  vec4 c = src(p);
  float l = lum(c.rgb);
  float k = smoothstep(uThreshold, uThreshold + 0.15 + (1.0 - uThreshold) * 0.3, l);
  return vec4(c.rgb * k, c.a);
}`;

interface Prog { p: WebGLProgram; u: Map<string, WebGLUniformLocation | null> }

/** Runs effect layers on the GPU (WebGL2). Blurs for glow-type effects use the canvas's GPU blur at reduced size. */
class FXEngine {
  readonly canvas = document.createElement('canvas');
  private gl: WebGL2RenderingContext | null = null;
  private progs = new Map<string, Prog | null>();
  private srcTex!: WebGLTexture;
  private auxTex!: WebGLTexture;
  private blur = document.createElement('canvas');
  private stage = document.createElement('canvas');
  maxSize = 4096;

  constructor() {
    this.canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); this.gl = null; });
    this.canvas.addEventListener('webglcontextrestored', () => this.init());
    this.init();
  }

  get ok() { return !!this.gl; }

  private init() {
    const gl = this.canvas.getContext('webgl2', { premultipliedAlpha: false, preserveDrawingBuffer: true, antialias: false });
    if (!gl) return;
    this.gl = gl;
    this.progs.clear();
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    const tex = () => {
      const t = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      return t;
    };
    this.srcTex = tex();
    this.auxTex = tex();
    this.maxSize = gl.getParameter(gl.MAX_TEXTURE_SIZE);
  }

  private program(key: string, body: string): Prog | null {
    if (this.progs.has(key)) return this.progs.get(key)!;
    const gl = this.gl!;
    const sh = (type: number, srcText: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, srcText);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(`${key}: ${gl.getShaderInfoLog(s)}`);
      return s;
    };
    let prog: Prog | null = null;
    try {
      const p = gl.createProgram()!;
      gl.attachShader(p, sh(gl.VERTEX_SHADER, VS));
      gl.attachShader(p, sh(gl.FRAGMENT_SHADER, PRELUDE + body + MAIN));
      gl.bindAttribLocation(p, 0, 'aPos');
      gl.linkProgram(p);
      if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(`${key}: ${gl.getProgramInfoLog(p)}`);
      prog = { p, u: new Map() };
      for (const n of ['uSrc', 'uAux', 'uRes', 'uScale', 'uDoc', 'uSeed', 'uA', 'uB', 'uC', 'uCol1', 'uCol2', 'uThreshold']) prog.u.set(n, gl.getUniformLocation(p, n));
    } catch (err) {
      console.error('Effect shader failed', err);
    }
    this.progs.set(key, prog);
    return prog;
  }

  private upload(tex: WebGLTexture, img: TexImageSource, unit: number) {
    const gl = this.gl!;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  }

  private run(prog: Prog, w: number, h: number, env: FxEnv & { doc: [number, number, number, number] }, seed: number, uni: Record<string, number[]>) {
    const gl = this.gl!;
    gl.viewport(0, 0, w, h);
    gl.useProgram(prog.p);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.srcTex);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.auxTex);
    gl.uniform1i(prog.u.get('uSrc')!, 0);
    gl.uniform1i(prog.u.get('uAux')!, 1);
    gl.uniform2f(prog.u.get('uRes')!, w, h);
    gl.uniform1f(prog.u.get('uScale')!, env.scale);
    gl.uniform4f(prog.u.get('uDoc')!, ...env.doc);
    gl.uniform1f(prog.u.get('uSeed')!, seed % 1000);
    for (const [k, v] of Object.entries(uni)) {
      const loc = prog.u.get(k);
      if (!loc) continue;
      if (v.length === 1) gl.uniform1f(loc, v[0]);
      else if (v.length === 3) gl.uniform3f(loc, v[0], v[1], v[2]);
      else gl.uniform4f(loc, v[0], v[1], v[2], v[3]);
    }
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  /** Blurs `img` by `radius` output pixels, working at reduced size for big radii (it's a soft glow anyway). */
  private blurred(img: HTMLCanvasElement, radius: number) {
    const down = radius > 24 ? 4 : radius > 6 ? 2 : 1;
    const w = Math.max(1, Math.ceil(img.width / down)), h = Math.max(1, Math.ceil(img.height / down));
    if (this.blur.width !== w || this.blur.height !== h) { this.blur.width = w; this.blur.height = h; }
    const x = ctx2d(this.blur);
    x.save();
    x.clearRect(0, 0, w, h);
    x.filter = `blur(${Math.max(0.01, radius / down)}px)`;
    x.drawImage(img, 0, 0, w, h);
    x.restore();
    return this.blur;
  }

  /**
   * Applies an effect to `src`. `docRect` is the document's rectangle in `src` pixels and `scale` how many of
   * those pixels one document pixel covers. Returns a canvas the same size as `src`, or null if unavailable.
   */
  apply(src: HTMLCanvasElement, fx: FxParams, scale: number, docRect: { x: number; y: number; w: number; h: number }): HTMLCanvasElement | null {
    const def: FxDef | undefined = fxDef(fx.kind);
    if (!def || !this.gl || src.width > this.maxSize || src.height > this.maxSize) return null;
    const prog = this.program(def.kind, def.glsl);
    if (!prog) return null;
    const w = src.width, h = src.height;
    if (this.canvas.width !== w || this.canvas.height !== h) { this.canvas.width = w; this.canvas.height = h; }
    const env = { scale, doc: [docRect.x, docRect.y, docRect.w, docRect.h] as [number, number, number, number] };
    this.upload(this.srcTex, src, 0);
    if (def.aux) {
      const radius = Math.max(0.5, def.aux.radius(fx.v) * scale);
      let auxSrc: HTMLCanvasElement = src;
      const thr = def.aux.threshold?.(fx.v);
      if (thr !== undefined) {
        const ex = this.program('__extract', EXTRACT);
        if (!ex) return null;
        this.run(ex, w, h, env, fx.seed, { uThreshold: [thr] });
        // Copy out of the GL canvas before it's reused for the final pass.
        if (this.stage.width !== w || this.stage.height !== h) { this.stage.width = w; this.stage.height = h; }
        const sx = ctx2d(this.stage);
        sx.clearRect(0, 0, w, h);
        sx.drawImage(this.canvas, 0, 0);
        auxSrc = this.stage;
      }
      this.upload(this.auxTex, this.blurred(auxSrc, radius), 1);
    }
    const uni = def.uniforms(fx.v) as Record<string, number[]>;
    this.run(prog, w, h, env, fx.seed, uni);
    return this.canvas;
  }
}

export const fxEngine = new FXEngine();
