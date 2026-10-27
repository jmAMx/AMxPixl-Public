import type { BlendMode, Guide } from '../types';
import { applyGimpFilter, SPACES, type Px } from './gimpfilters';
import { Reader, sampleTo8 } from './reader';

/*
 * GIMP .xcf parsing. This module runs in a background worker (workers/xcfworker.ts), so it uses no DOM: pixels
 * are plain RGBA buffers, and the main thread (xcfimport.ts) turns the result into a document.
 */

/** RGBA pixels, 8 bits per channel. */
export interface PxBuf { w: number; h: number; data: Uint8ClampedArray }

/** One layer or group as read from the file (bottom to top within its parent). */
export interface XcfLayer {
  name: string; visible: boolean; opacity: number; blend: BlendMode; linear: boolean;
  mask: { px: PxBuf; x: number; y: number; enabled: boolean } | null;
  group: boolean; open: boolean; children: XcfLayer[];
  x: number; y: number; px: PxBuf | null;
}
export interface XcfResult { W: number; H: number; guides: Guide[]; notes: string[]; layers: XcfLayer[]; count: number }

/** GIMP layer modes (2.10/3.x numbering, including the legacy ones) to AMxPixl blend modes. */
const MODES: Record<number, BlendMode> = {
  0: 'normal', 3: 'multiply', 4: 'screen', 5: 'soft-light', 6: 'difference', 9: 'darken', 10: 'lighten', 11: 'hue', 12: 'saturation',
  13: 'color', 14: 'luminosity', 16: 'color-dodge', 17: 'color-burn', 18: 'hard-light', 19: 'soft-light',
  23: 'overlay', 24: 'hue', 25: 'saturation', 26: 'color', 27: 'luminosity', 28: 'normal', 30: 'multiply', 31: 'screen', 32: 'difference',
  35: 'darken', 36: 'lighten', 37: 'hue', 38: 'saturation', 39: 'color', 40: 'luminosity', 42: 'color-dodge', 43: 'color-burn',
  44: 'hard-light', 45: 'soft-light', 52: 'exclusion', 61: 'pass-through',
};
/** Modes with no exact match, and the closest one used instead. */
const APPROX: Record<number, BlendMode> = {
  1: 'normal', 7: 'screen', 8: 'difference', 15: 'color-dodge', 20: 'overlay', 21: 'overlay', 29: 'normal', 33: 'screen', 34: 'difference',
  41: 'color-dodge', 46: 'overlay', 47: 'overlay', 48: 'hard-light', 49: 'hard-light', 50: 'hard-light', 51: 'hard-light', 53: 'multiply',
  54: 'darken', 55: 'lighten', 56: 'luminosity',
};

const PROP = { END: 0, COLORMAP: 1, OPACITY: 6, MODE: 7, VISIBLE: 8, APPLY_MASK: 11, OFFSETS: 15, COMPRESSION: 17, GUIDES: 18, TEXT: 26, GROUP: 29, PATH: 30, GROUP_FLAGS: 31, FLOAT_OPACITY: 33 };

interface Fmt { bytes: number; float: boolean; linear: boolean }

/** Bytes per component, float or integer, and linear or gamma, from the file's precision code. */
function precision(version: number, code: number): Fmt {
  if (version < 4) return { bytes: 1, float: false, linear: false };
  if (version === 4) return [{ bytes: 1, float: false, linear: false }, { bytes: 2, float: false, linear: false }, { bytes: 4, float: false, linear: true },
    { bytes: 2, float: true, linear: true }, { bytes: 4, float: true, linear: true }][code] ?? { bytes: 1, float: false, linear: false };
  // Hundreds digit = sample type (versions 5-6 numbered half/float as 4/5; 7+ as 5/6, plus 7 = double).
  const kind = Math.floor(code / 100), linear = code % 100 === 0;
  const t: Record<number, [number, boolean]> = version < 7
    ? { 1: [1, false], 2: [2, false], 3: [4, false], 4: [2, true], 5: [4, true] }
    : { 1: [1, false], 2: [2, false], 3: [4, false], 5: [2, true], 6: [4, true], 7: [8, true] };
  const [bytes, float] = t[kind] ?? [1, false];
  return { bytes, float, linear };
}

interface Props { opacity: number; mode: number; visible: boolean; applyMask: boolean; x: number; y: number; group: boolean; path: number[] | null; text: boolean; expanded: boolean }

