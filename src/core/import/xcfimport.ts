import { Doc, newId } from '../document';
import { ctx2d, newCanvas } from '../layers';
import type { Layer } from '../types';
import { WorkerPool } from '../workers/pool';
import { parseXcf, type PxBuf, type XcfLayer, type XcfResult } from './xcf';

/**
 * Opens a GIMP .xcf. The file is read in a background worker (see xcf.ts) so the window stays responsive while
 * big files decompress and GIMP filters are applied; this side only turns the result into a document.
 */

let pool: WorkerPool<{ buf: ArrayBuffer }, { result: XcfResult }> | null = null;

async function parse(buf: ArrayBuffer): Promise<XcfResult> {
  if (typeof Worker === 'undefined') return parseXcf(buf);
  const p = (pool ??= new WorkerPool<{ buf: ArrayBuffer }, { result: XcfResult }>(() => new Worker(new URL('../workers/xcfworker.ts', import.meta.url), { type: 'module' }), 1));
  return (await p.run({ buf }, [buf])).result;
}

function canvasOf(px: PxBuf) {
  const c = newCanvas(px.w, px.h);
  ctx2d(c).putImageData(new ImageData(px.data as Uint8ClampedArray<ArrayBuffer>, px.w, px.h), 0, 0);
  return c;
}

export async function importXcf(buf: ArrayBuffer, name: string): Promise<Doc> {
  const r = await parse(buf);
  const doc = new Doc(name, r.W, r.H);
  const build = (ls: XcfLayer[]): Layer[] => ls.map((l) => {
    const mask = l.mask ? { key: doc.addCanvas(canvasOf(l.mask.px)), t: { x: l.mask.x, y: l.mask.y, sx: 1, sy: 1, rot: 0 }, enabled: l.mask.enabled, density: 1, feather: 0 } : null;
    const base = { id: newId(), name: l.name, visible: l.visible, opacity: l.opacity, mask, linear: l.linear };
    if (l.group) return { ...base, type: 'group', blend: l.blend, children: build(l.children), open: l.open };
    return { ...base, type: 'raster', blend: l.blend === 'pass-through' ? 'normal' : l.blend, key: doc.addCanvas(canvasOf(l.px!)), t: { x: l.x, y: l.y, sx: 1, sy: 1, rot: 0 } };
  });
  doc.layers = build(r.layers);
  doc.guides = r.guides;
  doc.activeId = doc.layers[doc.layers.length - 1]?.id ?? null;
  doc.counter = r.count + 1;
  doc.importNotes = r.notes;
  doc.resetHistory('Import XCF');
  return doc;
}
