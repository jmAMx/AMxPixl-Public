import { Doc, newId } from '../document';
import { ctx2d, newCanvas } from '../layers';
import type { BlendMode, GroupLayer, Layer, Mask, RasterLayer } from '../types';
import { inflate, Reader, sampleTo8 } from './reader';

/** Photoshop blend mode keys. Modes AMxPixl doesn't have map to the closest one (and are reported). */
const BLEND: Record<string, BlendMode> = {
  norm: 'normal', diss: 'normal', dark: 'darken', 'mul ': 'multiply', idiv: 'color-burn', lbrn: 'multiply', dkCl: 'darken',
  lite: 'lighten', scrn: 'screen', 'div ': 'color-dodge', lddg: 'screen', lgCl: 'lighten', over: 'overlay', sLit: 'soft-light',
  hLit: 'hard-light', vLit: 'hard-light', lLit: 'hard-light', pLit: 'hard-light', hMix: 'hard-light', diff: 'difference',
  smud: 'exclusion', fsub: 'difference', fdiv: 'color-dodge', 'hue ': 'hue', 'sat ': 'saturation', colr: 'color', 'lum ': 'luminosity',
  pass: 'pass-through',
};
const APPROX = new Set(['diss', 'lbrn', 'dkCl', 'lddg', 'lgCl', 'vLit', 'lLit', 'pLit', 'hMix', 'fsub', 'fdiv']);
/** Additional-info keys of adjustment and fill layers, which have no pixels of their own. */
const ADJUST_KEYS = new Set(['levl', 'curv', 'brit', 'blnc', 'hue ', 'hue2', 'selc', 'mixr', 'grdm', 'phfl', 'expA', 'vibA', 'thrs', 'nvrt', 'post', 'blwh', 'clrL', 'SoCo', 'GdFl', 'PtFl']);

interface ChanInfo { id: number; len: number }
interface Rec {
  top: number; left: number; bottom: number; right: number; chans: ChanInfo[]; blend: string; opacity: number;
  clipping: boolean; hidden: boolean; name: string; divider: number; mask: { top: number; left: number; bottom: number; right: number; def: number; disabled: boolean } | null;
  adjust: boolean;
}

/** Reads one channel's pixels (any compression) as `w*h*bytes` raw samples. */
async function readChannel(r: Reader, len: number, w: number, h: number, bytes: number, psb: boolean): Promise<Uint8Array> {
  const end = r.pos + len;
  const comp = r.u16();
  const size = w * h * bytes;
  let out: Uint8Array;
  if (comp === 0) out = r.bytes(Math.min(size, end - r.pos)).slice();
  else if (comp === 1) {
    const counts: number[] = [];
    for (let i = 0; i < h; i++) counts.push(psb ? r.u32() : r.u16());
    out = new Uint8Array(size);
    const rowLen = w * bytes;
    for (let y = 0; y < h; y++) unpackBits(r.bytes(counts[y]), out, y * rowLen, rowLen);
  } else {
    out = await inflate(r.bytes(end - r.pos));
    if (comp === 3) unpredict(out, w, h, bytes);
  }
  r.pos = end;
  return out.length >= size ? out : (() => { const o = new Uint8Array(size); o.set(out); return o; })();
}

function unpackBits(src: Uint8Array, out: Uint8Array, o: number, max: number) {
  let i = 0, n = 0;
  while (i < src.length && n < max) {
    const h = src[i++];
    if (h < 128) { for (let k = 0; k <= h && n < max; k++) out[o + n++] = src[i++]; }
    else if (h > 128) { const v = src[i++]; for (let k = 0; k < 257 - h && n < max; k++) out[o + n++] = v; }
  }
}

