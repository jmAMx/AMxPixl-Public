import type { Doc } from './document';
import { cloneCanvas, cropCanvas, ctx2d, newCanvas } from './layers';
import { glops } from './glops';
import { apply, intersect, invert, matScale, mul, roundOut, setT, union, xformMatrix, type Mat, type Rect } from './math';
import { getTip, tipStamp } from './tips';
import type { PixelTarget } from './types';

export interface BrushOpts {
  color: string;
  size: number;
  hardness: number;
  opacity: number;
  flow: number;
  erase: boolean;
  pressure: boolean;
  /** Clone stamp: copy pixels from `offset` (document pixels) away instead of painting a colour. */
  clone?: { dx: number; dy: number };
  /** Healing brush: after cloning, match the surrounding colour and light (texture from the source, tone from here). */
  heal?: boolean;
  /** Clone/heal from this document-sized image of all visible layers instead of the target's own pixels. */
  sample?: HTMLCanvasElement | null;
  /** Anti-aliasing off: whole pixels only, like a pencil (pixel art). */
  aliased?: boolean;
  /** Brush tip texture (see tips.ts); missing or 'round' = the soft/hard round brush. */
  tip?: string;
  /** Distance between dabs as a fraction of the size (default 0.12). */
  spacing?: number;
  /** Random rotation of each dab, 0..1 (1 = any angle). */
  jitter?: number;
  /** Random offset of each dab, in brush sizes. */
  scatter?: number;
  /** Retouch brush instead of paint: changes the pixels under the stroke. `range` (dodge/burn): 0 shadows,
   * 1 midtones, 2 highlights. */
  retouch?: { mode: 'dodge' | 'burn' | 'blur' | 'sharpen' | 'smudge'; strength: number; range: number };
  /** Symmetry: every dab is repeated at each of these maps of its position (mirrors or turns, in document space). */
  copies?: Mat[];
}

const RETOUCH_MODE = { dodge: 0, burn: 1, blur: 2, sharpen: 3 } as const;

export interface StrokePoint { x: number; y: number; pressure: number }

const stampCache = new Map<string, HTMLCanvasElement>();

function makeStamp(color: string, diameter: number, hardness: number, flow: number) {
  const d = Math.max(2, Math.min(2048, Math.ceil(diameter)));
  const key = `${color}|${d}|${hardness.toFixed(2)}|${flow.toFixed(2)}`;
  const hit = stampCache.get(key);
  if (hit) return hit;
  if (stampCache.size > 24) stampCache.clear();
  const c = newCanvas(d, d);
  const ctx = ctx2d(c);
  const r = d / 2;
  const g = ctx.createRadialGradient(r, r, 0, r, r, r);
  const solid = Math.min(0.98, hardness);
  ctx.globalAlpha = flow;
  g.addColorStop(0, color);
  g.addColorStop(solid, color);
  g.addColorStop(1, color + '00');
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(r, r, r, 0, Math.PI * 2);
  ctx.fill();
  stampCache.set(key, c);
  return c;
}

/** A hard round tip `d` pixels across, every pixel fully on or off (small sizes come out square, like a pencil). */
function pixelStamp(color: string, d: number, flow: number) {
  const key = `px|${color}|${d}|${flow.toFixed(2)}`;
  const hit = stampCache.get(key);
  if (hit) return hit;
  if (stampCache.size > 24) stampCache.clear();
  const c = newCanvas(d, d);
  const ctx = ctx2d(c);
  ctx.globalAlpha = flow;
  ctx.fillStyle = color;
  const r = d / 2, lim = r * r + 0.5;
  for (let y = 0; y < d; y++) {
    const dy = y + 0.5 - r;
    let x0 = -1, x1 = -1;
    for (let x = 0; x < d; x++) { const dx = x + 0.5 - r; if (dx * dx + dy * dy <= lim) { if (x0 < 0) x0 = x; x1 = x; } }
    if (x0 >= 0) ctx.fillRect(x0, y, x1 - x0 + 1, 1);
  }
  stampCache.set(key, c);
  return c;
}

/** Draws just the `r` part of `src` at the same place (no scaling). */
function blit(ctx: CanvasRenderingContext2D, src: HTMLCanvasElement, r: Rect) {
  ctx.drawImage(src, r.x, r.y, r.w, r.h, r.x, r.y, r.w, r.h);
}

