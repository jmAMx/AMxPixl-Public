import type { BlendIf } from './types';

const VS = `#version 300 es
in vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }`;

const HEAD = `#version 300 es
precision highp float;
out vec4 o;
uniform sampler2D uA;
uniform sampler2D uB;
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

type Prog = { p: WebGLProgram; u: Record<string, WebGLUniformLocation | null> };

/** Small per-pixel GPU operations used by layer styles and Blend If. */
class GLOps {
  readonly canvas = document.createElement('canvas');
  private gl: WebGL2RenderingContext | null = null;
  private progs: Record<string, Prog | null> = {};
  private texA!: WebGLTexture;
  private texB!: WebGLTexture;

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
    this.texA = tex();
    this.texB = tex();
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
      for (const n of ['uA', 'uB', 'uRes', 'uP', 'uQ', 'uColor']) out.u[n] = gl.getUniformLocation(p, n);
    } catch (err) {
      console.error('GL op failed', err);
    }
    this.progs[name] = out;
    return out;
  }

  private run(name: string, fs: string, a: HTMLCanvasElement, b: HTMLCanvasElement | null, set: (gl: WebGL2RenderingContext, u: Prog['u']) => void): HTMLCanvasElement | null {
    const gl = this.gl;
    if (!gl) return null;
    const pr = this.prog(name, fs);
    if (!pr) return null;
    const w = a.width, h = a.height;
    if (this.canvas.width !== w || this.canvas.height !== h) { this.canvas.width = w; this.canvas.height = h; }
    gl.viewport(0, 0, w, h);
    gl.useProgram(pr.p);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.texA);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, a);
    if (b) {
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, this.texB);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, b);
    }
    gl.uniform1i(pr.u.uA, 0);
    gl.uniform1i(pr.u.uB, 1);
    gl.uniform2f(pr.u.uRes, w, h);
    set(gl, pr.u);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    return this.canvas;
  }

  /** Colour-filled silhouette where `src` alpha passes the smooth threshold lo..hi. */
  ramp(src: HTMLCanvasElement, lo: number, hi: number, rgb: [number, number, number]) {
    return this.run('ramp', RAMP, src, null, (gl, u) => {
      gl.uniform4f(u.uP, lo, hi, 0, 0);
      gl.uniform3f(u.uColor, ...rgb);
    });
  }

  blendIf(content: HTMLCanvasElement, under: HTMLCanvasElement, b: BlendIf) {
    if (content.width !== under.width || content.height !== under.height) return null;
    return this.run('blendif', BLENDIF, content, under, (gl, u) => {
      gl.uniform4f(u.uP, ...b.self);
      gl.uniform4f(u.uQ, ...b.under);
    });
  }
}

export const glops = new GLOps();
