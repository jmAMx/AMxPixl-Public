import { fxDef, type FxDef, type FxEnv } from './effects';
import { padEdges } from './filters';
import { glLimit, gpuRestored } from './gpu';
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
uniform sampler2D uDepth;
uniform vec2 uRes;
uniform float uScale;
uniform vec4 uDoc;
uniform float uSeed;
uniform float uTime;
uniform vec4 uA, uB, uC;
uniform vec3 uCol1, uCol2;
vec2 fromDoc(vec2 d) { return uDoc.xy + d * uScale; }
vec2 toDoc(vec2 p) { return (p - uDoc.xy) / uScale; }
vec2 docSize() { return uDoc.zw / uScale; }
vec4 texOut(sampler2D s, vec2 p) { return texture(s, vec2(p.x / uRes.x, 1.0 - p.y / uRes.y)); }
vec4 src(vec2 p) { return texOut(uSrc, p); }
vec4 aux(vec2 p) { return texOut(uAux, p); }
vec4 srcDoc(vec2 d) { return texOut(uSrc, fromDoc(d)); }
// The picture with positions kept on the canvas: past its edge, the edge pixels repeat.
vec4 srcC(vec2 p) { return src(clamp(p, fromDoc(vec2(0.0)) + 0.5, fromDoc(docSize()) - 0.5)); }
vec4 srcDocC(vec2 d) { return srcC(fromDoc(d)); }
// For averaging colours where some are see-through: add them premultiplied, then divide out.
vec4 pm(vec4 c) { return vec4(c.rgb * c.a, c.a); }
vec4 unpm(vec4 c) { return c.a > 1e-5 ? vec4(c.rgb / c.a, c.a) : vec4(0.0); }
float lum(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
// The depth map (0 far, 1 near) at an output pixel; only set for effects that use depth.
float depth(vec2 p) { return lum(texOut(uDepth, p).rgb); }
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
// Layered noise (0..1, around 0.5): \`oct\` layers, each twice as fine and half as strong.
float fbm(vec2 q, float oct) {
  float s = 0.0, a = 0.5, t = 0.0;
  for (int i = 0; i < 8; i++) {
    if (float(i) >= oct) break;
    s += a * vnoise(q); t += a;
    q = q * 2.03 + 17.1; a *= 0.5;
  }
  return s / t;
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
  /** Why a shader didn't compile, by program key (for plugin effects, shown when one is installed). */
  private errors = new Map<string, string>();
  private srcTex!: WebGLTexture;
  private auxTex!: WebGLTexture;
  private depthTex!: WebGLTexture;
  private blur = document.createElement('canvas');
  private stage = document.createElement('canvas');
  private edged = document.createElement('canvas');
  private padded = document.createElement('canvas');
  private auxOut = document.createElement('canvas');
  private targets: { tex: WebGLTexture; fb: WebGLFramebuffer; w: number; h: number }[] = [];
  maxSize = 4096;

  constructor() {
    this.canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); this.gl = null; });
    this.canvas.addEventListener('webglcontextrestored', () => { this.init(); gpuRestored(); });
    this.init();
  }

  get ok() { return !!this.gl; }

  private init() {
    const gl = this.canvas.getContext('webgl2', { premultipliedAlpha: false, preserveDrawingBuffer: true, antialias: false });
    if (!gl) return;
    this.gl = gl;
    this.progs.clear();
    this.targets = [];
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
    this.depthTex = tex();
    this.maxSize = glLimit(gl);
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
      for (const n of ['uSrc', 'uAux', 'uDepth', 'uRes', 'uScale', 'uDoc', 'uSeed', 'uTime', 'uA', 'uB', 'uC', 'uCol1', 'uCol2', 'uThreshold']) prog.u.set(n, gl.getUniformLocation(p, n));
    } catch (err) {
      console.error('Effect shader failed', err);
      this.errors.set(key, String((err as Error)?.message ?? err));
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

  /** Pass `i`'s render target (two, used in turn) at w × h: a texture to draw into and read back in the next pass. */
  private target(i: number, w: number, h: number) {
    const gl = this.gl!;
    let t = this.targets[i];
    if (!t) {
      const tex = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      t = this.targets[i] = { tex, fb: gl.createFramebuffer()!, w: 0, h: 0 };
    }
    if (t.w !== w || t.h !== h) {
      gl.bindTexture(gl.TEXTURE_2D, t.tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.bindFramebuffer(gl.FRAMEBUFFER, t.fb);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t.tex, 0);
      t.w = w; t.h = h;
    }
    return t;
  }

  /**
   * Draws the effect into the canvas: in one go, or as a chain of passes (FxDef.passes) where each reads what the
   * one before drew. Their textures share the uploaded image's orientation, so `src` reads them the same way.
   */
  private draw(prog: Prog, w: number, h: number, env: FxEnv & { doc: [number, number, number, number]; time: number }, seed: number, uni: Record<string, number[]>, passes?: Record<string, number[]>[]) {
    const gl = this.gl!;
    if (!passes || passes.length < 2) { this.run(prog, w, h, env, seed, { ...uni, ...passes?.[0] }); return; }
    let read = this.srcTex;
    passes.forEach((p, i) => {
      const t = i < passes.length - 1 ? this.target(i % 2, w, h) : null;
      gl.bindFramebuffer(gl.FRAMEBUFFER, t ? t.fb : null);
      this.run(prog, w, h, env, seed, { ...uni, ...p }, read);
      if (t) read = t.tex;
    });
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  private run(prog: Prog, w: number, h: number, env: FxEnv & { doc: [number, number, number, number]; time: number }, seed: number, uni: Record<string, number[]>, srcTex = this.srcTex) {
    const gl = this.gl!;
    gl.viewport(0, 0, w, h);
    gl.useProgram(prog.p);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, srcTex);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.auxTex);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.depthTex);
    gl.uniform1i(prog.u.get('uSrc')!, 0);
    gl.uniform1i(prog.u.get('uAux')!, 1);
    const ud = prog.u.get('uDepth');
    if (ud) gl.uniform1i(ud, 2);
    gl.uniform2f(prog.u.get('uRes')!, w, h);
    gl.uniform1f(prog.u.get('uScale')!, env.scale);
    gl.uniform4f(prog.u.get('uDoc')!, ...env.doc);
    gl.uniform1f(prog.u.get('uSeed')!, seed % 1000);
    const tl = prog.u.get('uTime');
    if (tl) gl.uniform1f(tl, env.time);
    for (const [k, v] of Object.entries(uni)) {
      // (Plugin effects have uniforms of their own, one per setting: found the first time they're set.)
      if (!prog.u.has(k)) prog.u.set(k, gl.getUniformLocation(prog.p, k));
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

  /** Why `def`'s shader doesn't compile, or null if it does (or there's no graphics card to ask). */
  compileError(def: FxDef): string | null {
    if (!this.gl) return null;
    const key = progKey(def);
    return this.program(key, def.glsl) ? null : (this.errors.get(key) ?? 'it doesn\'t compile').replace(`${key}: `, '');
  }

  /** `img` with what's outside the canvas (`r`, in its pixels) filled by stretching the canvas's edge pixels out. */
  private clampToDoc(img: HTMLCanvasElement, r: { x: number; y: number; w: number; h: number }): HTMLCanvasElement {
    const W = img.width, H = img.height;
    const x0 = Math.max(0, Math.round(r.x)), y0 = Math.max(0, Math.round(r.y));
    const x1 = Math.min(W, Math.round(r.x + r.w)), y1 = Math.min(H, Math.round(r.y + r.h));
    if (x1 - x0 < 1 || y1 - y0 < 1 || (x0 === 0 && y0 === 0 && x1 === W && y1 === H)) return img;
    const c = this.edged;
    if (c.width !== W || c.height !== H) { c.width = W; c.height = H; }
    const x = ctx2d(c);
    x.save();
    x.imageSmoothingEnabled = false;
    x.clearRect(0, 0, W, H);
    x.drawImage(img, x0, y0, x1 - x0, y1 - y0, x0, y0, x1 - x0, y1 - y0);
    if (x0 > 0) x.drawImage(img, x0, y0, 1, y1 - y0, 0, y0, x0, y1 - y0);
    if (x1 < W) x.drawImage(img, x1 - 1, y0, 1, y1 - y0, x1, y0, W - x1, y1 - y0);
    // Then up and down from the rows already stretched sideways, which fills the corners too.
    if (y0 > 0) x.drawImage(c, 0, y0, W, 1, 0, 0, W, y0);
    if (y1 < H) x.drawImage(c, 0, y1 - 1, W, 1, 0, y1, W, H - y1);
    x.restore();
    return c;
  }

  /**
   * `img` blurred by `radius`, as if the canvas's edge pixels went on outward (beyond the canvas and beyond `img`
   * itself), so nothing fades in at the edges. Same reduced size as `blurred`.
   */
  private blurredClamped(img: HTMLCanvasElement, docRect: { x: number; y: number; w: number; h: number }, radius: number) {
    const base = this.clampToDoc(img, docRect);
    const down = radius > 24 ? 4 : radius > 6 ? 2 : 1;
    const pad = Math.ceil((radius * 3 + 2) / down) * down;
    const padded = padEdges(base, pad, this.padded);
    const b = this.blurred(padded, radius);
    const w = Math.max(1, Math.ceil(img.width / down)), h = Math.max(1, Math.ceil(img.height / down));
    const out = this.auxOut;
    if (out.width !== w || out.height !== h) { out.width = w; out.height = h; }
    const x = ctx2d(out);
    x.clearRect(0, 0, w, h);
    x.drawImage(b, pad / down, pad / down, w, h, 0, 0, w, h);
    return out;
  }

  /**
   * Applies an effect to `src`. `docRect` is the document's rectangle in `src` pixels and `scale` how many of
   * those pixels one document pixel covers. `time` (seconds) is where an animation is: with the effect's motion on,
   * textures re-roll and moving parts move. `depth` is the depth map, the same size as `src`, for effects that use it.
   * Returns a canvas the same size as `src`, or null if unavailable.
   */
  apply(src: HTMLCanvasElement, fx: FxParams, scale: number, docRect: { x: number; y: number; w: number; h: number }, time = 0, depth?: HTMLCanvasElement): HTMLCanvasElement | null {
    const def: FxDef | undefined = fxDef(fx.kind);
    if (!def || !this.gl || src.width > this.maxSize || src.height > this.maxSize) return null;
    const prog = this.program(progKey(def), def.glsl);
    if (!prog) return null;
    const w = src.width, h = src.height;
    if (this.canvas.width !== w || this.canvas.height !== h) { this.canvas.width = w; this.canvas.height = h; }
    const m = fx.motion?.on ? fx.motion : null;
    const env = { scale, doc: [docRect.x, docRect.y, docRect.w, docRect.h] as [number, number, number, number], time: m ? time * m.speed : 0 };
    // Random textures (grain, dust, glitches) change `flicker` times a second.
    const seed = m && def.seeded ? fx.seed + Math.floor(time * m.flicker) * 61 : fx.seed;
    this.upload(this.srcTex, src, 0);
    if (depth) this.upload(this.depthTex, depth, 2);
    if (def.aux) {
      const radius = Math.max(0.5, def.aux.radius(fx.v) * scale);
      let auxSrc: HTMLCanvasElement = src;
      const thr = def.aux.threshold?.(fx.v);
      if (def.aux.clamp) this.upload(this.auxTex, this.blurredClamped(src, docRect, radius), 1);
      else if (thr !== undefined) {
        const ex = this.program('__extract', EXTRACT);
        if (!ex) return null;
        this.run(ex, w, h, env, seed, { uThreshold: [thr] });
        // Copy out of the GL canvas before it's reused for the final pass.
        if (this.stage.width !== w || this.stage.height !== h) { this.stage.width = w; this.stage.height = h; }
        const sx = ctx2d(this.stage);
        sx.clearRect(0, 0, w, h);
        sx.drawImage(this.canvas, 0, 0);
        auxSrc = this.stage;
      }
      if (!def.aux.clamp) this.upload(this.auxTex, this.blurred(auxSrc, radius), 1);
    }
    const uni = def.uniforms(fx.v) as Record<string, number[]>;
    const passes = def.passes?.(fx.v, { scale, w: docRect.w, h: docRect.h }) as Record<string, number[]>[] | undefined;
    this.draw(prog, w, h, env, seed, uni, passes);
    return this.canvas;
  }
}

/** A plugin effect's program is kept by its code too, so a plugin updated in place gets its new shader. */
function progKey(def: FxDef) {
  if (!def.plugin) return def.kind;
  let h = 0;
  for (let i = 0; i < def.glsl.length; i++) h = (h * 31 + def.glsl.charCodeAt(i)) | 0;
  return `${def.kind}#${h}`;
}

export const fxEngine = new FXEngine();
