import { Doc, flatLayers } from './document';
import { canvasBlob, decodeImage } from './fileio';
import { idbDel, idbGet, idbKeys, idbPut } from './idb';
import { isDesktop } from './platform';
import type { Meta } from './types';

/**
 * Crash recovery: unsaved documents are copied in the background. Only pixel buffers that changed since the last
 * autosave are re-encoded, which keeps it light on a hard drive. Cleared on save or close.
 *
 * In the desktop app the copies are plain files in the app's data folder, each written safely (see the Rust side),
 * so a crash, a power cut or an ended task can't damage them. The web view's own storage (IndexedDB), which an
 * abrupt end can, is only used in a browser, and on the desktop only to recover copies made before 0.8.3.
 */
interface Record { uid: string; name: string; savedAt: number; meta: Meta; keys: string[]; file: Doc['file'] }

/** Where copies are kept: one image's record (its layers and settings) and pixel buffers (PNG), by key. */
interface Store {
  putBlob(uid: string, k: string, b: Blob): Promise<void>;
  getBlob(uid: string, k: string): Promise<Blob | null>;
  putRecord(r: Record): Promise<void>;
  getRecord(uid: string): Promise<Record | null>;
  /** Images with a record. */
  list(): Promise<string[]>;
  /** Removes the buffers of `uid` that aren't in `keep`. */
  prune(uid: string, keep: string[]): Promise<void>;
  clear(uid: string): Promise<void>;
}

const browserStore: Store = {
  putBlob: async (uid, k, b) => { await idbPut('blobs', `${uid}/${k}`, b); },
  getBlob: async (uid, k) => (await idbGet<Blob>('blobs', `${uid}/${k}`)) ?? null,
  putRecord: async (r) => { await idbPut('recovery', r.uid, r); },
  getRecord: async (uid) => (await idbGet<Record>('recovery', uid)) ?? null,
  list: () => idbKeys('recovery'),
  async prune(uid, keep) {
    const live = new Set(keep.map((k) => `${uid}/${k}`));
    for (const id of await idbKeys('blobs')) if (id.startsWith(`${uid}/`) && !live.has(id)) await idbDel('blobs', id);
  },
  async clear(uid) {
    await idbDel('recovery', uid);
    for (const id of await idbKeys('blobs')) if (id.startsWith(`${uid}/`)) await idbDel('blobs', id);
  },
};

const core = () => import('@tauri-apps/api/core');
/** A pixel buffer's file name: its key, with anything but letters, digits, - and _ spelled out. */
const fileOf = (k: string) => `${k.replace(/[^A-Za-z0-9_-]/g, (c) => `_${c.charCodeAt(0).toString(16).padStart(4, '0')}`)}.png`;
const write = async (uid: string, name: string, bytes: Uint8Array) => {
  const { invoke } = await core();
  await invoke('recovery_write', bytes, { headers: { uid, name } });
};
const read = async (uid: string, name: string): Promise<ArrayBuffer | null> => {
  const { invoke } = await core();
  try { return await invoke<ArrayBuffer>('recovery_read', { uid, name }); } catch { return null; }
};

const fileStore: Store = {
  putBlob: async (uid, k, b) => write(uid, fileOf(k), new Uint8Array(await b.arrayBuffer())),
  async getBlob(uid, k) {
    const buf = await read(uid, fileOf(k));
    return buf ? new Blob([buf], { type: 'image/png' }) : null;
  },
  // (A browser file handle can't be written out, and the desktop app uses paths instead.)
  putRecord: (r) => write(r.uid, 'record.json', new TextEncoder().encode(JSON.stringify({ ...r, file: r.file && { ...r.file, handle: null } }))),
  async getRecord(uid) {
    const buf = await read(uid, 'record.json');
    return buf ? (JSON.parse(new TextDecoder().decode(buf)) as Record) : null;
  },
  list: async () => (await core()).invoke<string[]>('recovery_list', { uid: null }),
  async prune(uid, keep) {
    const { invoke } = await core();
    const live = new Set([...keep.map(fileOf), 'record.json']);
    for (const name of await invoke<string[]>('recovery_list', { uid })) if (!live.has(name)) await invoke('recovery_delete', { uid, name });
  },
  clear: async (uid) => (await core()).invoke('recovery_delete', { uid, name: null }),
};

const store = isDesktop ? fileStore : browserStore;

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
    await store.putBlob(doc.uid, k, await canvasBlob(c));
    doc.storedKeys.add(k);
    // Yield between layers so the editor stays responsive.
    await new Promise((r) => setTimeout(r, 0));
  }
  // The record goes last: until it's written, the previous one (and the buffers it names) still stands.
  const file = doc.file ? { name: doc.file.name, path: doc.file.path ?? null, handle: doc.file.handle ?? null } : null;
  await store.putRecord({ uid: doc.uid, name: doc.name, savedAt: Date.now(), meta, keys, file });
  // Drop buffers this document no longer uses.
  await store.prune(doc.uid, keys);
  for (const k of [...doc.storedKeys]) if (!keys.includes(k)) doc.storedKeys.delete(k);
}

export async function clearRecovery(doc: Doc | string) {
  const uid = typeof doc === 'string' ? doc : doc.uid;
  await store.clear(uid);
  if (isDesktop) await browserStore.clear(uid).catch(() => {});
  if (typeof doc !== 'string') doc.storedKeys.clear();
}

/** Where an image's copy is: the files, or (desktop, from before 0.8.3) the web view's storage. */
async function storeOf(uid: string): Promise<Store | null> {
  if (await store.getRecord(uid)) return store;
  if (isDesktop && (await browserStore.getRecord(uid).catch(() => null))) return browserStore;
  return null;
}

export async function listRecovery(): Promise<{ uid: string; name: string; savedAt: number }[]> {
  const uids = new Set(await store.list().catch(() => [] as string[]));
  if (isDesktop) for (const uid of await browserStore.list().catch(() => [] as string[])) uids.add(uid);
  const out = [];
  for (const uid of uids) {
    const s = await storeOf(uid);
    const r = s && (await s.getRecord(uid));
    if (r) out.push({ uid: r.uid, name: r.name, savedAt: r.savedAt });
  }
  return out.sort((a, b) => b.savedAt - a.savedAt);
}

/** Rebuilds a recovered document (marked unsaved). */
export async function restoreRecovery(uid: string): Promise<Doc | null> {
  const s = await storeOf(uid);
  const r = s && (await s.getRecord(uid));
  if (!s || !r) return null;
  const doc = new Doc(r.name, r.meta.width, r.meta.height);
  for (const k of r.keys) {
    const b = await s.getBlob(uid, k);
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