/** Replaces `rr` of the layer with the matching part of `res`, a result covering region `R`. */
function putBack(ctx: CanvasRenderingContext2D, res: HTMLCanvasElement, R: Rect, rr: Rect) {
  ctx.clearRect(rr.x, rr.y, rr.w, rr.h);
  ctx.drawImage(res, rr.x - R.x, rr.y - R.y, rr.w, rr.h, rr.x, rr.y, rr.w, rr.h);
}

/**
 * Fills transparent holes in `c` smoothly from the pixels around them ("pull-push"): halve it repeatedly (canvas
 * averaging weights each pixel by its alpha), then from the smallest level up, lay each level over the enlarged
 * one beneath it. Known pixels stay as they are; a hole takes a smooth blend of its edges at every scale.
 */
export function fillHoles(c: HTMLCanvasElement): HTMLCanvasElement {
  const levels = [c];
  while (levels.length < 14) {
    const p = levels[levels.length - 1];
    if (p.width <= 1 && p.height <= 1) break;
    const n = newCanvas(Math.ceil(p.width / 2), Math.ceil(p.height / 2));
    const x = ctx2d(n);
    x.imageSmoothingEnabled = true;
    x.imageSmoothingQuality = 'medium';
    x.drawImage(p, 0, 0, n.width, n.height);
    levels.push(n);
  }
  let cur = levels[levels.length - 1];
  for (let i = levels.length - 2; i >= 0; i--) {
    const out = cloneCanvas(levels[i]);
    const x = ctx2d(out);
    x.globalCompositeOperation = 'destination-over';
    x.imageSmoothingEnabled = true;
    x.imageSmoothingQuality = 'high';
    x.drawImage(cur, 0, 0, out.width, out.height);
    cur = out;
  }
  return cur;
}

/**
 * One brush or eraser stroke. Dabs collect in a buffer at full strength and are laid over a backup of the layer
 * at the stroke's opacity, so overlapping dabs never build past the opacity you set (like Photoshop).
 */
export class Stroke {
  private src: HTMLCanvasElement;
  private backup: HTMLCanvasElement;
  private buffer: HTMLCanvasElement;
  private mask: HTMLCanvasElement | null;
  private inv: Mat;
  private stamp: HTMLCanvasElement;
  private last: StrokePoint | null = null;
  private carry = 0;
  private dirty: Rect | null = null;
  private pxScale: number;
  private dabC = newCanvas(2, 2);

  constructor(private doc: Doc, private layer: PixelTarget, private o: BrushOpts) {
    if (!o.erase) doc.ensureCovers(layer);
    this.src = doc.canvasOf(layer);
    this.backup = cloneCanvas(this.src);
    this.buffer = newCanvas(this.src.width, this.src.height);
    this.mask = doc.maskForLayer(layer);
    const m = xformMatrix(layer.t);
    this.inv = invert(m);
    this.pxScale = Math.max(0.05, matScale(m));
    // Build the dab at the resolution it'll land at in the layer's own pixels.
    const color = o.erase ? '#000000' : o.clone || o.retouch ? '#ffffff' : o.color;
    const tip = o.clone || o.aliased ? null : getTip(o.tip);
    this.textured = !!tip;
    this.stamp = tip ? tipStamp(o.tip!, tip, color, o.size / this.pxScale, o.flow) : makeStamp(color, o.size / this.pxScale, o.hardness, o.flow);
  }

  private textured = false;

  /** One clone dab: a brush-shaped piece of the layer (as it was before this stroke) from the source point. */
  private cloneDab(bctx: CanvasRenderingContext2D, x: number, y: number, r: number): Rect {
    const { dx, dy } = this.o.clone!;
    const q = apply(this.inv, x, y), qs = apply(this.inv, x + dx, y + dy);
    const rr = r / this.pxScale;
    const size = Math.ceil(rr * 2) + 2;
    if (this.dabC.width < size || this.dabC.height < size) { this.dabC.width = size; this.dabC.height = size; }
    const d = ctx2d(this.dabC);
    d.globalCompositeOperation = 'copy';
    if (this.o.sample) {
      // Document-space image of all layers, mapped so the source point lands on this dab's centre.
      d.save();
      setT(d, mul(mul([1, 0, 0, 1, -(q.x - rr - 1), -(q.y - rr - 1)], this.inv), [1, 0, 0, 1, -dx, -dy]));
      d.imageSmoothingEnabled = true;
      d.drawImage(this.o.sample, 0, 0);
      d.restore();
    } else {
      d.drawImage(this.backup, -(qs.x - rr - 1), -(qs.y - rr - 1));
    }
    d.globalCompositeOperation = 'destination-in';
    d.drawImage(this.stamp, 1, 1, rr * 2, rr * 2);
    d.globalCompositeOperation = 'source-over';
    bctx.save();
    bctx.setTransform(1, 0, 0, 1, 0, 0);
    bctx.drawImage(this.dabC, 0, 0, size, size, q.x - rr - 1, q.y - rr - 1, size, size);
    bctx.restore();
    return { x: q.x - rr - 1, y: q.y - rr - 1, w: size, h: size };
  }