/** Undo "zip with prediction": each sample stored as the difference from its left neighbour. */
function unpredict(d: Uint8Array, w: number, h: number, bytes: number) {
  if (bytes === 1) { for (let y = 0; y < h; y++) for (let x = 1; x < w; x++) d[y * w + x] = (d[y * w + x] + d[y * w + x - 1]) & 255; }
  else if (bytes === 2) {
    for (let y = 0; y < h; y++) for (let x = 1; x < w; x++) {
      const p = (y * w + x) * 2, q = p - 2;
      const v = (((d[p] << 8) | d[p + 1]) + ((d[q] << 8) | d[q + 1])) & 0xffff;
      d[p] = v >> 8; d[p + 1] = v & 255;
    }
  }
  // 32-bit prediction byte-shuffles each row; rare enough to leave as-is.
}

function toCanvas(w: number, h: number, chans: Map<number, Uint8Array>, mode: number, bytes: number, float: boolean, palette: Uint8Array | null): HTMLCanvasElement {
  const c = newCanvas(w, h);
  if (w <= 0 || h <= 0) return c;
  const img = new ImageData(w, h);
  const d = img.data;
  const lin = float; // 32-bit Photoshop files are linear light
  const g = (id: number, i: number, linear = lin) => { const ch = chans.get(id); return ch ? sampleTo8(ch, i * bytes, bytes, float, linear) : -1; };
  for (let i = 0; i < w * h; i++) {
    let r: number, gg: number, b: number;
    if (mode === 3) { r = g(0, i); gg = g(1, i); b = g(2, i); }
    else if (mode === 4) {
      // CMYK is stored inverted (255 = no ink).
      const k = g(3, i, false) / 255;
      r = (g(0, i, false) / 255) * k * 255; gg = (g(1, i, false) / 255) * k * 255; b = (g(2, i, false) / 255) * k * 255;
    } else if (mode === 2 && palette) { const ix = chans.get(0)![i]; r = palette[ix]; gg = palette[256 + ix]; b = palette[512 + ix]; }
    else { r = gg = b = g(0, i); }
    const a = g(-1, i, false);
    d[i * 4] = r; d[i * 4 + 1] = gg; d[i * 4 + 2] = b; d[i * 4 + 3] = a < 0 ? 255 : a;
  }
  ctx2d(c).putImageData(img, 0, 0);
  return c;
}

/**
 * Opens a Photoshop .psd/.psb: layers with names, positions, opacity, visibility, blend modes, clipping, groups and
 * layer masks. Text and smart objects come in as their rendered pixels; adjustment and fill layers are skipped.
 */
