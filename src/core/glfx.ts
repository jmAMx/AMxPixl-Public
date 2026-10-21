import { adjMode, buildLut, wheelOffset } from './adjustments';
import type { AdjParams } from './types';

const VS = `#version 300 es
in vec2 aPos; out vec2 vUv;
void main() { vUv = aPos * 0.5 + 0.5; gl_Position = vec4(aPos, 0.0, 1.0); }`;

const FS = `#version 300 es
precision highp float;
in vec2 vUv; out vec4 o;
uniform sampler2D uSrc; uniform sampler2D uLut; uniform int uMode; uniform vec4 uP; uniform vec3 uTint;
uniform vec3 uHsl[8]; uniform vec4 uGrade[3]; uniform mat3 uMix;
float lum(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }
vec3 rgb2hsl(vec3 c) {
  float mx = max(c.r, max(c.g, c.b)), mn = min(c.r, min(c.g, c.b)), l = (mx + mn) * 0.5, d = mx - mn;
  if (d < 1e-5) return vec3(0.0, 0.0, l);
  float s = l > 0.5 ? d / (2.0 - mx - mn) : d / (mx + mn), h;
  if (mx == c.r) h = (c.g - c.b) / d + (c.g < c.b ? 6.0 : 0.0);
  else if (mx == c.g) h = (c.b - c.r) / d + 2.0;
  else h = (c.r - c.g) / d + 4.0;
  return vec3(h / 6.0, s, l);
}
float hue2(float p, float q, float t) {
  t = fract(t);
  if (t < 1.0/6.0) return p + (q - p) * 6.0 * t;
  if (t < 0.5) return q;
  if (t < 2.0/3.0) return p + (q - p) * (2.0/3.0 - t) * 6.0;
  return p;
}
vec3 hsl2rgb(vec3 h) {
  if (h.y < 1e-5) return vec3(h.z);
  float q = h.z < 0.5 ? h.z * (1.0 + h.y) : h.z + h.y - h.z * h.y, p = 2.0 * h.z - q;
  return vec3(hue2(p, q, h.x + 1.0/3.0), hue2(p, q, h.x), hue2(p, q, h.x - 1.0/3.0));
}
void main() {
  vec4 s = texture(uSrc, vUv);
  vec3 c = s.rgb;
  if (uMode == 0) {
    ivec3 i = ivec3(clamp(c, 0.0, 1.0) * 255.0 + 0.5);
    c = vec3(texelFetch(uLut, ivec2(i.r, 0), 0).r, texelFetch(uLut, ivec2(i.g, 0), 0).g, texelFetch(uLut, ivec2(i.b, 0), 0).b);
  } else if (uMode == 1) {
    vec3 h = rgb2hsl(c);
    h.x = fract(h.x + uP.x / 360.0 + 1.0);
    h.y = clamp(h.y * (1.0 + uP.y), 0.0, 1.0);
    c = hsl2rgb(h);
    c = uP.z >= 0.0 ? mix(c, vec3(1.0), uP.z) : mix(c, vec3(0.0), -uP.z);
  } else if (uMode == 2) {
    float l = lum(c), sat = max(c.r, max(c.g, c.b)) - min(c.r, min(c.g, c.b));
    float k = 1.0 + uP.x * (1.0 - sat) + uP.y;
    c = vec3(l) + (c - vec3(l)) * max(k, 0.0);
  } else if (uMode == 3) {
    float l = lum(c);
    c = vec3(l);
    if (uP.x > 0.5) c = mix(2.0 * l * uTint, 1.0 - 2.0 * (1.0 - l) * (1.0 - uTint), step(0.5, l));
  } else if (uMode == 4) {
    c = vec3(step(uP.x / 255.0, lum(c)));
  } else if (uMode == 5) {
    // HSL mixer: blend the two nearest colour-range settings by hue; greys are left alone.
    vec3 h = rgb2hsl(c);
    float hd = h.x * 360.0;
    float centers[9] = float[9](0.0, 30.0, 60.0, 120.0, 180.0, 240.0, 270.0, 300.0, 360.0);
    vec3 adj = vec3(0.0);
    for (int i = 0; i < 8; i++) {
      if (hd >= centers[i] && hd <= centers[i + 1]) {
        adj = mix(uHsl[i], uHsl[(i + 1) % 8], (hd - centers[i]) / (centers[i + 1] - centers[i]));
        break;
      }
    }
    float w = smoothstep(0.0, 0.15, h.y);
    h.x = fract(h.x + adj.x * w / 360.0 + 1.0);
    h.y = clamp(h.y * (1.0 + adj.y * w), 0.0, 1.0);
    c = hsl2rgb(h);
    c = adj.z >= 0.0 ? mix(c, vec3(1.0), adj.z * w * 0.5) : mix(c, vec3(0.0), -adj.z * w * 0.5);
  } else if (uMode == 6) {
    float l = lum(c);
    float sh = 1.0 - smoothstep(0.0, 0.55 + uP.x * 0.3, l);
    float hi = smoothstep(0.45 + uP.x * 0.3, 1.0, l);
    float mid = max(0.0, 1.0 - sh - hi);
    c += uGrade[0].rgb * sh + uGrade[1].rgb * mid + uGrade[2].rgb * hi;
    c += vec3(uGrade[0].a * sh + uGrade[1].a * mid + uGrade[2].a * hi);
  } else if (uMode == 7) {
    c = texelFetch(uLut, ivec2(int(clamp(lum(c), 0.0, 1.0) * 255.0 + 0.5), 0), 0).rgb;
  } else if (uMode == 8) {
    c = uMix * c;
    if (uP.x > 0.5) c = vec3(c.r);
  } else if (uMode == 9) {
    float l0 = lum(c);
    vec3 f = mix(c, c * uTint, uP.x);
    if (uP.y > 0.5) f *= l0 / max(lum(f), 1e-4);
    c = f;
  }
  o = vec4(clamp(c, 0.0, 1.0), s.a);
}`;

