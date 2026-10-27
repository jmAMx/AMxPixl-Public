/// <reference lib="webworker" />
import { alphaBox, trimBox } from '../alphabox';
import { floodFill } from '../flood';

/**
 * Pixel jobs that would otherwise freeze the window: reading a large image back from the GPU and scanning it.
 * 'wand': the magic wand's flood fill; replies with a white-on-transparent RGBA mask of what it picked.
 * 'bounds': the box around the visible pixels (for the Move tool's bounding box); replies with { rect }.
 * 'trim': the box left after trimming empty edges (Image › Crop to Content); replies with { rect }.
 */
type WandJob = { type: 'wand'; id: number; bitmap: ImageBitmap; x: number; y: number; tol: number; contiguous: boolean };
type BoundsJob = { type: 'bounds' | 'trim'; id: number; bitmap: ImageBitmap };

self.onmessage = (e: MessageEvent<WandJob | BoundsJob>) => {
  const job = e.data;
  try {
    const { bitmap } = job;
    const W = bitmap.width, H = bitmap.height;
    const c = new OffscreenCanvas(W, H);
    const x = c.getContext('2d', { willReadFrequently: true })!;
    x.drawImage(bitmap, 0, 0);
    bitmap.close();
    const d = x.getImageData(0, 0, W, H).data;
    if (job.type !== 'wand') {
      (self as DedicatedWorkerGlobalScope).postMessage({ id: job.id, rect: (job.type === 'trim' ? trimBox : alphaBox)(d, W, H) });
      return;
    }
    const hit = floodFill(d, W, H, job.x, job.y, job.tol, job.contiguous);
    const mask = new Uint8ClampedArray(W * H * 4);
    for (let i = 0; i < hit.length; i++) if (hit[i]) mask.fill(255, i * 4, i * 4 + 4);
    (self as DedicatedWorkerGlobalScope).postMessage({ id: job.id, mask, w: W, h: H }, [mask.buffer]);
  } catch (err) {
    (self as DedicatedWorkerGlobalScope).postMessage({ id: job.id, error: (err as Error).message });
  }
};
