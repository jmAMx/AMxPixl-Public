/**
 * Content-aware fill: fills a hole in a picture with patches from around it, so it carries on the texture and lines
 * there. PatchMatch inpainting (after Wexler, Shechtman and Irani; Barnes et al.): coarse to fine, each level alternates
 * finding, for every patch over the hole, the most alike patch outside it, and repainting the hole from those patches.
 * Plain arrays, no page: it runs in a worker (workers/inpaintworker.ts).
 */

export interface InpaintJob { w: number; h: number; rgba: Uint8ClampedArray; hole: Uint8Array }

const R = 3; // patch radius: 7 × 7 patches
const CH = 4;

interface Level { w: number; h: number; img: Float32Array; hole: Uint8Array }

function downsample(l: Level): Level {
  const w = Math.max(1, l.w >> 1), h = Math.max(1, l.h >> 1);
  const img = new Float32Array(w * h * CH), hole = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let n = 0, any = 0;
    const acc = [0, 0, 0, 0];
    for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
      const sx = Math.min(l.w - 1, x * 2 + dx), sy = Math.min(l.h - 1, y * 2 + dy), si = sy * l.w + sx;
      if (l.hole[si]) { any = 1; continue; }
      for (let c = 0; c < CH; c++) acc[c] += l.img[si * CH + c];
      n++;
    }
    const i = y * w + x;
    // A coarse pixel touching the hole is hole too, so the fill reaches all of it.
    hole[i] = any;
    if (n) for (let c = 0; c < CH; c++) img[i * CH + c] = acc[c] / n;
  }
  return { w, h, img, hole };
}

/** A first guess for the hole at the coarsest level: colours flowing in from its edge, ring by ring. */
function diffuse(l: Level) {
  const { w, h, img } = l;
  const todo = l.hole.slice();
  let left = todo.reduce((a, b) => a + b, 0);
  while (left > 0) {
    const next: number[] = [];
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!todo[i]) continue;
      let n = 0;
      const acc = [0, 0, 0, 0];
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h || todo[ny * w + nx]) continue;
        for (let c = 0; c < CH; c++) acc[c] += img[(ny * w + nx) * CH + c];
        n++;
      }
      if (n) { for (let c = 0; c < CH; c++) img[i * CH + c] = acc[c] / n; next.push(i); }
    }
    if (!next.length) break;
    for (const i of next) todo[i] = 0;
    left -= next.length;
  }
}

/** Where a patch can be taken from: its whole 7 × 7 inside the picture and clear of the hole. */
function sources(l: Level): { ok: Uint8Array; list: Int32Array } {
  const { w, h, hole } = l;
  // Rows of "hole within R" by a running sum, then columns: a patch is fine if neither finds any hole.
  const near = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (!hole[y * w + x]) continue;
    for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) {
      const nx = x + dx, ny = y + dy;
      if (nx >= 0 && ny >= 0 && nx < w && ny < h) near[ny * w + nx] = 1;
    }
  }
  const ok = new Uint8Array(w * h);
  const list: number[] = [];
  for (let y = R; y < h - R; y++) for (let x = R; x < w - R; x++) {
    const i = y * w + x;
    if (!near[i]) { ok[i] = 1; list.push(i); }
  }
  return { ok, list: Int32Array.from(list) };
}

/**
 * How much the hole's own (guessed) pixels count in comparing patches, against 1 for the picture's real ones: little
 * while the guess is rough (the first rounds), so matches follow what's really there, then fully.
 */
let guessWeight = 1;

