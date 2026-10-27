import { alphaBox, trimBox } from './alphabox';
import { ctx2d, localBounds } from './layers';
import type { Rect } from './math';
import type { PlacedLayer } from './types';
import { WorkerPool } from './workers/pool';

/**
 * Bounding boxes for the Move tool. Image layers are often canvas-sized with the artwork in one part of them, so by
 * default the box hugs the visible (non-transparent) pixels. Finding those means reading the layer back from the
 * GPU, which happens in a background worker; the result is kept until the layer's pixels change.
 */
export type BoxMode = 'content' | 'layer' | 'custom';

type Entry = { canvas: HTMLCanvasElement; w: number; h: number; ver: number; rect: Rect | null | 'pending' };
const cache = new Map<string, Entry>();
const versions = new Map<string, number>();
const waiting = new Set<() => void>();
let pool: WorkerPool<object, { rect: Rect | null }> | null = null;

/** Called whenever a pixel buffer changes, so its box is worked out again. */
export function pixelsChanged(key: string) { versions.set(key, (versions.get(key) ?? 0) + 1); }

async function scan(canvas: HTMLCanvasElement, type: 'bounds' | 'trim' = 'bounds'): Promise<Rect | null> {
  if (typeof Worker === 'undefined') return (type === 'trim' ? trimBox : alphaBox)(ctx2d(canvas, true).getImageData(0, 0, canvas.width, canvas.height).data, canvas.width, canvas.height);
  pool ??= new WorkerPool(() => new Worker(new URL('./workers/pixelworker.ts', import.meta.url), { type: 'module' }), 1);
  const bitmap = await createImageBitmap(canvas);
  return (await pool.run({ type, bitmap }, [bitmap])).rect;
}

/** The part of an image left after trimming empty edges (transparent, or a flat background colour); null if empty. */
export const trimRect = (canvas: HTMLCanvasElement) => scan(canvas, 'trim');

/**
 * The box around a buffer's visible pixels: the cached one, null if it has none, or undefined while it's still being
 * worked out (`onReady` runs once it is).
 */
export function alphaBounds(key: string, canvas: HTMLCanvasElement, onReady?: () => void): Rect | null | undefined {
  const ver = versions.get(key) ?? 0;
  const c = cache.get(key);
  if (c && c.canvas === canvas && c.w === canvas.width && c.h === canvas.height && c.ver === ver) {
    if (c.rect !== 'pending') return c.rect;
    if (onReady) waiting.add(onReady);
    return undefined;
  }
  const e: Entry = { canvas, w: canvas.width, h: canvas.height, ver, rect: 'pending' };
  cache.set(key, e);
  if (onReady) waiting.add(onReady);
  scan(canvas)
    .then((r) => { e.rect = r; }, () => { e.rect = { x: 0, y: 0, w: e.w, h: e.h }; })
    .finally(() => { const fs = [...waiting]; waiting.clear(); fs.forEach((f) => f()); });
  return undefined;
}

/**
 * A layer's bounding box in its own (pre-transform) pixels. 'content' hugs an image layer's visible pixels (text and
 * shapes are already tight), 'layer' is the whole layer, 'custom' is the box saved on the layer. Null only while an
 * image layer's content box is still being worked out; an empty layer falls back to its whole area.
 */
export function layerBox(l: PlacedLayer, pool: Map<string, HTMLCanvasElement>, mode: BoxMode, onReady?: () => void): Rect | null {
  if (mode === 'custom' && l.box) return l.box;
  if (mode === 'layer' || l.type !== 'raster' || l.warp) return localBounds(l, pool);
  const c = pool.get(l.key);
  if (!c) return localBounds(l, pool);
  const r = alphaBounds(l.key, c, onReady);
  return r === undefined ? null : r ?? localBounds(l, pool);
}
