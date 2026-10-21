import { cloneCanvas, ctx2d, newCanvas } from './layers';

export interface ParamDef { key: string; label: string; min: number; max: number; step: number; value: number; unit?: string; bool?: boolean }
export type Params = Record<string, number>;

export interface FilterDef {
  id: string;
  name: string;
  params: ParamDef[];
  run(src: HTMLCanvasElement, p: Params): HTMLCanvasElement;
}

/** Copy with edge pixels stretched outward, so blurs don't fade to transparent at the borders. */
function padEdges(src: HTMLCanvasElement, pad: number) {
  const w = src.width, h = src.height;
  const c = newCanvas(w + pad * 2, h + pad * 2);
  const x = ctx2d(c);
  x.imageSmoothingEnabled = false;
  x.drawImage(src, pad, pad);
  x.drawImage(src, 0, 0, 1, h, 0, pad, pad, h);
  x.drawImage(src, w - 1, 0, 1, h, pad + w, pad, pad, h);
  x.drawImage(src, 0, 0, w, 1, pad, 0, w, pad);
  x.drawImage(src, 0, h - 1, w, 1, pad, pad + h, w, pad);
  x.drawImage(src, 0, 0, 1, 1, 0, 0, pad, pad);
  x.drawImage(src, w - 1, 0, 1, 1, pad + w, 0, pad, pad);
  x.drawImage(src, 0, h - 1, 1, 1, 0, pad + h, pad, pad);
  x.drawImage(src, w - 1, h - 1, 1, 1, pad + w, pad + h, pad, pad);
  return c;
}

function unpad(c: HTMLCanvasElement, pad: number, w: number, h: number) {
  const o = newCanvas(w, h);
  ctx2d(o).drawImage(c, -pad, -pad);
  return o;
}

export function gaussian(src: HTMLCanvasElement, radius: number) {
  if (radius <= 0) return cloneCanvas(src);
  const pad = Math.ceil(radius * 3) + 2;
  const p = padEdges(src, pad);
  const b = newCanvas(p.width, p.height);
  const x = ctx2d(b);
  x.filter = `blur(${radius}px)`;
  x.drawImage(p, 0, 0);
  return unpad(b, pad, src.width, src.height);
}

function motionBlur(src: HTMLCanvasElement, angle: number, distance: number) {
  if (distance < 1) return cloneCanvas(src);
  const pad = Math.ceil(distance) + 2;
  let cur = padEdges(src, pad);
  const rad = (angle * Math.PI) / 180;
  // Average shifted copies by repeated halving: 2, 4, 8... samples spread across the distance.
  const passes = Math.max(1, Math.ceil(Math.log2(Math.max(2, distance))));
  let step = distance / Math.pow(2, passes);
  for (let i = 0; i < passes; i++) {
    const next = newCanvas(cur.width, cur.height);
    const x = ctx2d(next);
    x.drawImage(cur, (-Math.cos(rad) * step) / 2, (Math.sin(rad) * step) / 2);
    x.globalAlpha = 0.5;
    x.drawImage(cur, (Math.cos(rad) * step) / 2, (-Math.sin(rad) * step) / 2);
    cur = next;
    step *= 2;
  }
  return unpad(cur, pad, src.width, src.height);
}

function unsharp(src: HTMLCanvasElement, amount: number, radius: number, threshold: number) {
  const blurred = gaussian(src, radius);
  const out = cloneCanvas(src);
  const oc = ctx2d(out, true);
  const a = oc.getImageData(0, 0, out.width, out.height);
  const b = ctx2d(blurred, true).getImageData(0, 0, out.width, out.height).data;
  const d = a.data, k = amount / 100;
  for (let i = 0; i < d.length; i += 4) {
    for (let c = 0; c < 3; c++) {
      const diff = d[i + c] - b[i + c];
      if (Math.abs(diff) * 2 < threshold) continue;
      const v = d[i + c] + diff * k;
      d[i + c] = v < 0 ? 0 : v > 255 ? 255 : v;
    }
  }
  oc.putImageData(a, 0, 0);
  return out;
}

function noise(src: HTMLCanvasElement, amount: number, mono: boolean) {
  const out = cloneCanvas(src);
  const oc = ctx2d(out, true);
  const img = oc.getImageData(0, 0, out.width, out.height);
  const d = img.data;
  let seed = 1234567;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  const gauss = () => (rnd() + rnd() + rnd() - 1.5) * 1.15;
  const amp = (amount / 100) * 255;
  for (let i = 0; i < d.length; i += 4) {
    if (mono) {
      const n = gauss() * amp;
      for (let c = 0; c < 3; c++) d[i + c] = Math.max(0, Math.min(255, d[i + c] + n));
    } else {
      for (let c = 0; c < 3; c++) d[i + c] = Math.max(0, Math.min(255, d[i + c] + gauss() * amp));
    }
  }
  oc.putImageData(img, 0, 0);
  return out;
}