/** Sum of squared differences between the patches at a and b (both centres), giving up once over `cap`. */
function dist(l: Level, a: number, b: number, cap: number): number {
  const { w, h, img, hole } = l;
  const ax = a % w, ay = (a / w) | 0, bx = b % w, by = (b / w) | 0;
  let d = 0, n = 0;
  for (let dy = -R; dy <= R; dy++) {
    const y1 = ay + dy, y2 = by + dy;
    if (y1 < 0 || y1 >= h || y2 < 0 || y2 >= h) continue;
    for (let dx = -R; dx <= R; dx++) {
      const x1 = ax + dx, x2 = bx + dx;
      if (x1 < 0 || x1 >= w || x2 < 0 || x2 >= w) continue;
      const p = y1 * w + x1, i = p * CH, j = (y2 * w + x2) * CH;
      const k = hole[p] ? guessWeight : 1;
      const e0 = img[i] - img[j], e1 = img[i + 1] - img[j + 1], e2 = img[i + 2] - img[j + 2], e3 = img[i + 3] - img[j + 3];
      d += (e0 * e0 + e1 * e1 + e2 * e2 + e3 * e3) * k;
      n += k;
    }
    if (n > 0 && d > (cap * n) / 49) break;
  }
  return n > 0 ? (d * 49) / n : Infinity;
}

let seed = 1;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };

/** The patches to match: every pixel whose patch reaches into the hole. */
function targets(l: Level): Int32Array {
  const { w, h, hole } = l;
  const t: number[] = [];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let hit = false;
    for (let dy = -R; dy <= R && !hit; dy++) for (let dx = -R; dx <= R && !hit; dx++) {
      const nx = x + dx, ny = y + dy;
      if (nx >= 0 && ny >= 0 && nx < w && ny < h && hole[ny * w + nx]) hit = true;
    }
    if (hit) t.push(y * w + x);
  }
  return Int32Array.from(t);
}

/** PatchMatch: improves `nnf` (target index -> source centre) by passing on neighbours' matches and random search. */
function patchMatch(l: Level, tg: Int32Array, nnf: Int32Array, cost: Float32Array, src: { ok: Uint8Array; list: Int32Array }, passes: number) {
  const { w, h } = l;
  const pos = new Int32Array(w * h).fill(-1);
  tg.forEach((p, k) => { pos[p] = k; });
  const tryIt = (k: number, s: number) => {
    if (s < 0 || s >= w * h || !src.ok[s] || s === nnf[k]) return;
    const d = dist(l, tg[k], s, cost[k]);
    if (d < cost[k]) { cost[k] = d; nnf[k] = s; }
  };
  for (let pass = 0; pass < passes; pass++) {
    const fwd = pass % 2 === 0, step = fwd ? 1 : -1;
    for (let q = fwd ? 0 : tg.length - 1; fwd ? q < tg.length : q >= 0; q += step) {
      const p = tg[q], x = p % w;
      // Propagation: the neighbour before (in this pass's direction) has a good match? Shift it by one.
      const nx = fwd ? -1 : 1;
      if (x + nx >= 0 && x + nx < w) { const kn = pos[p + nx]; if (kn >= 0) tryIt(q, nnf[kn] - nx); }
      const ny = fwd ? -w : w;
      if (p + ny >= 0 && p + ny < w * h) { const kn = pos[p + ny]; if (kn >= 0) tryIt(q, nnf[kn] - ny); }
      // Random search around the current match, in shrinking circles.
      const sx = nnf[q] % w, sy = (nnf[q] / w) | 0;
      for (let r = Math.max(w, h); r >= 1; r >>= 1) {
        const rx = Math.round(sx + (rnd() * 2 - 1) * r), ry = Math.round(sy + (rnd() * 2 - 1) * r);
        if (rx >= 0 && ry >= 0 && rx < w && ry < h) tryIt(q, ry * w + rx);
      }
    }
  }
}

/** Repaints the hole: each of its pixels, the average of what the patches over it say, closer matches counting more. */
function vote(l: Level, tg: Int32Array, nnf: Int32Array, cost: Float32Array) {
  const { w, h, img, hole } = l;
  const acc = new Float32Array(w * h * CH), wt = new Float32Array(w * h);
  let mean = 0;
  for (let k = 0; k < tg.length; k++) mean += cost[k];
  mean = mean / Math.max(1, tg.length) + 1;
  for (let k = 0; k < tg.length; k++) {
    const p = tg[k], s = nnf[k];
    const px = p % w, py = (p / w) | 0, sx = s % w, sy = (s / w) | 0;
    const weight = Math.exp(-cost[k] / mean);
    for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) {
      const x = px + dx, y = py + dy;
      if (x < 0 || y < 0 || x >= w || y >= h) continue;
      const i = y * w + x;
      if (!hole[i]) continue;
      const j = ((sy + dy) * w + sx + dx) * CH;
      for (let c = 0; c < CH; c++) acc[i * CH + c] += img[j + c] * weight;
      wt[i] += weight;
    }
  }
  for (let i = 0; i < w * h; i++) if (hole[i] && wt[i] > 0) for (let c = 0; c < CH; c++) img[i * CH + c] = acc[i * CH + c] / wt[i];
}

