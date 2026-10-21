import { Doc, flatLayers, newId } from './document';
import { ctx2d, newCanvas } from './layers';
import type { Layer, Meta } from './types';

const MAGIC = 'PIXL';
const FORMAT_VERSION = 1;

export const IMAGE_EXT = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'avif', 'ico', 'svg'];
const IMAGE_TYPES = { 'image/*': IMAGE_EXT.map((e) => '.' + e) } as Record<string, string[]>;
const PIXL_TYPES = { 'application/x-amxpixl': ['.pixl'] } as Record<string, string[]>;

export const baseName = (n: string) => n.replace(/\.[^.]+$/, '');
export const extOf = (n: string) => (n.match(/\.([^.]+)$/)?.[1] ?? '').toLowerCase();

export async function decodeImage(blob: Blob): Promise<HTMLCanvasElement> {
  let bmp: ImageBitmap | HTMLImageElement;
  try {
    bmp = await createImageBitmap(blob, { colorSpaceConversion: 'default', premultiplyAlpha: 'default' });
  } catch {
    // SVG and a few others only decode through <img>.
    const url = URL.createObjectURL(blob);
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      bmp = img;
    } finally {
      URL.revokeObjectURL(url);
    }
  }
  const w = 'naturalWidth' in bmp ? bmp.naturalWidth || 1024 : bmp.width;
  const h = 'naturalHeight' in bmp ? bmp.naturalHeight || 1024 : bmp.height;
  const c = newCanvas(w, h);
  ctx2d(c).drawImage(bmp, 0, 0, w, h);
  if ('close' in bmp) bmp.close();
  return c;
}

export function docFromCanvas(name: string, c: HTMLCanvasElement): Doc {
  const doc = new Doc(name, c.width, c.height);
  const key = doc.addCanvas(c);
  doc.layers.push({ id: newId(), type: 'raster', name: 'Background', visible: true, opacity: 1, blend: 'normal', key, t: { x: 0, y: 0, sx: 1, sy: 1, rot: 0 } });
  doc.activeId = doc.layers[0].id;
  doc.resetHistory('Open');
  return doc;
}

const canvasBlob = (c: HTMLCanvasElement, type = 'image/png', q?: number) =>
  new Promise<Blob>((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('Encoding failed'))), type, q));

/** .pixl: "PIXL" + u32 version + u32 header length + JSON header + PNG blobs for each raster layer. */
export async function encodePixl(doc: Doc): Promise<Blob> {
  const meta = doc.snapshot();
  const blobs: Blob[] = [];
  const index: Record<string, [number, number]> = {};
  let offset = 0;
  // Every pixel buffer in use: raster layers anywhere in the tree, plus layer masks.
  const keys = flatLayers(meta.layers).flatMap((l) => [l.type === 'raster' ? l.key : null, l.mask?.key ?? null]);
  for (const key of keys) {
    if (!key || index[key]) continue;
    const b = await canvasBlob(doc.pool.get(key)!);
    index[key] = [offset, b.size];
    offset += b.size;
    blobs.push(b);
  }
  const header = new TextEncoder().encode(JSON.stringify({ app: 'AMxPixl', version: FORMAT_VERSION, name: doc.name, meta, blobs: index }));
  const pre = new ArrayBuffer(12);
  const dv = new DataView(pre);
  for (let i = 0; i < 4; i++) dv.setUint8(i, MAGIC.charCodeAt(i));
  dv.setUint32(4, FORMAT_VERSION, true);
  dv.setUint32(8, header.length, true);
  return new Blob([pre, header, ...blobs], { type: 'application/x-amxpixl' });
}

export async function decodePixl(blob: Blob, fallbackName: string): Promise<Doc> {
  const buf = await blob.arrayBuffer();
  const dv = new DataView(buf);
  const magic = String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3));
  if (magic !== MAGIC) throw new Error('Not a Pixl project file.');
  const hlen = dv.getUint32(8, true);
  const head = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 12, hlen))) as { name?: string; meta: Meta; blobs: Record<string, [number, number]> };
  const base = 12 + hlen;
  const m = head.meta;
  const doc = new Doc(head.name || fallbackName, m.width, m.height);
  for (const [key, [off, len]] of Object.entries(head.blobs)) {
    const c = await decodeImage(new Blob([new Uint8Array(buf, base + off, len)], { type: 'image/png' }));
    doc.pool.set(key, c);
  }
  doc.layers = m.layers as Layer[];
  doc.activeId = m.activeId;
  doc.selection = null;
  doc.counter = m.counter || doc.layers.length + 1;
  doc.resetHistory('Open');
  return doc;
}

// ---------- pickers (File System Access API with download/input fallbacks) ----------

type Picked = { file: File; handle: FileSystemFileHandle | null };

interface FSWindow {
  showOpenFilePicker?: (o: unknown) => Promise<FileSystemFileHandle[]>;
  showSaveFilePicker?: (o: unknown) => Promise<FileSystemFileHandle>;
}
const fsw = window as unknown as FSWindow;

export async function pickFiles(kind: 'any' | 'image', multiple = true): Promise<Picked[]> {
  const types = kind === 'image'
    ? [{ description: 'Images', accept: IMAGE_TYPES }]
    : [{ description: 'Images and Pixl projects', accept: { ...IMAGE_TYPES, ...PIXL_TYPES } }, { description: 'Pixl project', accept: PIXL_TYPES }];
  if (fsw.showOpenFilePicker) {
    try {
      const hs = await fsw.showOpenFilePicker({ multiple, types, id: 'amxpixl-open' });
      return Promise.all(hs.map(async (h) => ({ file: await h.getFile(), handle: h })));
    } catch (e) {
      if ((e as DOMException).name === 'AbortError') return [];
    }
  }
  return new Promise((res) => {
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.multiple = multiple;
    inp.accept = kind === 'image' ? 'image/*' : 'image/*,.pixl';
    inp.onchange = () => res([...(inp.files ?? [])].map((f) => ({ file: f, handle: null })));
    inp.click();
  });
}

/** Saves a blob; returns the handle used (null for a plain download) or undefined if cancelled. */
export async function saveBlob(blob: Blob, suggested: string, handle: FileSystemFileHandle | null, accept: Record<string, string[]>): Promise<FileSystemFileHandle | null | undefined> {
  if (handle) {
    const w = await handle.createWritable();
    await w.write(blob);
    await w.close();
    return handle;
  }
  if (fsw.showSaveFilePicker) {
    try {
      const h = await fsw.showSaveFilePicker({ suggestedName: suggested, types: [{ description: suggested.split('.').pop()!.toUpperCase(), accept }], id: 'amxpixl-save' });
      const w = await h.createWritable();
      await w.write(blob);
      await w.close();
      return h;
    } catch (e) {
      if ((e as DOMException).name === 'AbortError') return undefined;
      throw e;
    }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = suggested;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  return null;
}

export const PIXL_ACCEPT = PIXL_TYPES;
export { canvasBlob };