function readProps(r: Reader): Props {
  const p: Props = { opacity: 1, mode: 28, visible: true, applyMask: true, x: 0, y: 0, group: false, path: null, text: false, expanded: true };
  let hadFloat = false;
  for (;;) {
    const type = r.u32(), len = r.u32();
    if (type === PROP.END) break;
    const end = r.pos + len;
    switch (type) {
      case PROP.OPACITY: if (!hadFloat) p.opacity = r.u32() / 255; break;
      case PROP.FLOAT_OPACITY: p.opacity = r.f32(); hadFloat = true; break;
      case PROP.MODE: p.mode = r.u32(); break;
      case PROP.VISIBLE: p.visible = r.u32() !== 0; break;
      case PROP.APPLY_MASK: p.applyMask = r.u32() !== 0; break;
      case PROP.OFFSETS: p.x = r.i32(); p.y = r.i32(); break;
      case PROP.GROUP: p.group = true; break;
      case PROP.GROUP_FLAGS: p.expanded = (r.u32() & 1) !== 0; break;
      case PROP.TEXT: p.text = true; break;
      case PROP.PATH: { p.path = []; for (let i = 0; i < len / 4; i++) p.path.push(r.u32()); break; }
    }
    r.pos = end;
  }
  return p;
}

const readString = (r: Reader) => {
  const n = r.u32();
  if (!n) return '';
  const s = new TextDecoder().decode(r.bytes(n));
  return s.replace(/\0$/, '');
};

/** Inflates a zlib tile, tolerating trailing bytes from the next structure (tile lengths aren't stored). */
async function inflateTile(data: Uint8Array, expect: number): Promise<Uint8Array> {
  const reader = new Blob([data as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new DecompressionStream('deflate')).getReader();
  const out = new Uint8Array(expect);
  let n = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done || !value) break;
      out.set(value.subarray(0, Math.max(0, expect - n)), n);
      n += value.length;
      if (n >= expect) break;
    }
  } catch { /* trailing junk after the stream ends: what we have is the tile */ }
  return out;
}

function unRle(r: Reader, out: Uint8Array, plane: number, bpp: number, count: number) {
  let n = 0;
  while (n < count) {
    let op = r.u8();
    if (op >= 128) {
      const len = op === 128 ? r.u16() : 256 - op;
      for (let k = 0; k < len && n < count; k++) out[n++ * bpp + plane] = r.u8();
    } else {
      const len = op === 127 ? r.u16() : op + 1;
      op = r.u8();
      for (let k = 0; k < len && n < count; k++) out[n++ * bpp + plane] = op;
    }
  }
}

/**
 * Reads a hierarchy (a layer's or mask's pixels) into interleaved samples: `bpp` bytes per pixel.
 * Tiles are 64x64, row by row; each is RLE (per byte plane), zlib, or raw.
 */
async function readHierarchy(r: Reader, ptr: number, wide: boolean, comp: number): Promise<{ w: number; h: number; bpp: number; data: Uint8Array }> {
  r.pos = ptr;
  const w = r.u32(), h = r.u32(), bpp = r.u32();
  const levelPtrs: number[] = [];
  for (;;) { const p = wide ? r.u64() : r.u32(); if (!p) break; levelPtrs.push(p); }
  r.pos = levelPtrs[0];
  r.u32(); r.u32();
  const tiles: number[] = [];
  for (;;) { const p = wide ? r.u64() : r.u32(); if (!p) break; tiles.push(p); }
  const data = new Uint8Array(w * h * bpp);
  const tw = Math.ceil(w / 64);
  const bounds = [...tiles, ...levelPtrs.slice(1), r.length].sort((a, b) => a - b);
  for (let t = 0; t < tiles.length; t++) {
    const tx = (t % tw) * 64, ty = Math.floor(t / tw) * 64;
    const cw = Math.min(64, w - tx), ch = Math.min(64, h - ty);
    if (cw <= 0 || ch <= 0) continue;
    const count = cw * ch;
    let tile: Uint8Array;
    if (comp === 2) {
      const next = bounds.find((b) => b > tiles[t]) ?? r.length;
      tile = await inflateTile(new Uint8Array(r.buf, tiles[t], next - tiles[t]), count * bpp);
    } else if (comp === 1) {
      tile = new Uint8Array(count * bpp);
      r.pos = tiles[t];
      for (let p = 0; p < bpp; p++) unRle(r, tile, p, bpp, count);
    } else {
      tile = new Uint8Array(r.buf, tiles[t], count * bpp);
    }
    for (let y = 0; y < ch; y++) data.set(tile.subarray(y * cw * bpp, (y + 1) * cw * bpp), ((ty + y) * w + tx) * bpp);
  }
  return { w, h, bpp, data };
}