export function inpaint(job: InpaintJob): Uint8ClampedArray {
  seed = 1;
  const base: Level = { w: job.w, h: job.h, img: Float32Array.from(job.rgba), hole: job.hole.slice() };
  // Coarse enough that the hole is a few patches across, but not smaller than a few patches itself.
  let hx0 = job.w, hy0 = job.h, hx1 = 0, hy1 = 0;
  for (let i = 0; i < job.w * job.h; i++) if (job.hole[i]) { const x = i % job.w, y = (i / job.w) | 0; hx0 = Math.min(hx0, x); hx1 = Math.max(hx1, x); hy0 = Math.min(hy0, y); hy1 = Math.max(hy1, y); }
  if (hx1 < hx0) return job.rgba;
  const levels: Level[] = [base];
  while (Math.max(hx1 - hx0, hy1 - hy0) / 2 ** levels.length > 6 && Math.min(levels.at(-1)!.w, levels.at(-1)!.h) > 4 * (2 * R + 1)) levels.push(downsample(levels.at(-1)!));
  let prev: { nnf: Int32Array; tg: Int32Array; w: number; h: number } | null = null;
  for (let li = levels.length - 1; li >= 0; li--) {
    const l = levels[li];
    const src = sources(l);
    // Nowhere clean to copy from at this size (a small picture, mostly hole): a smooth fill, and start afresh above.
    if (!src.list.length) { diffuse(l); prev = null; continue; }
    const tg = targets(l);
    const nnf = new Int32Array(tg.length), cost = new Float32Array(tg.length);
    if (!prev) {
      diffuse(l);
      for (let k = 0; k < tg.length; k++) nnf[k] = src.list[(rnd() * src.list.length) | 0];
    } else {
      // Carry the coarser level's matches up: twice the position, plus where in its 2 × 2 this pixel is.
      const coarse = new Int32Array(prev.w * prev.h).fill(-1);
      prev.tg.forEach((p, k) => { coarse[p] = prev!.nnf[k]; });
      for (let k = 0; k < tg.length; k++) {
        const p = tg[k], x = p % l.w, y = (p / l.w) | 0;
        const cx = Math.min(prev.w - 1, x >> 1), cy = Math.min(prev.h - 1, y >> 1);
        const cs = coarse[cy * prev.w + cx];
        let s = -1;
        if (cs >= 0) {
          const sx = (cs % prev.w) * 2 + (x & 1), sy = ((cs / prev.w) | 0) * 2 + (y & 1);
          if (sx < l.w && sy < l.h) s = sy * l.w + sx;
        }
        nnf[k] = s >= 0 && src.ok[s] ? s : src.list[(rnd() * src.list.length) | 0];
      }
      vote(l, tg, nnf, cost.fill(0));
    }
    // More rounds where it's cheap (coarse), fewer at full size; the coarsest level (all there is, for a small hole)
    // starts from a guess, so it gets the most, the first of them going by the real pixels around the hole.
    const coarsest = !prev;
    const rounds = coarsest ? 6 : li === 0 ? 2 : 3;
    for (let it = 0; it < rounds; it++) {
      guessWeight = coarsest && it < 2 ? 0.05 : 1;
      for (let k = 0; k < tg.length; k++) cost[k] = dist(l, tg[k], nnf[k], Infinity);
      patchMatch(l, tg, nnf, cost, src, 2);
      vote(l, tg, nnf, cost);
      for (let k = 0; k < tg.length; k++) cost[k] = dist(l, tg[k], nnf[k], Infinity);
    }
    prev = { nnf, tg, w: l.w, h: l.h };
  }
  const out = new Uint8ClampedArray(job.rgba.length);
  for (let i = 0; i < out.length; i++) out[i] = base.img[i];
  return out;
}
