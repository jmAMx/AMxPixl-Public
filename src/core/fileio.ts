import { Doc, flatLayers, newId } from './document';
import { ctx2d, newCanvas } from './layers';
import { fileName, isDesktop, openDialog, readPath, saveDialog, writePath, type Filters } from './platform';
import type { Layer, Meta } from './types';
import { Project } from './project';
import { textureKeys } from './model3d';
import { VIDEO_EXT } from './import/animated';
import { WorkerPool } from './workers/pool';

const MAGIC = 'PIXL';
/** The newest .pixl version this Pixl reads (see encodePixl). */
const FORMAT_VERSION = 2;

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

/**
 * Runs `f` on each item, four at a time, results in order. Decoding images runs on the browser's other cores, and
 * encoding does in workers (see pngOf), so layers done together open and save faster on a 4-core PC; only a few at a
 * time, so a document with many large layers doesn't need every layer's working copy in memory together.
 */
export async function fewAtOnce<T, R>(items: T[], f: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const run = async () => { while (next < items.length) { const i = next++; out[i] = await f(items[i]); } };
  await Promise.all(Array.from({ length: Math.min(4, items.length) }, run));
  return out;
}

const canvasBlob = (c: HTMLCanvasElement, type = 'image/png', q?: number) =>
  new Promise<Blob>((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('Encoding failed'))), type, q));

/** Up to four PNG workers (see pngworker.ts), started on the first save; null where workers can't encode. */
let pngPool: WorkerPool<{ bitmap: ImageBitmap }, { blob: Blob }> | null | undefined;

/** A canvas as PNG, encoded in a worker (or on the page if that fails). Same file as canvasBlob. */
async function pngOf(c: HTMLCanvasElement): Promise<Blob> {
  if (pngPool === undefined) {
    pngPool = typeof Worker !== 'undefined' && typeof OffscreenCanvas !== 'undefined'
      ? new WorkerPool(() => new Worker(new URL('./workers/pngworker.ts', import.meta.url), { type: 'module' }), 4) : null;
  }
  if (pngPool && c.width && c.height) {
    try {
      const bitmap = await createImageBitmap(c);
      return (await pngPool.run({ bitmap }, [bitmap])).blob;
    } catch { /* fall back below */ }
  }
  return canvasBlob(c);
}

/** Every pixel buffer a snapshot's layers use: raster layers anywhere in the tree, masks, LUTs and 3D textures. */
export function layerKeys(meta: Meta): string[] {
  return [...new Set(flatLayers(meta.layers).flatMap((l) => [
    l.type === 'raster' ? l.key : null, l.mask?.key ?? null, l.type === 'adjust' && l.adj.kind === 'lut' ? l.adj.key : null,
    ...(l.type === 'raster' ? textureKeys(l.model) : []),
  ]))].filter((k): k is string => !!k);
}

/**
 * One artboard in a version 2 header: its name, place, layers and where its pixel buffers are; `source`, the .pixl of
 * its own it came from (see Doc.source; desktop paths only).
 */
interface BoardHead {
  name: string; x: number; y: number; meta: Meta; blobs: Record<string, [number, number]>;
  source?: { name: string; path: string; linked?: boolean; hash?: string };
}

/** A file's contents as SHA-256 (hex), to tell whether it changed. */
export async function hashOf(b: Blob): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', await b.arrayBuffer()));
  return [...d].map((x) => x.toString(16).padStart(2, '0')).join('');
}

/**
 * .pixl: "PIXL" + u32 version + u32 header length + JSON header + PNG blobs for each pixel buffer. Version 1 is one
 * image (`meta` and `blobs`); version 2 has `boards`, an artboard each. A file with one artboard is still written as
 * version 1, so earlier versions of Pixl can open it.
 */