  /** The all-layers sample image, cut out and mapped into this layer's pixel grid for region `R`. */
  private sampleRegion(R: Rect) {
    const c = newCanvas(R.w, R.h);
    const x = ctx2d(c);
    setT(x, mul([1, 0, 0, 1, -R.x, -R.y], this.inv));
    x.imageSmoothingEnabled = true;
    x.drawImage(this.o.sample!, 0, 0);
    return c;
  }

  /**
   * Healing, live on the GPU: keep the cloned texture but take the broad colour and light from the destination.
   * Each pixel becomes clone + (surroundings of the destination - surroundings of the source), weighted by how
   * much was cloned. "Surroundings" fills the painted area (the flaw being covered) in from the stroke's edges,
   * like Photoshop's healing brush, so even the middle of a wide stroke takes the right tone. Only `rr` is rewritten.
   */
  private healRegion(rr: Rect) {
    const RING = 4;
    const pad = RING * 3;
    const R = intersect({ x: rr.x - pad, y: rr.y - pad, w: rr.w + pad * 2, h: rr.h + pad * 2 }, { x: 0, y: 0, w: this.src.width, h: this.src.height });
    if (!R) return;
    const cov = cropCanvas(this.buffer, R);
    // Only a thin ring just outside the painted area counts as "surroundings", so a dark patch further away
    // (or the far side of an edge) can't tint the result.
    const spread = newCanvas(R.w, R.h);
    const sx = ctx2d(spread);
    sx.filter = `blur(${RING}px)`;
    sx.drawImage(cov, 0, 0);
    const ringGl = glops.ramp(spread, 0.004, 0.02, [1, 1, 1]);
    const ring = ringGl ? cropCanvas(ringGl, { x: 0, y: 0, w: R.w, h: R.h }) : spread;
    // Keep the ring, cut the painted area out, then fill the hole smoothly in from the ring.
    const around = (c: HTMLCanvasElement) => {
      const x = ctx2d(c);
      x.setTransform(1, 0, 0, 1, 0, 0);
      x.globalCompositeOperation = 'destination-in';
      x.drawImage(ring, 0, 0);
      x.globalCompositeOperation = 'destination-out';
      x.drawImage(cov, 0, 0);
      return fillHoles(c);
    };
    const { dx, dy } = this.o.clone!;
    const C = cropCanvas(this.src, R);
    let D: HTMLCanvasElement, S: HTMLCanvasElement;
    if (this.o.sample) {
      D = this.sampleRegion(R);
      S = newCanvas(R.w, R.h);
      const x = ctx2d(S);
      setT(x, mul(mul([1, 0, 0, 1, -R.x, -R.y], this.inv), [1, 0, 0, 1, -dx, -dy]));
      x.imageSmoothingEnabled = true;
      x.drawImage(this.o.sample, 0, 0);
    } else {
      D = cropCanvas(this.backup, R);
      // The clone offset in this layer's own pixels.
      const a = apply(this.inv, 0, 0), b = apply(this.inv, dx, dy);
      S = newCanvas(R.w, R.h);
      ctx2d(S).drawImage(this.backup, -(R.x + b.x - a.x), -(R.y + b.y - a.y));
    }
    const res = glops.heal(C, around(S), around(D), cov, this.o.opacity);
    if (!res) return;
    putBack(ctx2d(this.src), res, R, rr);
  }

