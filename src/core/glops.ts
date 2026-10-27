import type { BlendIf } from './types';

const VS = `#version 300 es
in vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }`;

const HEAD = `#version 300 es
precision highp float;
out vec4 o;
uniform sampler2D uA;
uniform sampler2D uB;
uniform sampler2D uC;
uniform sampler2D uD;
uniform vec2 uRes;
uniform vec4 uP;
uniform vec4 uQ;
uniform vec3 uColor;
vec4 at(sampler2D s) { return texelFetch(s, ivec2(gl_FragCoord.x, uRes.y - gl_FragCoord.y), 0); }
float lum(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)) * 255.0; }
`;

/** Alpha threshold: turns a blurred silhouette into a grown (or shrunk) one, filled with a colour. */
const RAMP = HEAD + `
void main() { o = vec4(uColor, smoothstep(uP.x, uP.y, at(uA).a)); }`;

/**
 * Retouch brushes, weighted by the stroke's coverage (uC alpha) × strength (uP.y). uA = the layer before the
 * stroke, uB = a blurred copy. uP.x: 0 dodge, 1 burn, 2 blur, 3 sharpen. uP.z: range 0 shadows, 1 midtones,
 * 2 highlights (dodge/burn).
 */
const RETOUCH = HEAD + `
void main() {
  vec4 c = at(uA), b = at(uB);
  float k = at(uC).a * uP.y;
  int mode = int(uP.x + 0.5);
  vec3 r = c.rgb;
  float a = c.a;
  if (mode <= 1) {
    float l = dot(c.rgb, vec3(0.2126, 0.7152, 0.0722));
    float w = uP.z < 0.5 ? (1.0 - l) * (1.0 - l) : uP.z < 1.5 ? 1.0 - (2.0 * l - 1.0) * (2.0 * l - 1.0) : l * l;
    float e = 1.0 + 1.6 * k * w;
    r = pow(max(c.rgb, 0.0), vec3(mode == 0 ? 1.0 / e : e));
  } else if (mode == 2) {
    r = mix(c.rgb, b.rgb, k);
    a = mix(c.a, b.a, k);
  } else {
    r = clamp(c.rgb + (c.rgb - b.rgb) * k * 1.6, 0.0, 1.0);
  }
  o = vec4(r, a);
}`;

/** Hard edges (anti-aliasing off): every pixel fully on or off, colour kept. */
const HARD = HEAD + `
void main() { vec4 c = at(uA); o = vec4(c.rgb, step(0.5, c.a)); }`;

/** Blend If: fades the layer (uA) by its own brightness and by the brightness of what's under it (uB). */
const BLENDIF = HEAD + `
float band(float l, vec4 r) {
  float lo = r.y > r.x ? clamp((l - r.x) / (r.y - r.x), 0.0, 1.0) : step(r.x, l);
  float hi = r.w > r.z ? clamp((r.w - l) / (r.w - r.z), 0.0, 1.0) : step(l, r.w);
  return lo * hi;
}
void main() {
  vec4 c = at(uA);
  vec4 u = at(uB);
  float k = band(lum(c.rgb), uP) * (u.a > 0.0 ? band(lum(u.rgb), uQ) : 1.0);
  o = vec4(c.rgb, c.a * k);
}`;

/**
 * Colour Range: a selection mask from how close each pixel is to a colour (mode 0), or by tone (1 highlights,
 * 2 midtones, 3 shadows). uP.x = fuzziness (0..200, like Photoshop).
 */
const RANGE = HEAD + `
void main() {
  vec4 c = at(uA);
  float k;
  if (uP.y < 0.5) {
    float d = distance(c.rgb, uColor) * 255.0 / 1.7320508;
    k = 1.0 - smoothstep(uP.x * 0.4, uP.x + 1.0, d);
  } else {
    float l = lum(c.rgb) / 255.0;
    if (uP.y < 1.5) k = smoothstep(0.5, 0.75, l);
    else if (uP.y < 2.5) k = 1.0 - smoothstep(0.15, 0.35, abs(l - 0.5));
    else k = 1.0 - smoothstep(0.25, 0.5, l);
  }
  o = vec4(1.0, 1.0, 1.0, k * step(0.004, c.a));
}`;

/**
 * Healing: keep the copied texture (uA) but swap its broad colour/light for the destination's:
 * out = clone + (blur(destination) [uC] - blur(what's visible) [uB]) x how much was cloned there [uD alpha].
 */
const HEAL = HEAD + `
void main() {
  vec4 c = at(uA), s = at(uB), d = at(uC);
  // How much of this pixel is new clone: on an empty layer a soft edge is already faded by its own alpha, so it
  // takes the full correction. s and d are fills of the surroundings; where almost nothing surrounds a pixel
  // they're unreliable.
  float k = clamp(at(uD).a * uP.x / max(c.a, 0.001), 0.0, 1.0) * smoothstep(0.004, 0.05, min(s.a, d.a));
  o = vec4(clamp(c.rgb + (d.rgb - s.rgb) * k, 0.0, 1.0), c.a);
}`;

/**
 * GIMP-style compositing: blends a layer (uB) over what's below (uA) in linear light, then converts back.
 * uP.x = mode (0 normal, 1 multiply, 2 screen, 3 darken, 4 lighten, 5 difference), uP.y = opacity.
 */