export async function encodePixl(p: Pick<Project, 'name' | 'boards'>): Promise<Blob> {
  const boards = p.boards.map((b) => ({ b, meta: b.doc.snapshot() }));
  const jobs = boards.flatMap(({ b, meta }, i) => layerKeys(meta).map((key) => ({ i, key, canvas: b.doc.pool.get(key)! })));
  const encoded = await fewAtOnce(jobs, (j) => pngOf(j.canvas));
  const index: Record<string, [number, number]>[] = boards.map(() => ({}));
  let offset = 0;
  jobs.forEach((j, n) => { index[j.i][j.key] = [offset, encoded[n].size]; offset += encoded[n].size; });
  const one = boards.length === 1;
  const version = one ? 1 : 2;
  const sourceOf = (d: Doc): BoardHead['source'] => (d.source?.file.path ? { name: d.source.name, path: d.source.file.path, linked: d.source.linked, hash: d.source.hash } : undefined);
  // (Version 1 with `board`: the artboard's own name and link, which earlier versions ignore.)
  const head = one
    ? { app: 'AMxPixl', version, name: p.name, meta: boards[0].meta, blobs: index[0], board: { name: boards[0].b.doc.name, source: sourceOf(boards[0].b.doc) } }
    : { app: 'AMxPixl', version, name: p.name, boards: boards.map(({ b, meta }, i): BoardHead => ({ name: b.doc.name, x: b.x, y: b.y, meta, blobs: index[i], source: sourceOf(b.doc) })) };
  const header = new TextEncoder().encode(JSON.stringify(head));
  const pre = new ArrayBuffer(12);
  const dv = new DataView(pre);
  for (let i = 0; i < 4; i++) dv.setUint8(i, MAGIC.charCodeAt(i));
  dv.setUint32(4, version, true);
  dv.setUint32(8, header.length, true);
  return new Blob([pre, header, ...encoded], { type: 'application/x-amxpixl' });
}

export async function decodePixl(blob: Blob, fallbackName: string): Promise<Project> {
  const buf = await blob.arrayBuffer();
  const dv = new DataView(buf);
  const magic = String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3));
  if (magic !== MAGIC) throw new Error('Not a Pixl project file.');
  if (dv.getUint32(4, true) > FORMAT_VERSION) throw new Error('it was saved by a newer version of Pixl. Update Pixl to open it.');
  const hlen = dv.getUint32(8, true);
  const head = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 12, hlen))) as
    { name?: string; meta?: Meta; blobs?: Record<string, [number, number]>; boards?: BoardHead[]; board?: { name?: string; source?: BoardHead['source'] } };
  const base = 12 + hlen;
  const name = head.name || fallbackName;
  const heads: BoardHead[] = head.boards ?? [{ name: head.board?.name || name, x: 0, y: 0, meta: head.meta!, blobs: head.blobs!, source: head.board?.source }];
  const jobs = heads.flatMap((b, i) => Object.entries(b.blobs).map(([key, [off, len]]) => ({ i, key, off, len })));
  const canvases = await fewAtOnce(jobs, (j) => decodeImage(new Blob([new Uint8Array(buf, base + j.off, j.len)], { type: 'image/png' })));
  const docs = heads.map((b) => {
    const d = docFromMeta(b.name, b.meta);
    if (b.source) d.source = { name: b.source.name, file: { name: b.source.name, path: b.source.path }, linked: b.source.linked, hash: b.source.hash };
    return d;
  });
  jobs.forEach((j, n) => docs[j.i].pool.set(j.key, canvases[n]));
  docs[0].resetHistory('Open');
  return new Project(name, heads.map((b, i) => ({ doc: docs[i], x: b.x, y: b.y })));
}

/** An image with a saved snapshot's layers and settings (its pixel buffers are added after). */
export function docFromMeta(name: string, m: Meta): Doc {
  const doc = new Doc(name, m.width, m.height);
  doc.layers = m.layers as Layer[];
  doc.activeId = m.activeId;
  doc.selection = null;
  doc.counter = m.counter || doc.layers.length + 1;
  doc.guides = m.guides ?? [];
  doc.resample = m.resample ?? 'smooth';
  doc.anim = m.anim ?? null;
  doc.paths = m.paths ?? [];
  doc.activePath = m.activePath ?? null;
  return doc;
}

// ---------- pickers (native dialogs on desktop; File System Access API / download fallbacks in a browser) ----------

