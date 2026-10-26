import type { FileRef } from './fileio';
import { idbDel, idbGet, idbPut } from './idb';
import { readPath } from './platform';

export interface RecentEntry { id: string; name: string; path?: string; time: number; thumb?: string }

const KEY = 'amxpixl.recent';
const MAX = 12;

export function recentList(): RecentEntry[] {
  try { return JSON.parse(localStorage.getItem(KEY) || '[]') as RecentEntry[]; } catch { return []; }
}

function store(list: RecentEntry[]) {
  try { localStorage.setItem(KEY, JSON.stringify(list.slice(0, MAX))); } catch { /* full or blocked: recent files are a convenience */ }
}

/** Remembers a file that was opened or saved (moving it to the top). Browser handles go to IndexedDB. */
export async function addRecent(ref: FileRef, thumb?: string) {
  let id: string;
  if (ref.path) id = `p:${ref.path.toLowerCase()}`;
  else if (ref.handle) {
    id = `h:${ref.name}`;
    try { await idbPut('handles', id, ref.handle); } catch { return; }
  } else return;
  const old = recentList();
  const prev = old.find((e) => e.id === id);
  const entry: RecentEntry = { id, name: ref.name, path: ref.path ?? undefined, time: Date.now(), thumb: thumb ?? prev?.thumb };
  store([entry, ...old.filter((e) => e.id !== id)]);
  for (const e of old.slice(MAX - 1)) if (e.id.startsWith('h:') && e.id !== id) idbDel('handles', e.id).catch(() => {});
}

export function removeRecent(id: string) {
  store(recentList().filter((e) => e.id !== id));
  if (id.startsWith('h:')) idbDel('handles', id).catch(() => {});
}

export function clearRecent() {
  for (const e of recentList()) removeRecent(e.id);
}

/** Opens a recent entry again (may ask the browser for permission). Throws if the file is gone. */
export async function openRecent(e: RecentEntry): Promise<{ file: File; ref: FileRef }> {
  if (e.path) return { file: await readPath(e.path), ref: { name: e.name, path: e.path } };
  const h = await idbGet<FileSystemFileHandle>('handles', e.id);
  if (!h) throw new Error('This file is no longer available.');
  const ph = h as FileSystemFileHandle & { requestPermission?: (o: unknown) => Promise<string> };
  if (ph.requestPermission && (await ph.requestPermission({ mode: 'readwrite' })) !== 'granted') throw new Error('Permission to open the file was not given.');
  return { file: await h.getFile(), ref: { name: e.name, handle: h } };
}