  /** Dodge, burn, blur or sharpen: the layer as it was before the stroke, changed where the stroke has been. */
  private retouchRegion(rr: Rect) {
    const rt = this.o.retouch!;
    const mode = RETOUCH_MODE[rt.mode as keyof typeof RETOUCH_MODE];
    const radius = Math.max(1, (this.o.size / this.pxScale) * 0.08);
    const pad = mode >= 2 ? Math.ceil(radius * 3) : 0;
    const R = intersect({ x: rr.x - pad, y: rr.y - pad, w: rr.w + pad * 2, h: rr.h + pad * 2 }, { x: 0, y: 0, w: this.src.width, h: this.src.height });
    if (!R) return;
    const B = cropCanvas(this.backup, R);
    let blurred = B;
    if (mode >= 2) {
      blurred = newCanvas(R.w, R.h);
      const x = ctx2d(blurred);
      x.filter = `blur(${radius}px)`;
      x.drawImage(B, 0, 0);
    }
    const res = glops.retouch(B, blurred, cropCanvas(this.buffer, R), mode, rt.strength, rt.range);
    if (!res) return;
    putBack(ctx2d(this.src), res, R, rr);
  }

  private smudgeBuf: HTMLCanvasElement | null = null;

  /**
   * One smudge dab: lay the colour carried from earlier in the stroke down here (shaped by the brush), then pick
   * up some of what's here to carry on. Works straight on the layer.
   */
  private smudgeDab(x: number, y: number, r: number): Rect {
    const q = apply(this.inv, x, y);
    const d = Math.max(2, Math.round((r * 2) / this.pxScale));
    const ox = Math.round(q.x - d / 2), oy = Math.round(q.y - d / 2);
    const k = this.o.retouch!.strength;
    if (!this.smudgeBuf || this.smudgeBuf.width !== d) {
      this.smudgeBuf = newCanvas(d, d);
      ctx2d(this.smudgeBuf).drawImage(this.src, -ox, -oy);
      return { x: ox, y: oy, w: d, h: d };
    }
    const dab = cloneCanvas(this.smudgeBuf);
    const dx = ctx2d(dab);
    dx.globalCompositeOperation = 'destination-in';
    dx.drawImage(this.stamp, 0, 0, d, d);
    const s = ctx2d(this.src);
    s.save();
    s.globalAlpha = k;
    s.drawImage(dab, ox, oy);
    s.restore();
    const b = ctx2d(this.smudgeBuf);
    b.globalAlpha = 1 - k;
    b.drawImage(this.src, -ox, -oy);
    b.globalAlpha = 1;
    return { x: ox, y: oy, w: d, h: d };
  }

  /** Puts `rr` back to how it was before the stroke wherever the selection doesn't reach. */
  private keepInside(rr: Rect) {
    const changed = cropCanvas(this.src, rr);
    const cx = ctx2d(changed);
    cx.globalCompositeOperation = 'destination-in';
    cx.drawImage(this.mask!, -rr.x, -rr.y);
    const s = ctx2d(this.src);
    s.clearRect(rr.x, rr.y, rr.w, rr.h);
    blit(s, this.backup, rr);
    s.drawImage(changed, rr.x, rr.y);
  }

  /** Redraws `rr` of the layer as it was before the stroke with the stroke so far on top. */
  private compose(rr: Rect) {
    if (this.o.retouch && this.o.retouch.mode !== 'smudge') { this.retouchRegion(rr); return; }
    // Only the rectangle is copied (drawing whole layer-sized images clipped to it is far slower on integrated GPUs).
    const s = ctx2d(this.src);
    s.save();
    s.clearRect(rr.x, rr.y, rr.w, rr.h);
    blit(s, this.backup, rr);
    s.globalCompositeOperation = this.o.erase ? 'destination-out' : 'source-over';
    s.globalAlpha = this.o.opacity;
    blit(s, this.buffer, rr);
    s.restore();
  }

