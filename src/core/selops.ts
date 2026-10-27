import type { Doc } from './document';
import { floodFill } from './flood';
import { glops } from './glops';
import { ctx2d, newCanvas } from './layers';
import { flatten, renderDoc } from './render';
import { maskSelection } from './selection';
import { WorkerPool } from './workers/pool';
import type { Layer, SelOp, Selection } from './types';

export type SelMode = 'replace' | 'add' | 'sub';
export type Modify = 'feather' | 'grow' | 'shrink' | 'smooth' | 'border';

/** Combines a new document-sized mask with the current selection. */
export function combine(doc: Doc, mask: HTMLCanvasElement, mode: SelMode): Selection | null {
  const sel = maskSelection(mask, (c) => doc.addCanvas(c));
  if (!sel) return mode === 'replace' ? null : doc.selection;
  const op: SelOp = { ...sel.ops[0], mode: mode === 'sub' ? 'sub' : 'add' };
  if (mode === 'replace' || !doc.selection) return mode === 'sub' ? doc.selection : { ops: [op] };
  return { ops: [...doc.selection.ops, op] };
}

const blurred = (src: HTMLCanvasElement, r: number) => {
  const c = newCanvas(src.width, src.height);
  const x = ctx2d(c);
  x.filter = `blur(${Math.max(0.01, r)}px)`;
  x.drawImage(src, 0, 0);
  return c;
};

/** Copy of a GL result (which is reused by the next GPU call). */
const keep = (gl: HTMLCanvasElement | null, w: number, h: number) => {
  const c = newCanvas(w, h);
  if (gl) ctx2d(c).drawImage(gl, 0, 0);
  return c;
};

/** Grow (r > 0) or shrink (r < 0) a mask by |r| pixels: blur, then threshold (Gaussian with sigma = r/2). */
function morph(m: HTMLCanvasElement, r: number) {
  const b = blurred(m, Math.abs(r) / 2);
  return keep(r > 0 ? glops.ramp(b, 0.012, 0.035, [1, 1, 1]) : glops.ramp(b, 0.965, 0.99, [1, 1, 1]), m.width, m.height);
}

/** Select › Modify: returns the new selection mask. */
export function modifyMask(mask: HTMLCanvasElement, kind: Modify, r: number): HTMLCanvasElement {
  switch (kind) {
    case 'feather': return blurred(mask, r);
    case 'grow': return morph(mask, r);
    case 'shrink': return morph(mask, -r);
    case 'smooth': return keep(glops.ramp(blurred(mask, r), 0.45, 0.55, [1, 1, 1]), mask.width, mask.height);
    case 'border': {
      const outer = morph(mask, r / 2), inner = morph(mask, -r / 2);
      const x = ctx2d(outer);
      x.globalCompositeOperation = 'destination-out';
      x.drawImage(inner, 0, 0);
      return outer;
    }
  }
}

/** What the magic wand and colour range look at: the whole image, or just the active layer. */
export function sampleSource(doc: Doc, allLayers: boolean, layer: Layer | null): HTMLCanvasElement {
  if (allLayers || !layer) return flatten(doc);
  const c = newCanvas(doc.width, doc.height);
  renderDoc(doc, c, [1, 0, 0, 1, 0, 0], { layers: [{ ...layer, visible: true, opacity: 1, blend: 'normal', clip: false }], includeHidden: true });
  return c;
}

type WandReply = { mask: Uint8ClampedArray; w: number; h: number };
let pixelPool: WorkerPool<object, WandReply> | null = null;

/**
 * Magic wand: pixels similar to the clicked one, as a soft-edged mask. Null if the point is outside the image.
 * Reading the image back and the flood fill run in a background worker, so a big image doesn't freeze the window.
 */
export async function wandMask(src: HTMLCanvasElement, x: number, y: number, tol: number, contiguous: boolean, antiAlias: boolean): Promise<HTMLCanvasElement | null> {
  const W = src.width, H = src.height;
  const sx = Math.floor(x), sy = Math.floor(y);
  if (sx < 0 || sy < 0 || sx >= W || sy >= H) return null;
  let data: Uint8ClampedArray;
  if (typeof Worker !== 'undefined') {
    const p = (pixelPool ??= new WorkerPool<object, WandReply>(() => new Worker(new URL('./workers/pixelworker.ts', import.meta.url), { type: 'module' }), 1));
    const bitmap = await createImageBitmap(src);
    data = (await p.run({ type: 'wand', bitmap, x: sx, y: sy, tol, contiguous }, [bitmap])).mask;
  } else {
    const hit = floodFill(ctx2d(src, true).getImageData(0, 0, W, H).data, W, H, sx, sy, tol, contiguous);
    data = new Uint8ClampedArray(W * H * 4);
    for (let i = 0; i < hit.length; i++) if (hit[i]) data.fill(255, i * 4, i * 4 + 4);
  }
  const c = newCanvas(W, H);
  ctx2d(c).putImageData(new ImageData(data as Uint8ClampedArray<ArrayBuffer>, W, H), 0, 0);
  return antiAlias ? blurred(c, 0.6) : c;
}

/** Colour Range on the GPU: mode 0 = near `rgb`, 1 highlights, 2 midtones, 3 shadows. */
export function colorRangeMask(src: HTMLCanvasElement, mode: number, fuzz: number, rgb: [number, number, number]): HTMLCanvasElement {
  return keep(glops.colorRange(src, mode, fuzz, rgb), src.width, src.height);
}

/** A layer's own shape (its alpha, after its mask) as a document-sized mask. */
export function layerAlphaMask(doc: Doc, layer: Layer): HTMLCanvasElement {
  const c = newCanvas(doc.width, doc.height);
  renderDoc(doc, c, [1, 0, 0, 1, 0, 0], { layers: [{ ...layer, visible: true, opacity: 1, blend: 'normal', clip: false, styles: null, blendIf: null }], includeHidden: true });
  const x = ctx2d(c);
  x.globalCompositeOperation = 'source-in';
  x.fillStyle = '#fff';
  x.fillRect(0, 0, c.width, c.height);
  return c;
}
