import type { Doc } from './document';
import { cloneCanvas, cropCanvas, ctx2d, newCanvas } from './layers';
import { glops } from './glops';
import { apply, intersect, invert, matScale, mul, roundOut, setT, union, xformMatrix, type Mat, type Rect } from './math';
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
}

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
    this.stamp = makeStamp(o.erase ? '#000000' : o.clone ? '#ffffff' : o.color, o.size / this.pxScale, o.hardness, o.flow);
  }

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
   * much was cloned. "Surroundings" is a blur that leaves out the painted area itself (the flaw being covered),
   * so colour comes in from the edges of the stroke, much like Photoshop's healing brush. Only `rr` is rewritten.
   */
  private healRegion(rr: Rect) {
    // Wide strokes or scribbled patches need a wider reach to find their edges.
    const ext = union(this.dirty, rr)!;
    const br = Math.max(2, (this.o.size / this.pxScale) * 0.45, Math.min(ext.w, ext.h) * 0.3);
    const pad = Math.ceil(br * 2.5);
    const R = intersect({ x: rr.x - pad, y: rr.y - pad, w: rr.w + pad * 2, h: rr.h + pad * 2 }, { x: 0, y: 0, w: this.src.width, h: this.src.height });
    if (!R) return;
    const cov = cropCanvas(this.buffer, R);
    // Cut the painted area out, then blur: the colour of what's left is a weighted average of the surroundings.
    const around = (c: HTMLCanvasElement) => {
      const x = ctx2d(c);
      x.globalCompositeOperation = 'destination-out';
      x.drawImage(cov, 0, 0);
      const out = newCanvas(c.width, c.height);
      const o = ctx2d(out);
      o.filter = `blur(${br}px)`;
      o.drawImage(c, 0, 0);
      return out;
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
    const s = ctx2d(this.src);
    s.save();
    s.beginPath(); s.rect(rr.x, rr.y, rr.w, rr.h); s.clip();
    s.globalCompositeOperation = 'copy';
    s.drawImage(res, R.x, R.y);
    s.restore();
  }

  /** Redraws `rr` of the layer as it was before the stroke with the stroke so far on top. */
  private compose(rr: Rect) {
    const s = ctx2d(this.src);
    s.save();
    s.beginPath(); s.rect(rr.x, rr.y, rr.w, rr.h); s.clip();
    s.globalCompositeOperation = 'copy';
    s.drawImage(this.backup, 0, 0);
    s.globalCompositeOperation = this.o.erase ? 'destination-out' : 'source-over';
    s.globalAlpha = this.o.opacity;
    s.drawImage(this.buffer, 0, 0);
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
      bctx.drawImage(this.stamp, x - r, y - r, r * 2, r * 2);
      const a = apply(this.inv, x - r, y - r), b = apply(this.inv, x + r, y - r);
      const c = apply(this.inv, x + r, y + r), d = apply(this.inv, x - r, y + r);
      const box = { x: Math.min(a.x, b.x, c.x, d.x), y: Math.min(a.y, b.y, c.y, d.y), w: 0, h: 0 };
      box.w = Math.max(a.x, b.x, c.x, d.x) - box.x;
      box.h = Math.max(a.y, b.y, c.y, d.y) - box.y;
      region = union(region, box);
    };
    if (!this.last) {
      dab(p.x, p.y, p.pressure);
    } else {
      const l = this.last;
      const dx = p.x - l.x, dy = p.y - l.y, dist = Math.hypot(dx, dy);
      const spacing = Math.max(0.5, this.o.size * 0.12);
      let t = spacing - this.carry;
      while (t <= dist) {
        const k = t / dist;
        dab(l.x + dx * k, l.y + dy * k, l.pressure + (p.pressure - l.pressure) * k);
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
    if (this.mask) {
      bctx.save();
      bctx.globalCompositeOperation = 'destination-in';
      bctx.beginPath(); bctx.rect(rr.x, rr.y, rr.w, rr.h); bctx.clip();
      bctx.drawImage(this.mask, 0, 0);
      bctx.restore();
    }
    this.compose(rr);
    if (this.o.heal) this.healRegion(rr);
    this.dirty = union(this.dirty, rr);
    this.doc.markPixels(this.layer.key, true, rr);
  }

  end(label: string) {
    if (!this.dirty) { this.doc.commit(label); return; }
    const r = this.dirty;
    // One last pass over the whole stroke, so every part is healed against the same surroundings.
    if (this.o.heal) { this.compose(r); this.healRegion(r); this.doc.markPixels(this.layer.key, true, r); }
    this.doc.commit(label, [{ key: this.layer.key, rect: r, before: cropCanvas(this.backup, r), after: null }]);
  }
}