/** Interleaved samples to RGBA. Layer types: 0 RGB, 1 RGBA, 2 grey, 3 grey+alpha, 4 indexed, 5 indexed+alpha. */
function toRGBA(px: { w: number; h: number; data: Uint8Array }, type: number, fmt: Fmt, cmap: Uint8Array | null): PxBuf {
  const w = Math.max(1, px.w), h = Math.max(1, px.h);
  const d = new Uint8ClampedArray(w * h * 4), s = px.data, B = fmt.bytes;
  const comps = [3, 4, 1, 2, 1, 2][type] ?? 4;
  const indexed = type >= 4;
  const stride = indexed ? comps : comps * B;
  const cs = (p: number, i: number) => sampleTo8(s, p + i * B, B, fmt.float, fmt.linear);
  if (!s.length) return { w, h, data: d };
  for (let i = 0; i < px.w * px.h; i++) {
    const p = i * stride, o = i * 4;
    if (indexed) {
      const ix = s[p];
      d[o] = cmap?.[ix * 3] ?? 0; d[o + 1] = cmap?.[ix * 3 + 1] ?? 0; d[o + 2] = cmap?.[ix * 3 + 2] ?? 0;
      d[o + 3] = comps === 2 ? s[p + 1] : 255;
    } else if (comps >= 3) {
      d[o] = cs(p, 0); d[o + 1] = cs(p, 1); d[o + 2] = cs(p, 2);
      d[o + 3] = comps === 4 ? sampleTo8(s, p + 3 * B, B, fmt.float, false) : 255;
    } else {
      d[o] = d[o + 1] = d[o + 2] = cs(p, 0);
      d[o + 3] = comps === 2 ? sampleTo8(s, p + B, B, fmt.float, false) : 255;
    }
  }
  return { w, h, data: d };
}

interface Node { layer: XcfLayer; path: number[] }

export type FilterArg = number | string | number[];

/** A GIMP 3 non-destructive filter on a layer: its GEGL operation, how it's mixed in, and its settings. */
export interface XcfFilter { op: string; visible: boolean; opacity: number; mode: number; args: Record<string, FilterArg>; maskPtr: number }

/**
 * Reads a GIMP 3 filter ("effect"): name, icon, operation and region strings, then properties (visibility,
 * opacity, mode, and one FILTER_ARGUMENT property per setting), then the filter's mask pointer.
 */
function readFilter(r: Reader, ptr: number, wide: boolean): XcfFilter {
  r.pos = ptr;
  readString(r); readString(r);
  const op = readString(r);
  readString(r);
  const f: XcfFilter = { op, visible: true, opacity: 1, mode: 62, args: {}, maskPtr: 0 };
  for (;;) {
    const type = r.u32(), len = r.u32();
    if (type === PROP.END) break;
    const end = r.pos + len;
    if (type === PROP.VISIBLE) f.visible = r.u32() !== 0;
    else if (type === PROP.FLOAT_OPACITY) f.opacity = r.f32();
    else if (type === PROP.MODE) f.mode = r.u32();
    else if (type === 45) {
      const name = readString(r), t = r.u32();
      const left = end - r.pos;
      if (t === 8) {
        // Colour: babl format name, then raw native (little-endian) floats.
        readString(r);
        const n = r.u32();
        const dv = new DataView(r.buf, r.pos, n);
        const v: number[] = [];
        for (let i = 0; i + 4 <= n; i += 4) v.push(dv.getFloat32(i, true));
        f.args[name] = v;
      } else if (t === 6) f.args[name] = readString(r);
      // 5 = enum (stored as its number), 1 = int, 2 = boolean, 3 = float.
      else if (left === 8) f.args[name] = new DataView(r.buf, r.pos, 8).getFloat64(0);
      else if (left === 4) f.args[name] = t === 3 ? r.f32() : r.i32();
      else f.args[name] = left;
    }
    r.pos = end;
  }
  f.maskPtr = wide ? r.u64() : r.u32();
  return f;
}

/** Filter pointers stored after a layer's mask pointer (GIMP 3 files). */
function readFilterPtrs(r: Reader, wide: boolean): number[] {
  const out: number[] = [];
  for (let i = 0; i < 64; i++) {
    const p = wide ? r.u64() : r.u32();
    if (!p || p >= r.length) break;
    out.push(p);
  }
  return out;
}

