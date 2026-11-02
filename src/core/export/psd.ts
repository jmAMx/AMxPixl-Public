import type { Doc } from '../document';
import { ctx2d, newCanvas } from '../layers';
import { intersect, mapRect, mul, roundOut, scale, translate, union, xformMatrix, type Mat, type Rect } from '../math';
import { flatten, renderDoc } from '../render';
import { isFilter, isPlaced, type BlendMode, type GroupLayer, type Layer, type Mask } from '../types';
import { fxDef } from '../effects';
import { ADJ_LABELS } from '../adjustments';

/**
 * Writing a Photoshop file (.psd, 8 bits a channel, RGB) that keeps the layers: groups (open or closed, pass-through
 * or not), names, visibility, opacity, blend modes, clipping, masks and Blend If. What Photoshop can't take as it is
 * goes in as pixels that look the same: text, shapes, 3D, warps and layer styles become the layer's pixels, and an
 * adjustment or effect layer becomes a pixel layer of the picture as it looks with it (the layers it changes stay
 * below, so they can still be edited). Layers past the canvas edge keep what's outside it.
 */

export interface PsdOpts { scale: number; nearest?: boolean }

const BLEND_KEY: Record<BlendMode, string> = {
  normal: 'norm', multiply: 'mul ', screen: 'scrn', overlay: 'over', darken: 'dark', lighten: 'lite', 'color-dodge': 'div ',
  'color-burn': 'idiv', 'hard-light': 'hLit', 'soft-light': 'sLit', difference: 'diff', exclusion: 'smud', hue: 'hue ',
  saturation: 'sat ', color: 'colr', luminosity: 'lum ', 'pass-through': 'pass',
};

/** One layer record, as Photoshop lists them (bottom to top). */
interface Rec {
  name: string; blend: string; opacity: number; hidden: boolean; clip: boolean;
  /** Pixels (straight RGBA) and where they are on the canvas; none for groups. */
  rect: Rect; rgba: Uint8ClampedArray | null;
  mask: { rect: Rect; data: Uint8Array; disabled: boolean } | null;
  /** Group records: 1 open, 2 closed (the group itself, above its layers), 3 the end marker below them. */
  section?: 1 | 2 | 3;
  ranges?: { self: number[]; under: number[] };
}

// ---------- bytes ----------

/** A growing big-endian byte buffer. */
class Out {
  buf = new Uint8Array(4096);
  len = 0;
  private room(n: number) {
    if (this.len + n <= this.buf.length) return;
    let size = this.buf.length * 2;
    while (size < this.len + n) size *= 2;
    const b = new Uint8Array(size); b.set(this.buf.subarray(0, this.len)); this.buf = b;
  }
  u8(v: number) { this.room(1); this.buf[this.len++] = v & 255; }
  u16(v: number) { this.u8(v >> 8); this.u8(v); }
  u32(v: number) { this.u16((v >>> 16) & 0xffff); this.u16(v & 0xffff); }
  i32(v: number) { this.u32(v >>> 0); }
  str(s: string) { for (let i = 0; i < s.length; i++) this.u8(s.charCodeAt(i)); }
  bytes(b: Uint8Array) { this.room(b.length); this.buf.set(b, this.len); this.len += b.length; }
  pad(to: number) { while (this.len % to) this.u8(0); }
  /** Writes a length field now and fills it in once `body` has written what it measures. */
  sized(body: () => void, padTo = 1) {
    const at = this.len; this.u32(0);
    body();
    this.pad(padTo);
    const n = this.len - at - 4;
    this.buf[at] = n >>> 24; this.buf[at + 1] = (n >>> 16) & 255; this.buf[at + 2] = (n >>> 8) & 255; this.buf[at + 3] = n & 255;
  }
  done() { return this.buf.slice(0, this.len); }
}