  add(p: StrokePoint) {
    const bctx = ctx2d(this.buffer);
    setT(bctx, this.inv);
    bctx.imageSmoothingEnabled = true;
    let region: Rect | null = null;
    const dab = (x: number, y: number, pr: number) => {
      const r = Math.max(0.5, (this.o.size / 2) * (this.o.pressure ? pr : 1));
      if (this.o.clone) { region = union(region, this.cloneDab(bctx, x, y, r)); return; }
      if (this.o.retouch?.mode === 'smudge') { region = union(region, this.smudgeDab(x, y, r)); return; }
      if (this.o.aliased) {
        // Whole pixels of the layer, centred on the pixel under the pointer.
        const q = apply(this.inv, x, y);
        const d = Math.max(1, Math.round((r * 2) / this.pxScale));
        const ix = Math.floor(q.x - d / 2 + 0.5), iy = Math.floor(q.y - d / 2 + 0.5);
        bctx.save();
        bctx.setTransform(1, 0, 0, 1, 0, 0);
        bctx.drawImage(pixelStamp(this.o.erase ? '#000000' : this.o.color, d, this.o.flow), ix, iy);
        bctx.restore();
        region = union(region, { x: ix, y: iy, w: d, h: d });
        return;
      }
      // Scatter moves the dab off the line; jitter turns it (textured tips only, a round dab looks the same).
      const sc = (this.o.scatter ?? 0) * this.o.size;
      if (sc > 0) { const a = Math.random() * Math.PI * 2, d = Math.random() * sc; x += Math.cos(a) * d; y += Math.sin(a) * d; }
      const jit = this.textured ? (this.o.jitter ?? 0) : 0;
      if (jit > 0) {
        bctx.save();
        bctx.translate(x, y);
        bctx.rotate((Math.random() - 0.5) * Math.PI * 2 * jit);
        bctx.drawImage(this.stamp, -r, -r, r * 2, r * 2);
        bctx.restore();
      } else bctx.drawImage(this.stamp, x - r, y - r, r * 2, r * 2);
      const e = jit > 0 ? r * Math.SQRT2 : r;
      const a = apply(this.inv, x - e, y - e), b = apply(this.inv, x + e, y - e);
      const c = apply(this.inv, x + e, y + e), d = apply(this.inv, x - e, y + e);
      const box = { x: Math.min(a.x, b.x, c.x, d.x), y: Math.min(a.y, b.y, c.y, d.y), w: 0, h: 0 };
      box.w = Math.max(a.x, b.x, c.x, d.x) - box.x;
      box.h = Math.max(a.y, b.y, c.y, d.y) - box.y;
      region = union(region, box);
    };
    // With symmetry on, each dab is placed again at every mirrored or turned copy of its position.
    const copies = this.o.copies ?? [];
    const place = (x: number, y: number, pr: number) => {
      dab(x, y, pr);
      for (const m of copies) { const q = apply(m, x, y); dab(q.x, q.y, pr); }
    };
    if (!this.last) {
      place(p.x, p.y, p.pressure);
    } else {
      const l = this.last;
      const dx = p.x - l.x, dy = p.y - l.y, dist = Math.hypot(dx, dy);
      const spacing = Math.max(0.5, this.o.size * (this.o.spacing ?? 0.12));
      let t = spacing - this.carry;
      while (t <= dist) {
        const k = t / dist;
        place(l.x + dx * k, l.y + dy * k, l.pressure + (p.pressure - l.pressure) * k);
        t += spacing;
      }
      this.carry = dist - (t - spacing);
    }
    this.last = p;
    if (!region) return;
    const r = intersect(roundOut(region), { x: 0, y: 0, w: this.src.width, h: this.src.height });
    if (!r) return;
    r.x -= 1; r.y -= 1; r.w += 2; r.h += 2;
    const rr = intersect(r, { x: 0, y: 0, w: this.src.width, h: this.src.height })!;
    bctx.setTransform(1, 0, 0, 1, 0, 0);
    if (this.o.retouch?.mode === 'smudge') {
      // Smudge paints straight onto the layer; outside a selection it's put back as it was.
      if (this.mask) this.keepInside(rr);
      this.dirty = union(this.dirty, rr);
      this.doc.markPixels(this.layer.key, true, rr);
      return;
    }
    if (this.mask) {
      bctx.save();
      bctx.globalCompositeOperation = 'destination-in';
      bctx.beginPath(); bctx.rect(rr.x, rr.y, rr.w, rr.h); bctx.clip();
      blit(bctx, this.mask, rr);
      bctx.restore();
    }
    this.compose(rr);
    if (this.o.heal) this.healRegion(rr);
    this.dirty = union(this.dirty, rr);
    this.doc.markPixels(this.layer.key, true, rr);
  }

  /** Lifts the brush: the next point starts a new line in the same stroke (one undo step). */
  lift() { this.last = null; this.carry = 0; }

  end(label: string) {
    if (!this.dirty) { this.doc.commit(label); return; }
    const r = this.dirty;
    // One last pass over the whole stroke, so every part is healed against the same surroundings.
    if (this.o.heal) { this.compose(r); this.healRegion(r); this.doc.markPixels(this.layer.key, true, r); }
    this.doc.commit(label, [{ key: this.layer.key, rect: r, before: cropCanvas(this.backup, r), after: null }]);
  }
}