/**
 * Bakes a layer's GIMP filters into its pixels, oldest first. Each filter is mixed in by its opacity and its own
 * mask (white = full effect). Unknown filters are skipped and listed in the import notes.
 */
async function applyFilters(r: Reader, buf: PxBuf, filters: XcfFilter[], wide: boolean, comp: number, fmt: Fmt, notes: Set<string>, hasAlpha: boolean): Promise<PxBuf> {
  const { w, h } = buf;
  const px: Px = { w, h, d: Float32Array.from(buf.data, (v) => v / 255) };
  const applied: string[] = [], skipped: string[] = [];
  for (const f of filters) {
    const before = px.d.slice();
    if (!applyGimpFilter(px, f)) { skipped.push(f.op.split(':')[1]); if (skippedFilters.push(f) > 50) skippedFilters.shift(); continue; }
    applied.push(f.op.split(':')[1]);
    let mask: Uint8ClampedArray | null = null;
    if (f.maskPtr) {
      r.pos = f.maskPtr;
      r.u32(); r.u32(); readString(r); readProps(r);
      const mh = wide ? r.u64() : r.u32();
      const md = await readHierarchy(r, mh, wide, comp);
      if (md.w === w && md.h === h) mask = toRGBA(md, 2, fmt, null).data;
      // GIMP stores an all-black mask when a filter covers the whole layer (no selection): that means "no mask".
      if (mask && !mask.some((v, i) => i % 4 === 0 && v > 0)) mask = null;
    }
    const k0 = Math.max(0, Math.min(1, f.opacity));
    if (k0 < 1 || mask) {
      for (let i = 0; i < px.d.length; i += 4) {
        const k = k0 * (mask ? mask[i] / 255 : 1);
        if (k >= 1) continue;
        for (let c = 0; c < 4; c++) px.d[i + c] = before[i + c] + (px.d[i + c] - before[i + c]) * k;
      }
    }
  }
  // A GIMP layer without an alpha channel stays opaque whatever its filters do to transparency.
  if (!hasAlpha) for (let i = 3; i < px.d.length; i += 4) px.d[i] = 1;
  if (applied.length) notes.add('GIMP filters were applied to the layers they were on.');
  if (skipped.length) notes.add(`Some GIMP filters aren't supported yet and were left off: ${[...new Set(skipped)].join(', ')}.`);
  const data = new Uint8ClampedArray(px.d.length);
  for (let i = 0; i < data.length; i++) data[i] = Math.round(px.d[i] * 255);
  return { w, h, data };
}

/** Filters left off during imports (for checking new ones against GIMP). */
const skippedFilters: XcfFilter[] = [];
export const __xcfDebug = { readFilter, readFilterPtrs, readString, readProps, PROP, SPACES, skippedFilters };

/**
 * Reads a GIMP .xcf (GIMP 2.x and 3.x): layers with names, positions, opacity, visibility and blend modes, layer
 * groups, layer masks, guides, and high bit depths (converted to 8-bit), with GIMP 3 filters baked in. Text comes
 * in as pixels.
 */
