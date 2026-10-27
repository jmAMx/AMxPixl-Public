/// <reference lib="webworker" />
import { applyPalette, GIFEncoder, quantize, type Palette } from 'gifenc';

/**
 * GIF work off the main thread. 'frame': read one frame's pixels and reduce it to 256 colours (the palette is
 * built from a smaller copy with a coarse colour grid, which is ~40x faster, then every pixel is matched to it on a
 * finer grid so smooth gradients keep their steps). 'encode': write all the reduced frames into the GIF file.
 */

type FrameJob = { type: 'frame'; id: number; bitmap: ImageBitmap; transparent: boolean };
type EncodeJob = {
  type: 'encode'; id: number; width: number; height: number; loop: boolean;
  frames: { index: Uint8Array; palette: Palette; delay: number; transparentIndex: number }[];
};

const PALETTE_SAMPLE = 250_000;

self.onmessage = (e: MessageEvent<FrameJob | EncodeJob>) => {
  const job = e.data;
  try {
    if (job.type === 'frame') {
      const { bitmap } = job;
      const w = bitmap.width, h = bitmap.height;
      const c = new OffscreenCanvas(w, h);
      const x = c.getContext('2d', { willReadFrequently: true })!;
      x.drawImage(bitmap, 0, 0);
      const data = x.getImageData(0, 0, w, h).data;
      // Palette from a reduced copy (at most PALETTE_SAMPLE pixels).
      const k = Math.max(1, Math.sqrt((w * h) / PALETTE_SAMPLE));
      let sample = data;
      if (k > 1) {
        const sw = Math.max(1, Math.round(w / k)), sh = Math.max(1, Math.round(h / k));
        const s = new OffscreenCanvas(sw, sh);
        const sx = s.getContext('2d', { willReadFrequently: true })!;
        sx.drawImage(bitmap, 0, 0, sw, sh);
        sample = sx.getImageData(0, 0, sw, sh).data;
      }
      bitmap.close();
      const transparent = job.transparent;
      const palette = quantize(sample, 256, transparent ? { format: 'rgba4444', oneBitAlpha: true } : { format: 'rgb444' });
      const index = applyPalette(data, palette, transparent ? 'rgba4444' : 'rgb565');
      const transparentIndex = transparent ? palette.findIndex((p) => p[3] === 0) : -1;
      (self as DedicatedWorkerGlobalScope).postMessage({ id: job.id, index, palette, transparentIndex }, [index.buffer]);
    } else {
      const gif = GIFEncoder();
      for (const f of job.frames) {
        gif.writeFrame(f.index, job.width, job.height, {
          palette: f.palette, delay: f.delay, repeat: job.loop ? 0 : -1,
          ...(f.transparentIndex >= 0 ? { transparent: true, transparentIndex: f.transparentIndex, dispose: 2 } : {}),
        });
      }
      gif.finish();
      const bytes = gif.bytes();
      (self as DedicatedWorkerGlobalScope).postMessage({ id: job.id, bytes }, [bytes.buffer]);
    }
  } catch (err) {
    (self as DedicatedWorkerGlobalScope).postMessage({ id: job.id, error: (err as Error).message });
  }
};
