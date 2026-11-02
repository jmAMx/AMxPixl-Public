import { ctx2d, newCanvas } from '../layers';

/**
 * Opening animations and video frame by frame: each frame becomes a layer (see actions.openFrames). Animated images
 * (GIF, Animated PNG, animated WebP) go through the browser's own ImageDecoder, which gives every frame whole (as it's
 * shown) with how long it's held; video (MP4, MOV, WebM, MKV) through mediabunny, which decodes the frames at the
 * times asked for, at the size asked for.
 */

/** Frames: whole pictures, each with how long it's shown (ms). */
export interface Frames { w: number; h: number; frames: { canvas: HTMLCanvasElement; ms: number }[] }

/** What a frame costs to keep (a full-size layer: 4 bytes a pixel). */
export const frameBytes = (w: number, h: number) => w * h * 4;
/** Above this many bytes of frames, opening asks first; above the second, it opens only as many as fit. */
export const FRAMES_WARN = 1.5e9, FRAMES_MAX = 3e9;

// The parts of WebCodecs' ImageDecoder used here.
interface DecodedImage { image: VideoFrame }
interface ImageTrack { animated: boolean; frameCount: number }
interface ImageDecoderLike {
  tracks: { ready: Promise<void>; selectedTrack: ImageTrack | null };
  decode(o: { frameIndex: number }): Promise<DecodedImage>;
  close(): void;
}
type ImageDecoderCtor = { new (o: { data: ArrayBuffer; type: string }): ImageDecoderLike; isTypeSupported(type: string): Promise<boolean> };

const IMAGE_TYPES: Record<string, string> = { gif: 'image/gif', png: 'image/png', apng: 'image/apng', webp: 'image/webp' };
export const ANIMATED_EXT = Object.keys(IMAGE_TYPES);
export const VIDEO_EXT = ['mp4', 'm4v', 'mov', 'webm', 'mkv'];

/** A frame as a canvas of its own (the decoder's frame is let go). */
function toCanvas(f: VideoFrame | HTMLCanvasElement | OffscreenCanvas, w: number, h: number): HTMLCanvasElement {
  const c = newCanvas(w, h);
  ctx2d(c).drawImage(f as CanvasImageSource, 0, 0, w, h);
  return c;
}

/**
 * An animated image's size and frame count, and a way to read its frames (the first `max`, by default all) or let
 * it go; null for a still image, or one this can't read.
 */
export async function probeAnimated(file: Blob, ext: string): Promise<{ w: number; h: number; count: number; open: (max?: number) => Promise<Frames>; close: () => void } | null> {
  const ID = (window as unknown as { ImageDecoder?: ImageDecoderCtor }).ImageDecoder;
  const type = IMAGE_TYPES[ext];
  if (!ID || !type || !(await ID.isTypeSupported(type).catch(() => false))) return null;
  let dec: ImageDecoderLike;
  try {
    dec = new ID({ data: await file.arrayBuffer(), type });
    await dec.tracks.ready;
  } catch { return null; }
  const track = dec.tracks.selectedTrack;
  if (!track?.animated || track.frameCount < 2) { dec.close(); return null; }
  const first = (await dec.decode({ frameIndex: 0 })).image;
  const w = first.displayWidth, h = first.displayHeight;
  first.close();
  return {
    w, h, count: track.frameCount,
    close: () => dec.close(),
    async open(max = track.frameCount) {
      const frames: Frames['frames'] = [];
      try {
        for (let i = 0; i < Math.min(max, track.frameCount); i++) {
          const img = (await dec.decode({ frameIndex: i })).image;
          // (Its duration is in microseconds; a frame with none, or a very short one, is held like browsers hold it.)
          const ms = img.duration ? img.duration / 1000 : 100;
          frames.push({ canvas: toCanvas(img, w, h), ms: ms < 20 ? 100 : ms });
          img.close();
        }
      } finally { dec.close(); }
      return { w, h, frames };
    },
  };
}

/** A video's size, length (seconds) and frame rate, and a way to read frames from it or let it go. */
export interface VideoInfo {
  w: number; h: number; duration: number; fps: number;
  /** Frames from `start` to `end` (seconds) at `fps` a second, at `scale` of full size. */
  open(o: { start: number; end: number; fps: number; scale: number; onProgress?: (done: number, total: number) => void }): Promise<Frames>;
  close(): void;
}

/** A video file, ready to read frames from; throws (saying why) if it has no video this PC can decode. */
export async function probeVideo(file: Blob): Promise<VideoInfo> {
  const mb = await import('mediabunny');
  const input = new mb.Input({ formats: mb.ALL_FORMATS, source: new mb.BlobSource(file) });
  const track = await input.getPrimaryVideoTrack().catch(() => null);
  if (!track || !(await track.canDecode().catch(() => false))) {
    const codec = await track?.getCodecParameterString().catch(() => null);
    input.dispose?.();
    throw new Error(!track ? 'no video could be found in it.' : `this PC can't decode its video${codec ? ` (${codec})` : ''}.`);
  }
  const w = await track.getDisplayWidth(), h = await track.getDisplayHeight();
  const duration = await input.computeDuration().catch(() => 0);
  const fps = await track.computeFrameRateMetrics().then((m) => m.bestGuessFrameRate).catch(() => 30);
  return {
    w, h, duration, fps: Math.max(1, Math.round(fps * 100) / 100),
    close: () => input.dispose?.(),
    async open({ start, end, fps: rate, scale, onProgress }) {
      const fw = Math.max(1, Math.round(w * scale)), fh = Math.max(1, Math.round(h * scale));
      const sink = new mb.CanvasSink(track, { width: fw, height: fh, fit: 'fill' });
      const times: number[] = [];
      for (let t = start; t < end - 1e-6; t += 1 / rate) times.push(t);
      const frames: Frames['frames'] = [];
      try {
        for await (const wc of sink.canvasesAtTimestamps(times)) {
          if (wc) frames.push({ canvas: toCanvas(wc.canvas, fw, fh), ms: 1000 / rate });
          onProgress?.(frames.length, times.length);
        }
      } finally { input.dispose?.(); }
      return { w: fw, h: fh, frames };
    },
  };
}