/** One channel's rows packed with PackBits (Photoshop's RLE): the byte count of each row, then the rows. */
function packRows(plane: Uint8Array, w: number, h: number): { counts: Uint16Array; data: Uint8Array } {
  const counts = new Uint16Array(h);
  const out = new Uint8Array(h * (w + Math.ceil(w / 128) + 1));
  let o = 0;
  for (let y = 0; y < h; y++) {
    const row = y * w, start = o;
    let i = 0;
    while (i < w) {
      // A run of the same byte (3 or more) becomes 2 bytes; anything else is copied as it is, up to 128 at a time.
      let run = 1;
      while (i + run < w && run < 128 && plane[row + i + run] === plane[row + i]) run++;
      if (run >= 3) { out[o++] = 257 - run; out[o++] = plane[row + i]; i += run; continue; }
      let lit = 0;
      while (i + lit < w && lit < 128) {
        if (i + lit + 2 < w && plane[row + i + lit] === plane[row + i + lit + 1] && plane[row + i + lit] === plane[row + i + lit + 2]) break;
        lit++;
      }
      out[o++] = lit - 1;
      out.set(plane.subarray(row + i, row + i + lit), o); o += lit; i += lit;
    }
    counts[y] = o - start;
  }
  return { counts, data: out.subarray(0, o) };
}

/** A channel of a layer: compression 1 (RLE), the row counts, the rows. */
function channelBytes(plane: Uint8Array, w: number, h: number): Uint8Array {
  if (!w || !h) return new Uint8Array([0, 0]); // empty: raw, nothing
  const { counts, data } = packRows(plane, w, h);
  const b = new Uint8Array(2 + h * 2 + data.length);
  b[1] = 1;
  for (let y = 0; y < h; y++) { b[2 + y * 2] = counts[y] >> 8; b[3 + y * 2] = counts[y] & 255; }
  b.set(data, 2 + h * 2);
  return b;
}

const planeOf = (rgba: Uint8ClampedArray, c: number) => { const p = new Uint8Array(rgba.length / 4); for (let i = 0; i < p.length; i++) p[i] = rgba[i * 4 + c]; return p; };

// ---------- pixels ----------