export async function parseXcf(buf: ArrayBuffer): Promise<XcfResult> {
  const r = new Reader(buf);
  if (r.str(9) !== 'gimp xcf ') throw new Error('Not a GIMP file.');
  const tag = r.str(4);
  r.u8();
  const version = tag === 'file' ? 0 : parseInt(tag.slice(1), 10) || 0;
  const W = r.u32(), H = r.u32(), base = r.u32();
  const fmt = precision(version, version >= 4 ? r.u32() : 0);
  const wide = version >= 11;
  let comp = 0;
  let cmap: Uint8Array | null = null;
  const guides: Guide[] = [];
  const notes = new Set<string>();
  for (;;) {
    const type = r.u32(), len = r.u32();
    if (type === PROP.END) break;
    const end = r.pos + len;
    if (type === PROP.COMPRESSION) comp = r.u8();
    else if (type === PROP.COLORMAP) { const n = r.u32(); cmap = r.bytes(n * 3).slice(); }
    else if (type === PROP.GUIDES) for (let i = 0; i < len / 5; i++) { const pos = r.i32(), o = r.i8(); guides.push({ axis: o === 1 ? 'y' : 'x', pos }); }
    r.pos = end;
  }
  if (comp === 3) throw new Error('This GIMP file uses an unsupported compression.');
  if (base === 2 && !cmap) notes.add('Indexed colours without a palette were read as black.');
  const layerPtrs: number[] = [];
  for (;;) { const p = wide ? r.u64() : r.u32(); if (!p) break; layerPtrs.push(p); }

  const nodes: Node[] = [];
  let topIndex = 0;
  for (const ptr of layerPtrs) {
    r.pos = ptr;
    const lw = r.u32(), lh = r.u32(), type = r.u32();
    const lname = readString(r) || 'Layer';
    const p = readProps(r);
    const hptr = wide ? r.u64() : r.u32();
    const mptr = wide ? r.u64() : r.u32();
    // GIMP 3 non-destructive filters follow (newest first), each with its own optional mask.
    const filters = version >= 20 ? readFilterPtrs(r, wide).map((fp) => readFilter(r, fp, wide)).filter((f) => f.visible).reverse() : [];
    const blend = MODES[p.mode] ?? APPROX[p.mode] ?? 'normal';
    // GIMP's non-legacy modes (2.10+) blend in linear light; legacy ones (below 23) don't.
    const linear = p.mode >= 23 && p.mode !== 61;
    if (APPROX[p.mode] !== undefined) notes.add('Some GIMP blend modes were replaced with the closest match.');
    if (p.text) notes.add('Text layers come in as pixels.');
    let mask: XcfLayer['mask'] = null;
    if (mptr) {
      r.pos = mptr;
      r.u32(); r.u32(); readString(r); readProps(r);
      const mh = wide ? r.u64() : r.u32();
      const md = toRGBA(await readHierarchy(r, mh, wide, comp), 2, fmt, null);
      // Grey mask values become alpha.
      const a = md.data;
      for (let k = 0; k < a.length; k += 4) { a[k + 3] = a[k]; a[k] = a[k + 1] = a[k + 2] = 255; }
      mask = { px: md, x: p.x, y: p.y, enabled: p.applyMask };
    }
    const path = p.path ?? [topIndex++];
    const base0 = { name: lname, visible: p.visible, opacity: Math.max(0, Math.min(1, p.opacity)), mask, linear, children: [], x: p.x, y: p.y };
    if (p.group) {
      if (filters.length) notes.add(`Filters on groups aren't supported yet (${[...new Set(filters.map((f) => f.op.split(':')[1]))].join(', ')}).`);
      nodes.push({ layer: { ...base0, group: true, open: p.expanded, blend: p.mode === 61 ? 'pass-through' : blend, px: null }, path });
    } else {
      const raw = await readHierarchy(r, hptr, wide, comp);
      let px = toRGBA(raw.w ? raw : { w: lw, h: lh, data: new Uint8Array(0) }, type, fmt, cmap);
      if (filters.length && raw.w > 0 && raw.h > 0) px = await applyFilters(r, px, filters, wide, comp, fmt, notes, type % 2 === 1);
      nodes.push({ layer: { ...base0, group: false, open: false, blend: blend === 'pass-through' ? 'normal' : blend, px }, path });
    }
  }

  // Rebuild the tree from item paths (index 0 = top). AMxPixl lists layers bottom to top.
  const byPath = new Map(nodes.map((n) => [n.path.join('/'), n]));
  const roots: Node[] = [];
  const kids = new Map<Node, Node[]>();
  for (const n of nodes) {
    const parent = n.path.length > 1 ? byPath.get(n.path.slice(0, -1).join('/')) : undefined;
    if (parent && parent.layer.group) { if (!kids.has(parent)) kids.set(parent, []); kids.get(parent)!.push(n); }
    else roots.push(n);
  }
  const build = (list: Node[]): XcfLayer[] => [...list].sort((a, b) => b.path[b.path.length - 1] - a.path[a.path.length - 1]).map((n) => {
    if (n.layer.group) n.layer.children = build(kids.get(n) ?? []);
    return n.layer;
  });
  if (fmt.bytes > 1) notes.add(`High bit depth (${fmt.bytes * 8}-bit${fmt.float ? ' float' : ''}) was converted to 8-bit.`);
  return { W, H, guides, notes: [...notes], layers: build(roots), count: nodes.length };
}

/** The pixel buffers in a parse result (to hand them over from the worker without copying). */
export function xcfBuffers(r: XcfResult): ArrayBuffer[] {
  const out: ArrayBuffer[] = [];
  const walk = (ls: XcfLayer[]) => { for (const l of ls) { if (l.px) out.push(l.px.data.buffer as ArrayBuffer); if (l.mask) out.push(l.mask.px.data.buffer as ArrayBuffer); walk(l.children); } };
  walk(r.layers);
  return out;
}
