import type { Doc } from './document';
import { cloneCanvas, cropCanvas, ctx2d, newCanvas } from './layers';
import { apply, intersect, invert, matScale, roundOut, setT, union, xformMatrix, type Mat, type Rect } from './math';
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
    d.drawImage(this.backup, -(qs.x - rr - 1), -(qs.y - rr - 1));
    d.globalCompositeOperation = 'destination-in';
    d.drawImage(this.stamp, 1, 1, rr * 2, rr * 2);
    d.globalCompositeOperation = 'source-over';
    bctx.save();
    bctx.setTransform(1, 0, 0, 1, 0, 0);
    bctx.drawImage(this.dabC, 0, 0, size, size, q.x - rr - 1, q.y - rr - 1, size, size);
    bctx.restore();
    return { x: q.x - rr - 1, y: q.y - rr - 1, w: size, h: size };
  }

  /**
   * Healing: keep the cloned texture but take the broad colour and light from the destination. Each pixel becomes
   * clone + (blur(original) - blur(clone)), weighted by how much was cloned there. Runs once, when the stroke ends.
   */
  private heal(r: Rect) {
    const br = Math.max(2, (this.o.size / this.pxScale) * 0.45);
    const pad = Math.ceil(br * 2.5);
    const R = intersect({ x: r.x - pad, y: r.y - pad, w: r.w + pad * 2, h: r.h + pad * 2 }, { x: 0, y: 0, w: this.src.width, h: this.src.height });
    if (!R) return r;
    const blurred = (c: HTMLCanvasElement) => {
      const out = newCanvas(c.width, c.height);
      const x = ctx2d(out);
      x.filter = `blur(${br}px)`;
      x.drawImage(c, 0, 0);
      return out;
    };
    const C = cropCanvas(this.src, R), D = cropCanvas(this.backup, R), M = cropCanvas(this.buffer, R);
    const read = (c: HTMLCanvasElement) => ctx2d(c, true).getImageData(0, 0, R.w, R.h).data;
    const img = ctx2d(C, true).getImageData(0, 0, R.w, R.h);
    const c = img.data, bc = read(blurred(C)), bd = read(blurred(D)), m = read(M);
    for (let i = 0; i < c.length; i += 4) {
      const k = (m[i + 3] / 255) * this.o.opacity;
      if (k <= 0 || c[i + 3] === 0) continue;
      for (let j = 0; j < 3; j++) c[i + j] = c[i + j] + (bd[i + j] - bc[i + j]) * k;
    }
    ctx2d(this.src).putImageData(img, R.x, R.y);
    return R;
  }

  add(p: StrokePoint) {
    const bctx = ctx2d(this.buffer);
    setT(bctx, this.inv);
    bctx.imageSmoothingEnabled = true;
    let region: Rect | null = null;
    const dab = (x: number, y: number, pr: number) => {
      const r = Math.max(0.5, (this.o.size / 2) * (this.o.pressure ? pr : 1));
      if (this.o.clone) { region = union(region, this.cloneDab(bctx, x, y, r)); return; }
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
    const s = ctx2d(this.src);
    s.save();
    s.beginPath(); s.rect(rr.x, rr.y, rr.w, rr.h); s.clip();
    s.globalCompositeOperation = 'copy';
    s.drawImage(this.backup, 0, 0);
    s.globalCompositeOperation = this.o.erase ? 'destination-out' : 'source-over';
    s.globalAlpha = this.o.opacity;
    s.drawImage(this.buffer, 0, 0);
    s.restore();
    this.dirty = union(this.dirty, rr);
    this.doc.markPixels(this.layer.key, true, rr);
  }

  end(label: string) {
    if (!this.dirty) { this.doc.commit(label); return; }
    let r = this.dirty;
    if (this.o.heal) {
      r = union(r, this.heal(r));
      this.doc.markPixels(this.layer.key, false, r);
    }
    this.doc.commit(label, [{ key: this.layer.key, rect: r, before: cropCanvas(this.backup, r), after: null }]);
  }
}