/** Runs adjustment layers on the GPU. Needs only WebGL2, so older integrated graphics work. */
export class GLFX {
  readonly canvas = document.createElement('canvas');
  private gl!: WebGL2RenderingContext;
  private prog!: WebGLProgram;
  private srcTex!: WebGLTexture;
  private lutTex!: WebGLTexture;
  private loc: Record<string, WebGLUniformLocation | null> = {};
  maxSize = 4096;
  ok = false;

  constructor() {
    this.canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); this.ok = false; });
    this.canvas.addEventListener('webglcontextrestored', () => this.init());
    this.init();
  }

  private init() {
    const gl = this.canvas.getContext('webgl2', { premultipliedAlpha: false, preserveDrawingBuffer: true, antialias: false });
    if (!gl) return;
    this.gl = gl;
    const sh = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) || 'shader');
      return s;
    };
    try {
      const p = gl.createProgram()!;
      gl.attachShader(p, sh(gl.VERTEX_SHADER, VS));
      gl.attachShader(p, sh(gl.FRAGMENT_SHADER, FS));
      gl.bindAttribLocation(p, 0, 'aPos');
      gl.linkProgram(p);
      if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) || 'link');
      this.prog = p;
    } catch (err) {
      console.error('GLFX init failed', err);
      return;
    }
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
    this.srcTex = tex();
    this.lutTex = tex();
    for (const n of ['uSrc', 'uLut', 'uMode', 'uP', 'uTint', 'uHsl', 'uGrade', 'uMix']) this.loc[n] = gl.getUniformLocation(this.prog, n);
    this.maxSize = gl.getParameter(gl.MAX_TEXTURE_SIZE);
    this.ok = true;
  }

  /** Returns a canvas holding `src` with the adjustment applied (same size), or null if the GPU path is unavailable. */
  apply(src: HTMLCanvasElement, a: AdjParams): HTMLCanvasElement | null {
    if (!this.ok || src.width > this.maxSize || src.height > this.maxSize) return null;
    const gl = this.gl;
    if (this.canvas.width !== src.width || this.canvas.height !== src.height) {
      this.canvas.width = src.width;
      this.canvas.height = src.height;
    }
    gl.viewport(0, 0, src.width, src.height);
    gl.useProgram(this.prog);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.srcTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    const mode = adjMode(a);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.lutTex);
    if (mode === 0 || mode === 7) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 256, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, buildLut(a));
    gl.uniform1i(this.loc.uSrc, 0);
    gl.uniform1i(this.loc.uLut, 1);
    gl.uniform1i(this.loc.uMode, mode);
    let p: [number, number, number, number] = [0, 0, 0, 0];
    let tint: [number, number, number] = [0, 0, 0];
    if (a.kind === 'huesat') p = [a.hue, a.sat / 100, a.light / 100, 0];
    else if (a.kind === 'vibrance') p = [a.vibrance / 100, a.saturation / 100, 0, 0];
    else if (a.kind === 'threshold') p = [a.level, 0, 0, 0];
    else if (a.kind === 'bw' && a.tint) {
      p = [1, 0, 0, 0];
      const n = parseInt(a.tint.slice(1), 16);
      tint = [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
    }
    const rgb = (h: string): [number, number, number] => { const n = parseInt(h.slice(1), 16) || 0; return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]; };
    if (a.kind === 'hsl') gl.uniform3fv(this.loc.uHsl, new Float32Array(a.bands.flatMap(([h, s, l]) => [(h / 100) * 30, s / 100, l / 100])));
    else if (a.kind === 'grade') {
      p = [a.balance / 100, 0, 0, 0];
      gl.uniform4fv(this.loc.uGrade, new Float32Array([...wheelOffset(a.shadows), ...wheelOffset(a.midtones), ...wheelOffset(a.highlights)]));
    } else if (a.kind === 'mixer') {
      p = [a.mono ? 1 : 0, 0, 0, 0];
      const m = [a.r, a.g, a.b];
      gl.uniformMatrix3fv(this.loc.uMix, false, new Float32Array([0, 1, 2].flatMap((j) => m.map((row) => row[j] / 100))));
    } else if (a.kind === 'photofilter') {
      p = [a.density / 100, a.preserve ? 1 : 0, 0, 0];
      tint = rgb(a.color);
    }
    gl.uniform4f(this.loc.uP, ...p);
    gl.uniform3f(this.loc.uTint, ...tint);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    return this.canvas;
  }
}

export const glfx = new GLFX();
