import { applyPalette, GIFEncoder, quantize } from 'gifenc';
import type { Doc } from './document';
import { canvasBlob } from './fileio';
import { ctx2d, newCanvas } from './layers';
import { flatten } from './render';

/**
 * Exports a document's frame animation as GIF, animated PNG, MP4 (H.264) or WebM (VP9). Every frame is rendered
 * straight from the layers (animated effects move with it), then encoded. Video uses the PC's own encoder through
 * WebCodecs, via Mediabunny for the file container.
 */

export type AnimFormat = 'gif' | 'apng' | 'mp4' | 'webm';
export interface AnimExportOptions {
  format: AnimFormat;
  scale: number;
  nearest: boolean;
  /** 'transparent' keeps see-through areas (GIF/APNG only); otherwise they're filled. */
  background: 'transparent' | 'white' | 'black';
  /** Video: how many times to play the animation through. */
  repeat: number;
  onProgress?: (done: number, total: number) => void;
}

interface Frame { canvas: HTMLCanvasElement; ms: number }

const tick = () => new Promise((r) => setTimeout(r, 0));

async function renderFrames(doc: Doc, o: AnimExportOptions, even: boolean, total: number): Promise<Frame[]> {
  const a = doc.anim!;
  const out: Frame[] = [];
  let w = Math.max(1, Math.round(doc.width * o.scale)), h = Math.max(1, Math.round(doc.height * o.scale));
  // H.264 and VP9 need even dimensions.
  if (even) { w += w % 2; h += h % 2; }
  for (let i = 0; i < a.frames.length; i++) {
    const src = flatten(doc, o.scale, { frame: i, nearest: o.nearest });
    const c = newCanvas(w, h);
    const x = ctx2d(c, true);
    if (o.background !== 'transparent') { x.fillStyle = o.background === 'white' ? '#ffffff' : '#000000'; x.fillRect(0, 0, w, h); }
    x.drawImage(src, 0, 0);
    out.push({ canvas: c, ms: a.frames[i].ms ?? 1000 / a.fps });
    o.onProgress?.(i + 1, total);
    await tick();
  }
  return out;
}

// ---------- GIF ----------

async function encodeGif(frames: Frame[], loop: boolean, transparent: boolean, o: AnimExportOptions): Promise<Blob> {
  const gif = GIFEncoder();
  const n = frames.length;
  for (let i = 0; i < n; i++) {
    const { canvas, ms } = frames[i];
    const data = ctx2d(canvas, true).getImageData(0, 0, canvas.width, canvas.height).data;
    const format = transparent ? 'rgba4444' : 'rgb565';
    const palette = quantize(data, 256, transparent ? { format, oneBitAlpha: true } : { format });
    const index = applyPalette(data, palette, format);
    const ti = transparent ? palette.findIndex((p) => p[3] === 0) : -1;
    gif.writeFrame(index, canvas.width, canvas.height, {
      palette, delay: Math.max(20, Math.round(ms)), repeat: loop ? 0 : -1,
      ...(ti >= 0 ? { transparent: true, transparentIndex: ti, dispose: 2 } : {}),
    });
    o.onProgress?.(n + i + 1, n * 2);
    await tick();
  }
  gif.finish();
  return new Blob([gif.bytes() as Uint8Array<ArrayBuffer>], { type: 'image/gif' });
}

// ---------- APNG ----------

const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(parts: Uint8Array[]) { let c = 0xffffffff; for (const p of parts) for (let i = 0; i < p.length; i++) c = CRC[(c ^ p[i]) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  const t = new TextEncoder().encode(type);
  out.set(t, 4); out.set(data, 8);
  dv.setUint32(8 + data.length, crc32([t, data]));
  return out;
}

/** The chunks of a PNG file, by type. */
function pngChunks(buf: Uint8Array) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const out: { type: string; data: Uint8Array }[] = [];
  for (let p = 8; p < buf.length;) {
    const len = dv.getUint32(p), type = String.fromCharCode(...buf.subarray(p + 4, p + 8));
    out.push({ type, data: buf.subarray(p + 8, p + 8 + len) });
    p += 12 + len;
  }
  return out;
}

