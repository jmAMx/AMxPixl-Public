import { Doc, flatLayers } from './document';
import { canvasBlob, decodeImage } from './fileio';
import { idbDel, idbGet, idbKeys, idbPut } from './idb';
import type { Meta } from './types';

/**
 * Crash recovery: unsaved documents are copied to IndexedDB in the background. Only pixel buffers that changed
 * since the last autosave are re-encoded, which keeps it light on a hard drive. Cleared on save or close.
 */
interface Record { uid: string; name: string; savedAt: number; meta: Meta; keys: string[]; file: Doc['file'] }

/** Pixel buffers a snapshot needs: raster layers, 3D textures, masks, LUTs and raster selections. */
function keysOf(m: Meta): string[] {
  const keys = new Set<string>();
  for (const l of flatLayers(m.layers)) {
    if (l.type === 'raster') keys.add(l.key);
    if (l.type === 'raster' && l.model?.texture) keys.add(l.model.texture.key);
    if (l.mask) keys.add(l.mask.key);
    if (l.type === 'adjust' && l.adj.kind === 'lut' && l.adj.key) keys.add(l.adj.key);
  }
  for (const op of m.selection?.ops ?? []) if (op.shape === 'mask' && op.key) keys.add(op.key);
  if (m.quickMask) keys.add(m.quickMask);
  return [...keys];
}

export async function autosave(doc: Doc) {
  const meta = doc.snapshot();
  const keys = keysOf(meta);
  for (const k of keys) {
    if (doc.storedKeys.has(k) && !doc.dirtyKeys.has(k)) continue;
    const c = doc.pool.get(k);
    if (!c) continue;
    doc.dirtyKeys.delete(k);
    await idbPut('blobs', `${doc.uid}/${k}`, await canvasBlob(c));
    doc.storedKeys.add(k);
    // Yield between layers so the editor stays responsive.
    await new Promise((r) => setTimeout(r, 0));
  }
  const file = doc.file ? { name: doc.file.name, path: doc.file.path ?? null, handle: doc.file.handle ?? null } : null;
  await idbPut('recovery', doc.uid, { uid: doc.uid, name: doc.name, savedAt: Date.now(), meta, keys, file } satisfies Record);
  // Drop buffers this document no longer uses.
  const live = new Set(keys.map((k) => `${doc.uid}/${k}`));
  for (const id of await idbKeys('blobs')) if (id.startsWith(`${doc.uid}/`) && !live.has(id)) { await idbDel('blobs', id); doc.storedKeys.delete(id.slice(doc.uid.length + 1)); }
}

export async function clearRecovery(doc: Doc | string) {
  const uid = typeof doc === 'string' ? doc : doc.uid;
  await idbDel('recovery', uid);
  for (const id of await idbKeys('blobs')) if (id.startsWith(`${uid}/`)) await idbDel('blobs', id);
  if (typeof doc !== 'string') doc.storedKeys.clear();
}

export async function listRecovery(): Promise<{ uid: string; name: string; savedAt: number }[]> {
  const out = [];
  for (const uid of await idbKeys('recovery')) {
    const r = await idbGet<Record>('recovery', uid);
    if (r) out.push({ uid: r.uid, name: r.name, savedAt: r.savedAt });
  }
  return out.sort((a, b) => b.savedAt - a.savedAt);
}

/** Rebuilds a recovered document (marked unsaved). */
export async function restoreRecovery(uid: string): Promise<Doc | null> {
  const r = await idbGet<Record>('recovery', uid);
  if (!r) return null;
  const doc = new Doc(r.name, r.meta.width, r.meta.height);
  for (const k of r.keys) {
    const b = await idbGet<Blob>('blobs', `${uid}/${k}`);
    if (!b) throw new Error('part of the image data is missing.');
    doc.pool.set(k, await decodeImage(b));
  }
  doc.layers = r.meta.layers;
  doc.activeId = r.meta.activeId;
  doc.counter = r.meta.counter;
  doc.guides = r.meta.guides ?? [];
  doc.resample = r.meta.resample ?? 'smooth';
  doc.anim = r.meta.anim ?? null;
  doc.paths = r.meta.paths ?? [];
  doc.activePath = r.meta.activePath ?? null;
  doc.setSelection(r.meta.selection ?? null);
  doc.quickMask = r.meta.quickMask ?? null;
  doc.file = r.file;
  doc.resetHistory('Recovered');
  doc.savedIndex = -1;
  await clearRecovery(uid);
  return doc;
}
