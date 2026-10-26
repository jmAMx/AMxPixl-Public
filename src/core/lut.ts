import { ctx2d, newCanvas } from './layers';

export interface ParsedLut { name: string; size: number; canvas: HTMLCanvasElement }

/**
 * Parses an Adobe/Resolve .cube file into a packed image: N slices of N x N side by side (blue chooses the slice,
 * red runs across, green down). 1D LUTs are expanded to 3D. Domain is assumed 0..1 unless DOMAIN_MIN/MAX say otherwise.
 */
export function parseCube(text: string, fallbackName: string): ParsedLut {
  let size3 = 0, size1 = 0, name = fallbackName;
  let min = [0, 0, 0], max = [1, 1, 1];
  const vals: number[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const up = line.toUpperCase();
    if (up.startsWith('TITLE')) { name = line.slice(5).trim().replace(/^"|"$/g, '') || name; continue; }
    if (up.startsWith('LUT_3D_SIZE')) { size3 = parseInt(line.split(/\s+/)[1], 10); continue; }
    if (up.startsWith('LUT_1D_SIZE')) { size1 = parseInt(line.split(/\s+/)[1], 10); continue; }
    if (up.startsWith('DOMAIN_MIN')) { min = line.split(/\s+/).slice(1, 4).map(Number); continue; }
    if (up.startsWith('DOMAIN_MAX')) { max = line.split(/\s+/).slice(1, 4).map(Number); continue; }
    if (/^[A-Z_]/.test(up)) continue;
    const parts = line.split(/\s+/);
    if (parts.length >= 3) vals.push(Number(parts[0]), Number(parts[1]), Number(parts[2]));
  }
  if (!size3 && !size1) throw new Error('No LUT_3D_SIZE or LUT_1D_SIZE found.');
  const norm = (v: number, c: number) => Math.round(Math.min(1, Math.max(0, (v - min[c]) / ((max[c] - min[c]) || 1))) * 255);
  let N = size3;
  const at3 = (r: number, g: number, b: number): [number, number, number] => {
    const i = (r + g * N + b * N * N) * 3;
    return [norm(vals[i], 0), norm(vals[i + 1], 1), norm(vals[i + 2], 2)];
  };
  let lookup = at3;
  if (!size3) {
    // 1D LUT: each channel maps on its own.
    N = Math.min(33, size1);
    const pick = (v: number, c: number) => {
      const i = Math.round((v / (N - 1)) * (size1 - 1)) * 3 + c;
      return norm(vals[i], c);
    };
    lookup = (r, g, b) => [pick(r, 0), pick(g, 1), pick(b, 2)];
  } else if (vals.length < N * N * N * 3) {
    throw new Error(`Expected ${N * N * N} entries, found ${Math.floor(vals.length / 3)}.`);
  }
  if (N < 2 || N > 100) throw new Error(`Unsupported LUT size ${N}.`);
  const c = newCanvas(N * N, N);
  const x = ctx2d(c);
  const img = x.createImageData(N * N, N);
  const d = img.data;
  for (let b = 0; b < N; b++) for (let g = 0; g < N; g++) for (let r = 0; r < N; r++) {
    const o = (g * N * N + b * N + r) * 4;
    const [rr, gg, bb] = lookup(r, g, b);
    d[o] = rr; d[o + 1] = gg; d[o + 2] = bb; d[o + 3] = 255;
  }
  x.putImageData(img, 0, 0);
  return { name, size: N, canvas: c };
}