async function encodeApng(frames: Frame[], loop: boolean, o: AnimExportOptions): Promise<Blob> {
  const parts: Uint8Array[] = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])];
  const n = frames.length;
  let seq = 0;
  const u32 = (dv: DataView, at: number, v: number) => dv.setUint32(at, v);
  for (let i = 0; i < n; i++) {
    const { canvas, ms } = frames[i];
    const png = new Uint8Array(await (await canvasBlob(canvas, 'image/png')).arrayBuffer());
    const ch = pngChunks(png);
    if (i === 0) {
      parts.push(chunk('IHDR', ch.find((c) => c.type === 'IHDR')!.data));
      const ac = new Uint8Array(8); const dv = new DataView(ac.buffer);
      u32(dv, 0, n); u32(dv, 4, loop ? 0 : 1);
      parts.push(chunk('acTL', ac));
    }
    const fc = new Uint8Array(26); const fv = new DataView(fc.buffer);
    u32(fv, 0, seq++); u32(fv, 4, canvas.width); u32(fv, 8, canvas.height); u32(fv, 12, 0); u32(fv, 16, 0);
    fv.setUint16(20, Math.max(1, Math.round(ms))); fv.setUint16(22, 1000);
    fc[24] = 1; fc[25] = 0; // dispose to background, replace (each frame is complete)
    parts.push(chunk('fcTL', fc));
    for (const c of ch.filter((c) => c.type === 'IDAT')) {
      if (i === 0) { parts.push(chunk('IDAT', c.data)); continue; }
      const fd = new Uint8Array(4 + c.data.length);
      new DataView(fd.buffer).setUint32(0, seq++);
      fd.set(c.data, 4);
      parts.push(chunk('fdAT', fd));
    }
    o.onProgress?.(n + i + 1, n * 2);
    await tick();
  }
  parts.push(chunk('IEND', new Uint8Array(0)));
  return new Blob(parts as Uint8Array<ArrayBuffer>[], { type: 'image/apng' });
}

// ---------- video ----------

async function encodeVideo(frames: Frame[], o: AnimExportOptions): Promise<Blob> {
  const mb = await import('mediabunny');
  const codec = o.format === 'mp4' ? 'avc' : 'vp9';
  const w = frames[0].canvas.width, h = frames[0].canvas.height;
  if (!(await mb.canEncodeVideo(codec, { width: w, height: h, quality: mb.QUALITY_HIGH }))) {
    throw new Error(`This PC can't encode ${o.format === 'mp4' ? 'H.264 (MP4)' : 'VP9 (WebM)'} video at ${w} × ${h}. Try the other video format, a smaller size, or GIF.`);
  }
  const output = new mb.Output({ format: o.format === 'mp4' ? new mb.Mp4OutputFormat() : new mb.WebMOutputFormat(), target: new mb.BufferTarget() });
  const stage = newCanvas(w, h);
  const sx = ctx2d(stage);
  const source = new mb.CanvasSource(stage, { codec, quality: mb.QUALITY_HIGH });
  const fps = Math.round(1000 / (frames.reduce((t, f) => t + f.ms, 0) / frames.length));
  output.addVideoTrack(source, { frameRate: Math.max(1, Math.min(60, fps)) });
  await output.start();
  const total = frames.length * o.repeat;
  let t = 0, done = 0;
  for (let r = 0; r < o.repeat; r++) for (const f of frames) {
    sx.drawImage(f.canvas, 0, 0);
    await source.add(t, f.ms / 1000);
    t += f.ms / 1000;
    o.onProgress?.(frames.length + Math.round((++done / total) * frames.length), frames.length * 2);
  }
  await output.finalize();
  return new Blob([output.target.buffer!], { type: o.format === 'mp4' ? 'video/mp4' : 'video/webm' });
}

export async function exportAnimation(doc: Doc, o: AnimExportOptions): Promise<Blob> {
  if (!doc.anim?.frames.length) throw new Error('This image has no animation yet (View › Timeline).');
  const video = o.format === 'mp4' || o.format === 'webm';
  const n = doc.anim.frames.length;
  const frames = await renderFrames(doc, { ...o, background: video && o.background === 'transparent' ? 'black' : o.background }, video, n * 2);
  if (o.format === 'gif') return encodeGif(frames, doc.anim.loop, o.background === 'transparent', o);
  if (o.format === 'apng') return encodeApng(frames, doc.anim.loop, o);
  return encodeVideo(frames, o);
}

export const ANIM_EXT: Record<AnimFormat, string> = { gif: 'gif', apng: 'png', mp4: 'mp4', webm: 'webm' };
export const ANIM_MIME: Record<AnimFormat, string> = { gif: 'image/gif', apng: 'image/apng', mp4: 'video/mp4', webm: 'video/webm' };