/** Where a file lives: a real path on desktop, or a browser file handle. Used to save back and reopen. */
export interface FileRef { name: string; path?: string | null; handle?: FileSystemFileHandle | null }

export type Picked = { file: File; ref: FileRef };

interface FSWindow {
  showOpenFilePicker?: (o: unknown) => Promise<FileSystemFileHandle[]>;
  showSaveFilePicker?: (o: unknown) => Promise<FileSystemFileHandle>;
}
const fsw = window as unknown as FSWindow;

/** Layered files from other editors that AMxPixl can import. */
export const LAYERED_EXT = ['psd', 'xcf'];

export async function pickFiles(kind: 'any' | 'image', multiple = true): Promise<Picked[]> {
  if (isDesktop) {
    const filters: Filters = kind === 'image'
      ? [{ name: 'Images', extensions: IMAGE_EXT }]
      : [{ name: 'Images, projects, layered files and video', extensions: ['pixl', ...LAYERED_EXT, ...IMAGE_EXT, ...VIDEO_EXT] }, { name: 'Pixl project', extensions: ['pixl'] },
        { name: 'Photoshop / GIMP', extensions: LAYERED_EXT }, { name: 'Images', extensions: IMAGE_EXT }, { name: 'Video (opens frame by frame)', extensions: VIDEO_EXT }];
    const paths = await openDialog(filters, multiple);
    return Promise.all(paths.map(async (p) => ({ file: await readPath(p), ref: { name: fileName(p), path: p } })));
  }
  const layered = { 'application/octet-stream': LAYERED_EXT.map((e) => '.' + e) } as Record<string, string[]>;
  const types = kind === 'image'
    ? [{ description: 'Images', accept: IMAGE_TYPES }]
    : [{ description: 'Images, projects, layered files and video', accept: { ...IMAGE_TYPES, ...PIXL_TYPES, ...layered, 'video/*': VIDEO_EXT.map((e) => '.' + e) } }, { description: 'Pixl project', accept: PIXL_TYPES }];
  if (fsw.showOpenFilePicker) {
    try {
      const hs = await fsw.showOpenFilePicker({ multiple, types, id: 'amxpixl-open' });
      return Promise.all(hs.map(async (h) => ({ file: await h.getFile(), ref: { name: h.name, handle: h } })));
    } catch (e) {
      if ((e as DOMException).name === 'AbortError') return [];
    }
  }
  return new Promise((res) => {
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.multiple = multiple;
    inp.accept = kind === 'image' ? 'image/*' : `image/*,.pixl,.psd,.xcf,${VIDEO_EXT.map((e) => '.' + e).join(',')}`;
    inp.onchange = () => res([...(inp.files ?? [])].map((f) => ({ file: f, ref: { name: f.name } })));
    inp.click();
  });
}

/**
 * Saves a blob, overwriting `existing` when given, otherwise asking where. Returns where it went (a ref with no
 * path or handle for a plain browser download), or undefined if cancelled.
 */
export async function saveBlob(blob: Blob, suggested: string, existing: FileRef | null, accept: Record<string, string[]>): Promise<FileRef | undefined> {
  if (existing?.path) { await writePath(existing.path, blob); return existing; }
  if (existing?.handle) {
    const w = await existing.handle.createWritable();
    await w.write(blob);
    await w.close();
    return existing;
  }
  if (isDesktop) {
    const ext = Object.values(accept).flat().map((e) => e.replace('.', ''));
    const path = await saveDialog(suggested, [{ name: ext[0]?.toUpperCase() ?? 'File', extensions: ext }]);
    if (!path) return undefined;
    await writePath(path, blob);
    return { name: fileName(path), path };
  }
  if (fsw.showSaveFilePicker) {
    try {
      const h = await fsw.showSaveFilePicker({ suggestedName: suggested, types: [{ description: suggested.split('.').pop()!.toUpperCase(), accept }], id: 'amxpixl-save' });
      const w = await h.createWritable();
      await w.write(blob);
      await w.close();
      return { name: h.name, handle: h };
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
  return { name: suggested };
}

export const PIXL_ACCEPT = PIXL_TYPES;
export { canvasBlob };