function pixelate(src: HTMLCanvasElement, cell: number) {
  const w = src.width, h = src.height;
  const sw = Math.max(1, Math.round(w / cell)), sh = Math.max(1, Math.round(h / cell));
  const small = newCanvas(sw, sh);
  const sx = ctx2d(small);
  sx.imageSmoothingQuality = 'high';
  sx.drawImage(src, 0, 0, sw, sh);
  const out = newCanvas(w, h);
  const ox = ctx2d(out);
  ox.imageSmoothingEnabled = false;
  ox.drawImage(small, 0, 0, w, h);
  return out;
}

function vignette(src: HTMLCanvasElement, amount: number, size: number) {
  const out = cloneCanvas(src);
  const x = ctx2d(out);
  const w = out.width, h = out.height, r = Math.hypot(w, h) / 2;
  const g = x.createRadialGradient(w / 2, h / 2, r * (size / 100), w / 2, h / 2, r);
  g.addColorStop(0, 'rgba(0,0,0,0)');
  g.addColorStop(1, `rgba(0,0,0,${amount / 100})`);
  x.globalCompositeOperation = 'source-atop';
  x.fillStyle = g;
  x.fillRect(0, 0, w, h);
  return out;
}

export const FILTERS: FilterDef[] = [
  {
    id: 'gaussian', name: 'Gaussian Blur',
    params: [{ key: 'radius', label: 'Radius', min: 0.1, max: 200, step: 0.1, value: 4, unit: 'px' }],
    run: (s, p) => gaussian(s, p.radius),
  },
  {
    id: 'motion', name: 'Motion Blur',
    params: [
      { key: 'angle', label: 'Angle', min: -180, max: 180, step: 1, value: 0, unit: '°' },
      { key: 'distance', label: 'Distance', min: 1, max: 500, step: 1, value: 20, unit: 'px' },
    ],
    run: (s, p) => motionBlur(s, p.angle, p.distance),
  },
  {
    id: 'unsharp', name: 'Unsharp Mask (Sharpen)',
    params: [
      { key: 'amount', label: 'Amount', min: 1, max: 500, step: 1, value: 80, unit: '%' },
      { key: 'radius', label: 'Radius', min: 0.1, max: 50, step: 0.1, value: 1.5, unit: 'px' },
      { key: 'threshold', label: 'Threshold', min: 0, max: 255, step: 1, value: 0, unit: 'lv' },
    ],
    run: (s, p) => unsharp(s, p.amount, p.radius, p.threshold),
  },
  {
    id: 'noise', name: 'Add Noise',
    params: [
      { key: 'amount', label: 'Amount', min: 0, max: 100, step: 0.5, value: 8, unit: '%' },
      { key: 'mono', label: 'Monochromatic', min: 0, max: 1, step: 1, value: 1, bool: true },
    ],
    run: (s, p) => noise(s, p.amount, !!p.mono),
  },
  {
    id: 'pixelate', name: 'Pixelate',
    params: [{ key: 'cell', label: 'Cell size', min: 2, max: 200, step: 1, value: 10, unit: 'px' }],
    run: (s, p) => pixelate(s, p.cell),
  },
  {
    id: 'vignette', name: 'Vignette',
    params: [
      { key: 'amount', label: 'Darkness', min: 0, max: 100, step: 1, value: 45, unit: '%' },
      { key: 'size', label: 'Clear centre', min: 0, max: 95, step: 1, value: 45, unit: '%' },
    ],
    run: (s, p) => vignette(s, p.amount, p.size),
  },
];

/** Blends a filtered result over the original only where `mask` is opaque (selection-limited filters). */
export function maskedMerge(original: HTMLCanvasElement, result: HTMLCanvasElement, mask: HTMLCanvasElement | null) {
  if (!mask) return result;
  const a = cloneCanvas(result);
  const ax = ctx2d(a);
  ax.globalCompositeOperation = 'destination-in';
  ax.drawImage(mask, 0, 0);
  const b = cloneCanvas(original);
  const bx = ctx2d(b);
  bx.globalCompositeOperation = 'destination-out';
  bx.drawImage(mask, 0, 0);
  bx.globalCompositeOperation = 'lighter';
  bx.drawImage(a, 0, 0);
  return b;
}