export async function importPsd(buf: ArrayBuffer, name: string): Promise<Doc> {
  const r = new Reader(buf);
  if (r.str(4) !== '8BPS') throw new Error('Not a Photoshop file.');
  const version = r.u16();
  const psb = version === 2;
  r.skip(6);
  const nChannels = r.u16(), H = r.u32(), W = r.u32(), depth = r.u16(), mode = r.u16();
  if (![1, 2, 3, 4, 8].includes(mode)) throw new Error('Only RGB, CMYK, greyscale and indexed Photoshop files are supported.');
  if (depth === 1) throw new Error('1-bit bitmap Photoshop files are not supported.');
  const bytes = depth / 8, float = depth === 32;
  const cmLen = r.u32();
  const palette = mode === 2 ? r.bytes(cmLen).slice() : (r.skip(cmLen), null);
  r.skip(r.u32()); // image resources
  const doc = new Doc(name, W, H);
  const notes = new Set<string>();
  const lmLen = psb ? r.u64() : r.u32();
  const lmEnd = r.pos + lmLen;
  const recs: Rec[] = [];
  const pixels: { canvas: HTMLCanvasElement; mask: HTMLCanvasElement | null }[] = [];
  if (lmLen > 0) {
    const liLen = psb ? r.u64() : r.u32();
    const liEnd = r.pos + liLen;
    if (liLen > 0) {
      const count = Math.abs(r.i16());
      for (let i = 0; i < count; i++) {
        const rec: Rec = { top: r.i32(), left: r.i32(), bottom: r.i32(), right: r.i32(), chans: [], blend: '', opacity: 255, clipping: false, hidden: false, name: '', divider: 0, mask: null, adjust: false };
        const nc = r.u16();
        for (let c = 0; c < nc; c++) rec.chans.push({ id: r.i16(), len: psb ? r.u64() : r.u32() });
        r.skip(4); // '8BIM'
        rec.blend = r.str(4);
        rec.opacity = r.u8();
        rec.clipping = r.u8() === 1;
        rec.hidden = (r.u8() & 2) !== 0;
        r.skip(1);
        const exLen = r.u32(), exEnd = r.pos + exLen;
        const mLen = r.u32(), mEnd = r.pos + mLen;
        if (mLen >= 20) {
          const m = { top: r.i32(), left: r.i32(), bottom: r.i32(), right: r.i32(), def: r.u8(), disabled: false };
          m.disabled = (r.u8() & 2) !== 0;
          rec.mask = m;
        }
        r.pos = mEnd;
        r.skip(r.u32()); // blending ranges
        const nl = r.u8();
        rec.name = new TextDecoder('latin1').decode(r.bytes(nl));
        r.pos += (4 - ((nl + 1) % 4)) % 4;
        while (r.pos + 12 <= exEnd) {
          const sig = r.str(4);
          if (sig !== '8BIM' && sig !== '8B64') break;
          const key = r.str(4);
          const long = psb && ['LMsk', 'Lr16', 'Lr32', 'Layr', 'Mt16', 'Mt32', 'Mtrn', 'Alph', 'FMsk', 'lnk2', 'FEid', 'FXid', 'PxSD'].includes(key);
          const len = long ? r.u64() : r.u32();
          const at = r.pos;
          if (key === 'luni') { const n = r.u32(); let s = ''; for (let k = 0; k < n; k++) s += String.fromCharCode(r.u16()); rec.name = s.replace(/\0+$/, ''); }
          else if (key === 'lsct' || key === 'lsdk') { rec.divider = r.u32(); if (len >= 12) { r.skip(4); rec.blend = r.str(4); } }
          else if (ADJUST_KEYS.has(key)) rec.adjust = true;
          else if (key === 'TySh') notes.add('Text comes in as pixels.');
          else if (key === 'SoLd' || key === 'PlLd') notes.add('Smart objects come in as pixels.');
          r.pos = at + len;
          if ((r.pos - at) % 2) r.pos++;
        }
        r.pos = exEnd;
        recs.push(rec);
      }
      // Channel image data follows all the records, in the same order.
      for (const rec of recs) {
        const w = rec.right - rec.left, h = rec.bottom - rec.top;
        const chans = new Map<number, Uint8Array>();
        let maskData: Uint8Array | null = null;
        for (const ch of rec.chans) {
          if (ch.id === -2 && rec.mask) {
            const mw = rec.mask.right - rec.mask.left, mh = rec.mask.bottom - rec.mask.top;
            maskData = mw > 0 && mh > 0 ? await readChannel(r, ch.len, mw, mh, bytes, psb) : (r.skip(ch.len), null);
          } else if (ch.id < -2) r.skip(ch.len);
          else chans.set(ch.id, w > 0 && h > 0 ? await readChannel(r, ch.len, w, h, bytes, psb) : (r.skip(ch.len), new Uint8Array(0)));
        }
        let mask: HTMLCanvasElement | null = null;
        if (rec.mask && maskData) {
          const mw = rec.mask.right - rec.mask.left, mh = rec.mask.bottom - rec.mask.top;
          mask = toCanvas(mw, mh, new Map([[0, maskData]]), 1, bytes, float, null);
        }
        pixels.push({ canvas: toCanvas(w, h, chans, mode, bytes, float, palette), mask });
      }
      r.pos = liEnd;
    }
  }
  r.pos = lmEnd;

  // Build the layer tree: records run bottom to top; a "section divider" (3) opens a group that the
  // group's own record (1 = open, 2 = closed folder) closes further up.
  const stack: Layer[][] = [[]];
  recs.forEach((rec, i) => {
    const base = { name: rec.name || 'Layer', visible: !rec.hidden, opacity: rec.opacity / 255, blend: BLEND[rec.blend] ?? 'normal', clip: rec.clipping };
    if (APPROX.has(rec.blend)) notes.add('Some blend modes were replaced with the closest match.');
    let mask: Mask | null = null;
    const m = rec.mask, mc = pixels[i].mask;
    if (m && mc) {
      // Outside the mask's own rectangle Photoshop uses its default colour; ours hides, so cover the canvas too.
      const x0 = Math.min(0, m.left), y0 = Math.min(0, m.top), x1 = Math.max(W, m.right), y1 = Math.max(H, m.bottom);
      const full = newCanvas(x1 - x0, y1 - y0);
      const fx = ctx2d(full);
      if (m.def >= 128) { fx.fillStyle = '#fff'; fx.fillRect(0, 0, full.width, full.height); fx.clearRect(m.left - x0, m.top - y0, mc.width, mc.height); }
      // Grey levels become alpha.
      const a = ctx2d(mc, true).getImageData(0, 0, mc.width, mc.height);
      for (let k = 0; k < a.data.length; k += 4) { a.data[k + 3] = a.data[k]; a.data[k] = a.data[k + 1] = a.data[k + 2] = 255; }
      const ac = newCanvas(mc.width, mc.height);
      ctx2d(ac).putImageData(a, 0, 0);
      fx.drawImage(ac, m.left - x0, m.top - y0);
      mask = { key: doc.addCanvas(full), t: { x: x0, y: y0, sx: 1, sy: 1, rot: 0 }, enabled: !m.disabled, density: 1, feather: 0 };
    }
    if (rec.divider === 3) { stack.push([]); return; }
    if (rec.divider === 1 || rec.divider === 2) {
      const children = stack.length > 1 ? stack.pop()! : [];
      const g: GroupLayer = { id: newId(), type: 'group', ...base, blend: BLEND[rec.blend] ?? 'pass-through', children, open: rec.divider === 1, mask };
      stack[stack.length - 1].push(g);
      return;
    }
    if (rec.adjust) { notes.add('Adjustment and fill layers were skipped (add AMxPixl adjustment layers instead).'); return; }
    const l: RasterLayer = { id: newId(), type: 'raster', ...base, key: doc.addCanvas(pixels[i].canvas), t: { x: rec.left, y: rec.top, sx: 1, sy: 1, rot: 0 }, mask };
    stack[stack.length - 1].push(l);
  });
  while (stack.length > 1) { const c = stack.pop()!; stack[stack.length - 1].push(...c); }
  doc.layers = stack[0];

  if (!doc.layers.length) {
    // No layers: use the flattened image.
    const comp = r.u16();
    const chans = new Map<number, Uint8Array>();
    const counts: number[] = [];
    if (comp === 1) for (let i = 0; i < H * nChannels; i++) counts.push(psb ? r.u32() : r.u16());
    const ids = mode === 3 ? [0, 1, 2, -1] : mode === 4 ? [0, 1, 2, 3, -1] : [0, -1];
    for (let c = 0; c < nChannels && c < ids.length; c++) {
      const out = new Uint8Array(W * H * bytes);
      if (comp === 0) out.set(r.bytes(W * H * bytes));
      else if (comp === 1) for (let y = 0; y < H; y++) unpackBits(r.bytes(counts[c * H + y]), out, y * W * bytes, W * bytes);
      else throw new Error('Compressed flattened image data is not supported.');
      chans.set(ids[c], out);
    }
    const key = doc.addCanvas(toCanvas(W, H, chans, mode, bytes, float, palette));
    doc.layers = [{ id: newId(), type: 'raster', name: 'Background', visible: true, opacity: 1, blend: 'normal', key, t: { x: 0, y: 0, sx: 1, sy: 1, rot: 0 } }];
  }
  doc.activeId = doc.layers[doc.layers.length - 1]?.id ?? null;
  doc.counter = recs.length + 1;
  doc.importNotes = [...notes];
  doc.resetHistory('Import PSD');
  return doc;
}