const LINEAR = HEAD + `
vec3 lin(vec3 c) { return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c)); }
vec3 srgb(vec3 c) { c = max(c, 0.0); return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c)); }
void main() {
  vec4 d = at(uA), s = at(uB);
  float as = s.a * uP.y, ad = d.a;
  vec3 sl = lin(s.rgb), dl = lin(d.rgb);
  int m = int(uP.x + 0.5);
  vec3 b = m == 1 ? sl * dl : m == 2 ? sl + dl - sl * dl : m == 3 ? min(sl, dl) : m == 4 ? max(sl, dl) : m == 5 ? abs(sl - dl) : sl;
  float ao = as + ad * (1.0 - as);
  vec3 co = as * (1.0 - ad) * sl + as * ad * b + (1.0 - as) * ad * dl;
  o = vec4(ao > 0.0 ? clamp(srgb(co / ao), 0.0, 1.0) : vec3(0.0), ao);
}`;

type Prog = { p: WebGLProgram; u: Record<string, WebGLUniformLocation | null> };

/** Small per-pixel GPU operations used by layer styles and Blend If. */
class GLOps {
  readonly canvas = document.createElement('canvas');
  private gl: WebGL2RenderingContext | null = null;
  private progs: Record<string, Prog | null> = {};
  private texs: WebGLTexture[] = [];

  constructor() {
    this.canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); this.gl = null; });
    this.canvas.addEventListener('webglcontextrestored', () => this.init());
    this.init();
  }

  private init() {
    const gl = this.canvas.getContext('webgl2', { premultipliedAlpha: false, preserveDrawingBuffer: true, antialias: false });
    if (!gl) return;
    this.gl = gl;
    this.progs = {};
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    const tex = () => {
      const t = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      return t;
    };
    this.texs = [tex(), tex(), tex(), tex()];
  }

  private prog(name: string, fs: string): Prog | null {
    if (name in this.progs) return this.progs[name];
    const gl = this.gl!;
    const sh = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) || name);
      return s;
    };
    let out: Prog | null = null;
    try {
      const p = gl.createProgram()!;
      gl.attachShader(p, sh(gl.VERTEX_SHADER, VS));
      gl.attachShader(p, sh(gl.FRAGMENT_SHADER, fs));
      gl.bindAttribLocation(p, 0, 'aPos');
      gl.linkProgram(p);
      if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) || name);
      out = { p, u: {} };
      for (const n of ['uA', 'uB', 'uC', 'uD', 'uRes', 'uP', 'uQ', 'uColor']) out.u[n] = gl.getUniformLocation(p, n);
    } catch (err) {
      console.error('GL op failed', err);
    }
    this.progs[name] = out;
    return out;
  }

  private run(name: string, fs: string, inputs: HTMLCanvasElement[], set: (gl: WebGL2RenderingContext, u: Prog['u']) => void): HTMLCanvasElement | null {
    const gl = this.gl;
    if (!gl) return null;
    const pr = this.prog(name, fs);
    if (!pr) return null;
    const w = inputs[0].width, h = inputs[0].height;
    if (this.canvas.width !== w || this.canvas.height !== h) { this.canvas.width = w; this.canvas.height = h; }
    gl.viewport(0, 0, w, h);
    gl.useProgram(pr.p);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    inputs.forEach((img, i) => {
      gl.activeTexture(gl.TEXTURE0 + i);
      gl.bindTexture(gl.TEXTURE_2D, this.texs[i]);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
    });
    ['uA', 'uB', 'uC', 'uD'].forEach((n, i) => { if (pr.u[n]) gl.uniform1i(pr.u[n], i); });
    gl.uniform2f(pr.u.uRes, w, h);
    set(gl, pr.u);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    return this.canvas;
  }

  retouch(src: HTMLCanvasElement, blurred: HTMLCanvasElement, coverage: HTMLCanvasElement, mode: number, strength: number, range: number) {
    return this.run('retouch', RETOUCH, [src, blurred, coverage], (gl, u) => gl.uniform4f(u.uP, mode, strength, range, 0));
  }

  /** Anti-aliasing off: half-covered edge pixels become fully on or off. */
  hardEdge(src: HTMLCanvasElement) {
    return this.run('hard', HARD, [src], () => {});
  }

  /** Colour-filled silhouette where `src` alpha passes the smooth threshold lo..hi. */
  ramp(src: HTMLCanvasElement, lo: number, hi: number, rgb: [number, number, number]) {
    return this.run('ramp', RAMP, [src], (gl, u) => {
      gl.uniform4f(u.uP, lo, hi, 0, 0);
      gl.uniform3f(u.uColor, ...rgb);
    });
  }

  colorRange(src: HTMLCanvasElement, mode: number, fuzz: number, rgb: [number, number, number]) {
    return this.run('range', RANGE, [src], (gl, u) => {
      gl.uniform4f(u.uP, fuzz, mode, 0, 0);
      gl.uniform3f(u.uColor, ...rgb);
    });
  }

  blendIf(content: HTMLCanvasElement, under: HTMLCanvasElement, b: BlendIf) {
    if (content.width !== under.width || content.height !== under.height) return null;
    return this.run('blendif', BLENDIF, [content, under], (gl, u) => {
      gl.uniform4f(u.uP, ...b.self);
      gl.uniform4f(u.uQ, ...b.under);
    });
  }

  linearOver(below: HTMLCanvasElement, layer: HTMLCanvasElement, mode: number, opacity: number) {
    if (below.width !== layer.width || below.height !== layer.height) return null;
    return this.run('linear', LINEAR, [below, layer], (gl, u) => gl.uniform4f(u.uP, mode, opacity, 0, 0));
  }

  heal(clone: HTMLCanvasElement, aroundSource: HTMLCanvasElement, aroundDest: HTMLCanvasElement, coverage: HTMLCanvasElement, strength: number) {
    return this.run('heal', HEAL, [clone, aroundSource, aroundDest, coverage], (gl, u) => gl.uniform4f(u.uP, strength, 0, 0, 0));
  }
}

export const glops = new GLOps();