/** The smallest rectangle (inside `r`'s pixels) holding anything not fully transparent; null if there's nothing. */
function trim(px: Uint8ClampedArray, w: number, h: number): Rect | null {
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (!px[(y * w + x) * 4 + 3]) continue;
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

function cropPx(px: Uint8ClampedArray, w: number, r: Rect): Uint8ClampedArray {
  const o = new Uint8ClampedArray(r.w * r.h * 4);
  for (let y = 0; y < r.h; y++) o.set(px.subarray(((r.y + y) * w + r.x) * 4, ((r.y + y) * w + r.x + r.w) * 4), y * r.w * 4);
  return o;
}

/** Draws `layers` (with the export's scale) over the canvas rectangle `r` (output pixels) and reads the pixels back. */
function draw(doc: Doc, layers: Layer[], view: Mat, r: Rect, o: PsdOpts, all: boolean): Uint8ClampedArray {
  const c = newCanvas(r.w, r.h);
  renderDoc(doc, c, mul(translate(-r.x, -r.y), view), { layers, includeHidden: all, clip: false, nearest: o.nearest });
  return ctx2d(c, true).getImageData(0, 0, r.w, r.h).data;
}

/** A mask as Photoshop keeps it (grey: white shows), over `r`, with its density and feathering worked in. */
function maskOver(doc: Doc, m: Mask, view: Mat, r: Rect, s: number): { rect: Rect; data: Uint8Array; disabled: boolean } {
  const c = newCanvas(r.w, r.h);
  const x = ctx2d(c, true);
  const src = doc.pool.get(m.key);
  if (src) {
    const t = mul(mul(translate(-r.x, -r.y), view), xformMatrix(m.t));
    x.save();
    x.setTransform(t[0], t[1], t[2], t[3], t[4], t[5]);
    if (m.feather > 0) x.filter = `blur(${m.feather * s}px)`;
    x.drawImage(src, 0, 0);
    x.restore();
  }
  if (m.density < 1) { x.fillStyle = `rgba(255,255,255,${1 - m.density})`; x.fillRect(0, 0, r.w, r.h); }
  const px = x.getImageData(0, 0, r.w, r.h).data;
  const data = new Uint8Array(r.w * r.h);
  for (let i = 0; i < data.length; i++) data[i] = px[i * 4 + 3];
  return { rect: r, data, disabled: !m.enabled };
}

/**
 * Filter layer `l`'s reach: what to draw for the picture just after it (`after`) and just before it (`before`), cut
 * off there, and the layers it changes that come before it in the file (`below`): the layer it's clipped to and those
 * clipped with it, its group's layers, or everything below it (through pass-through groups).
 */
function scopeOf(doc: Doc, l: Layer): { after: Layer[]; before: Layer[]; below: Layer[] } {
  const at = doc.locate(l.id)!;
  if (l.clip) {
    let b = at.index; while (b > 0 && at.list[b].clip) b--;
    const below = at.list.slice(b, at.index);
    return { after: [...below, l], before: below, below };
  }
  let after: Layer[] = at.list.slice(0, at.index + 1), before: Layer[] = at.list.slice(0, at.index);
  const below = [...before];
  let g: GroupLayer | null = at.parent;
  while (g && g.blend === 'pass-through') {
    const up = doc.locate(g.id)!;
    const under = up.list.slice(0, up.index);
    after = [...under, { ...g, children: after }];
    before = [...under, { ...g, children: before }];
    below.push(...under);
    g = up.parent;
  }
  return { after, before, below };
}

// ---------- writing ----------

/** The document as a Photoshop file, and notes on what had to change on the way. */
export async function encodePsd(doc: Doc, o: PsdOpts): Promise<{ blob: Blob; notes: string[] }> {
  const s = o.scale, W = Math.round(doc.width * s), H = Math.round(doc.height * s);
  if (W > 30000 || H > 30000) throw new Error('Photoshop files can be at most 30,000 pixels a side. Export at a smaller size.');
  const view = scale(s, s) as Mat;
  const canvas: Rect = { x: 0, y: 0, w: W, h: H };
  // Layers past the canvas keep what's outside it, up to a canvas's width (and height) beyond each edge.
  const reach: Rect = { x: -W, y: -H, w: W * 3, h: H * 3 };
  const notes = new Set<string>();
  const recs: Rec[] = [];
  /** Each layer's record (a group's is its top one), to hide it later if a filter's result replaces it. */
  const recOf = new Map<string, Rec>();
  const add = (l: Layer, rec: Rec) => { recs.push(rec); recOf.set(l.id, rec); };
  const pause = () => new Promise((r) => setTimeout(r, 0));

  const base = (l: Layer): Omit<Rec, 'rect' | 'rgba' | 'mask'> => ({
    name: l.name, blend: BLEND_KEY[l.blend] ?? 'norm', opacity: Math.round(l.opacity * 255), hidden: !doc.shows(l), clip: !!l.clip,
    ranges: l.blendIf?.on ? { self: [...l.blendIf.self], under: [...l.blendIf.under] } : undefined,
  });

  const walk = async (list: Layer[]) => {
    for (let i = 0; i < list.length; i++) {
      const l = list[i];
      if (l.type === 'raster' && l.depth) { notes.add('Depth layers were left out (they\'re for depth effects, not part of the picture).'); continue; }
      if (l.type === 'group') {
        recs.push({ name: '</Layer group>', blend: 'norm', opacity: 255, hidden: false, clip: false, rect: { x: 0, y: 0, w: 0, h: 0 }, rgba: null, mask: null, section: 3 });
        await walk(l.children);
        add(l, { ...base(l), rect: { x: 0, y: 0, w: 0, h: 0 }, rgba: null, mask: l.mask ? maskOver(doc, l.mask, view, canvas, s) : null, section: l.open ? 1 : 2 });
        if (l.styles && Object.values(l.styles).some((st) => (st as { on?: boolean }).on)) notes.add('Layer styles on groups were left out.');
        continue;
      }
      if (isFilter(l)) {
        if (!doc.shows(l)) { notes.add('Hidden adjustment and effect layers were left out.'); continue; }
        // The picture as it looks with it, in its reach (opacity and mask included), as a pixel layer.
        const sc = scopeOf(doc, l);
        const px = draw(doc, sc.after, view, canvas, o, false);
        const t = trim(px, W, H);
        const label = l.type === 'effect' ? fxDef(l.fx.kind)?.label : ADJ_LABELS[l.adj.kind];
        add(l, { name: `${l.name || label} (as pixels)`, blend: 'norm', opacity: 255, hidden: false, clip: !!l.clip,
          rect: t ?? { x: 0, y: 0, w: 0, h: 0 }, rgba: t ? cropPx(px, W, t) : null, mask: null });
        notes.add('Adjustment and effect layers became pixel layers showing their result ("… (as pixels)"), with the layers they change kept below them.');
        // The layers it changes stay in the file. Where the result covers them fully (over an opaque background, say)
        // they can stay on; where it doesn't (a blur's soft edge on a see-through layer), they'd show through, so
        // they're hidden, as the result replaces them.
        const pre = draw(doc, sc.before, view, canvas, o, false);
        let covered = true;
        for (let i = 3; i < pre.length && covered; i += 4) if (pre[i] && px[i] < 254) covered = false;
        if (!covered) {
          for (const b of sc.below) { const rec = recOf.get(b.id); if (rec) rec.hidden = true; }
          notes.add('Where such a result doesn\'t fully cover the layers it changes, those layers are hidden (turn them on to work on them).');
        }
        await pause();
        continue;
      }
      // A layer by itself, as it looks (its own pixels, styles, text, shape, 3D or warp), without its opacity, blend,
      // mask, clipping or Blend If, which the file keeps as settings.
      const st = l.styles;
      const styled = !!st && (st.shadow.on || st.glow.on || st.innerGlow.on || st.stroke.on || st.overlay?.on);
      // Styles follow the masked shape (a shadow runs along the mask's edge, unmasked), so a layer with both has its
      // mask merged in with them; any other mask stays a mask.
      const keepMask = !!l.mask && !styled;
      const alone = { ...l, opacity: 1, blend: 'normal', mask: keepMask ? null : l.mask, clip: false, visible: true, blendIf: null } as Layer;
      let r = canvas;
      if (isPlaced(l)) r = intersect(union(canvas, roundOut(mapRect(view, doc.layerBounds(l)))), reach) ?? canvas;
      if (st && styled) {
        const pad = Math.ceil(Math.max(st.shadow.on ? st.shadow.distance + st.shadow.size * 3 : 0, st.glow.on ? st.glow.size * 3 : 0, st.stroke.on ? st.stroke.size * 2 : 0) * s);
        if (pad) r = intersect({ x: r.x - pad, y: r.y - pad, w: r.w + pad * 2, h: r.h + pad * 2 }, reach) ?? r;
        notes.add('Layer styles were merged into their layers\' pixels.');
        if (l.mask) notes.add('On layers with both a mask and styles, the mask was merged in too (the styles follow its shape).');
      }
      if (l.type === 'text' || l.type === 'shape') notes.add('Text and shape layers were saved as pixels.');
      if (l.type === 'raster' && l.model) notes.add('3D layers were saved as pixels.');
      // A layer's styles apply to it and everything clipped to it together, so with styles those go in as one layer.
      const clipped: Layer[] = [];
      if (styled) while (i + 1 < list.length && list[i + 1].clip) clipped.push(list[++i]);
      if (clipped.length) notes.add('A layer with styles and the layers clipped to it were merged into one layer (its styles apply to them all).');
      const px = draw(doc, [alone, ...clipped], view, r, o, !clipped.length);
      const t = trim(px, r.w, r.h);
      add(l, {
        ...base(l),
        rect: t ? { x: r.x + t.x, y: r.y + t.y, w: t.w, h: t.h } : { x: 0, y: 0, w: 0, h: 0 },
        rgba: t ? cropPx(px, r.w, t) : null,
        mask: keepMask && l.mask ? maskOver(doc, l.mask, view, r, s) : null,
      });
      await pause();
    }
  };
  await walk(doc.layers);

  // Layer records, then every layer's channel data in the same order.
  const head = new Out();
  head.u16(0); // count, filled in below
  const chanData: Uint8Array[] = [];
  for (const rec of recs) {
    const { rect: r } = rec;
    const chans: { id: number; data: Uint8Array }[] = [];
    for (const [id, c] of [[-1, 3], [0, 0], [1, 1], [2, 2]] as const) {
      chans.push({ id, data: rec.rgba ? channelBytes(planeOf(rec.rgba, c), r.w, r.h) : new Uint8Array([0, 0]) });
    }
    if (rec.mask) chans.push({ id: -2, data: channelBytes(rec.mask.data, rec.mask.rect.w, rec.mask.rect.h) });
    head.i32(r.y); head.i32(r.x); head.i32(r.y + r.h); head.i32(r.x + r.w);
    head.u16(chans.length);
    for (const c of chans) { head.u16(c.id & 0xffff); head.u32(c.data.length); chanData.push(c.data); }
    head.str('8BIM'); head.str(rec.blend);
    head.u8(rec.opacity); head.u8(rec.clip ? 1 : 0);
    head.u8((rec.hidden ? 2 : 0) | 8 | (rec.section ? 16 : 0)); head.u8(0);
    head.sized(() => {
      // Mask: its rectangle, what's outside it (hidden), and whether it's turned off.
      head.sized(() => {
        if (!rec.mask) return;
        const m = rec.mask.rect;
        head.i32(m.y); head.i32(m.x); head.i32(m.y + m.h); head.i32(m.x + m.w);
        head.u8(0); head.u8(rec.mask.disabled ? 2 : 0); head.u16(0);
      });
      // Blending ranges (Blend If): grey first (this layer, then what's under it), then each channel left open.
      head.sized(() => {
        const g = rec.ranges;
        // (Both keep a range as black, where its fade ends, where the white fade starts, white.)
        const pair = (r: number[]) => { for (const v of r) head.u8(Math.max(0, Math.min(255, Math.round(v)))); };
        pair(g ? g.self : [0, 0, 255, 255]); pair(g ? g.under : [0, 0, 255, 255]);
        for (let i = 0; i < 4; i++) { pair([0, 0, 255, 255]); pair([0, 0, 255, 255]); }
      });
      // The name, in old single-byte form (Pascal string, padded to 4) and in full (luni).
      const latin = [...rec.name].map((ch) => (ch.charCodeAt(0) < 256 ? ch : '?')).join('').slice(0, 255);
      head.u8(latin.length); head.str(latin);
      for (let i = 0; i < (4 - ((latin.length + 1) % 4)) % 4; i++) head.u8(0);
      head.str('8BIM'); head.str('luni');
      head.sized(() => { head.u32(rec.name.length); for (let i = 0; i < rec.name.length; i++) head.u16(rec.name.charCodeAt(i)); }, 2);
      if (rec.section) {
        head.str('8BIM'); head.str('lsct');
        head.sized(() => { head.u32(rec.section!); head.str('8BIM'); head.str(rec.section === 3 ? 'norm' : rec.blend); });
      }
    });
  }
  const headBytes = head.done();
  const n = -recs.length; // negative: the merged image's fourth channel is its transparency
  headBytes[0] = (n >> 8) & 255; headBytes[1] = n & 255;

  // The merged picture, for readers that don't read layers (and Photoshop's preview): RLE, every row count first.
  const flat = ctx2d(flatten(doc, s, { nearest: o.nearest }), true).getImageData(0, 0, W, H).data;
  const planes = [0, 1, 2, 3].map((c) => packRows(planeOf(flat, c), W, H));
  const counts = new Uint8Array(4 * H * 2);
  planes.forEach((p, c) => { for (let y = 0; y < H; y++) { counts[(c * H + y) * 2] = p.counts[y] >> 8; counts[(c * H + y) * 2 + 1] = p.counts[y] & 255; } });

  const top = new Out();
  top.str('8BPS'); top.u16(1); top.u32(0); top.u16(0);
  top.u16(4); top.u32(H); top.u32(W); top.u16(8); top.u16(3);
  top.u32(0); // colour mode data
  // Image resources: resolution (72 pixels an inch).
  top.sized(() => {
    top.str('8BIM'); top.u16(1005); top.u16(0);
    top.sized(() => { top.u32(72 << 16); top.u16(1); top.u16(1); top.u32(72 << 16); top.u16(1); top.u16(1); });
  });
  const chanLen = chanData.reduce((a, b) => a + b.length, 0);
  const liLen = headBytes.length + chanLen;
  const liPad = (4 - (liLen % 4)) % 4;
  top.u32(4 + liLen + liPad + 4); // layer and mask info
  top.u32(liLen + liPad); // layer info
  const tail = new Out();
  for (let i = 0; i < liPad; i++) tail.u8(0);
  tail.u32(0); // global layer mask info
  tail.u16(1); // merged image: RLE
  const parts = [top.done(), headBytes, ...chanData, tail.done(), counts, ...planes.map((p) => p.data)] as BlobPart[];
  const blob = new Blob(parts, { type: 'image/vnd.adobe.photoshop' });
  return { blob, notes: [...notes] };
}
