import { ctx2d, newCanvas } from './layers';
import type { BlendMode } from './types';

/** Temporary full-size buffers for isolated groups, masks, clipping and styles, reused between frames. */
const scratch: { c: HTMLCanvasElement; busy: boolean }[] = [];

export function acquire(w: number, h: number): HTMLCanvasElement {
  let s = scratch.find((x) => !x.busy && x.c.width === w && x.c.height === h);
  if (!s) {
    // Drop idle buffers of other sizes (the view was resized) before making a new one.
    for (let i = scratch.length - 1; i >= 0; i--) if (!scratch[i].busy && (scratch[i].c.width !== w || scratch[i].c.height !== h)) scratch.splice(i, 1);
    s = { c: newCanvas(w, h), busy: false };
    scratch.push(s);
  }
  s.busy = true;
  const x = ctx2d(s.c);
  x.setTransform(1, 0, 0, 1, 0, 0);
  x.globalAlpha = 1;
  x.globalCompositeOperation = 'source-over';
  x.filter = 'none';
  x.clearRect(0, 0, w, h);
  return s.c;
}

export function release(...cs: HTMLCanvasElement[]) {
  for (const c of cs) { const s = scratch.find((x) => x.c === c); if (s) s.busy = false; }
}

export const like = (c: HTMLCanvasElement) => acquire(c.width, c.height);

export const gco = (b: BlendMode): GlobalCompositeOperation => (b === 'normal' || b === 'pass-through' ? 'source-over' : b);

export function composite(target: HTMLCanvasElement, src: HTMLCanvasElement, blend: BlendMode, opacity: number, op?: GlobalCompositeOperation, filter?: string, dx = 0, dy = 0) {
  const x = ctx2d(target);
  x.save();
  x.setTransform(1, 0, 0, 1, 0, 0);
  x.globalAlpha = opacity;
  x.globalCompositeOperation = op ?? gco(blend);
  if (filter) x.filter = filter;
  x.drawImage(src, dx, dy);
  x.restore();
}
