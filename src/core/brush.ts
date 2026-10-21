import type { Doc } from './document';
import { cloneCanvas, cropCanvas, ctx2d, layerMatrix, newCanvas } from './layers';
import { apply, intersect, invert, matScale, roundOut, setT, union, type Mat, type Rect } from './math';
import type { RasterLayer } from './types';

export interface BrushOpts {
  color: string;
  size: number;
  hardness: number;
  opacity: number;
  flow: number;
  erase: boolean;
  pressure: boolean;
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

  constructor(private doc: Doc, private layer: RasterLayer, private o: BrushOpts) {
    if (!o.erase) doc.ensureCovers(layer);
    this.src = doc.canvasOf(layer);
    this.backup = cloneCanvas(this.src);
    this.buffer = newCanvas(this.src.width, this.src.height);
    this.mask = doc.maskForLayer(layer);
    const m = layerMatrix(layer);
    this.inv = invert(m);
    // Build the dab at the resolution it'll land at in the layer's own pixels.
    this.stamp = makeStamp(o.erase ? '#000000' : o.color, o.size / Math.max(0.05, matScale(m)), o.hardness, o.flow);
  }

  add(p: StrokePoint) {
    const bctx = ctx2d(this.buffer);
    setT(bctx, this.inv);
    bctx.imageSmoothingEnabled = true;
    let region: Rect | null = null;
    const dab = (x: number, y: number, pr: number) => {
      const r = Math.max(0.5, (this.o.size / 2) * (this.o.pressure ? pr : 1));
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
    const r = this.dirty;
    this.doc.commit(label, [{ key: this.layer.key, rect: r, before: cropCanvas(this.backup, r), after: null }]);
  }
}
