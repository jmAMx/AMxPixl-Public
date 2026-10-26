/** Minimal IndexedDB key-value stores (recent-file handles, crash recovery). */
const DB = 'amxpixl';
const STORES = ['handles', 'recovery', 'blobs'];
let dbp: Promise<IDBDatabase> | null = null;

function db(): Promise<IDBDatabase> {
  if (!dbp) {
    dbp = new Promise((res, rej) => {
      const r = indexedDB.open(DB, 1);
      r.onupgradeneeded = () => { for (const s of STORES) if (!r.result.objectStoreNames.contains(s)) r.result.createObjectStore(s); };
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  }
  return dbp;
}

function req<T>(store: string, mode: IDBTransactionMode, f: (s: IDBObjectStore) => IDBRequest): Promise<T> {
  return db().then((d) => new Promise<T>((res, rej) => {
    const r = f(d.transaction(store, mode).objectStore(store));
    r.onsuccess = () => res(r.result as T);
    r.onerror = () => rej(r.error);
  }));
}

export const idbGet = <T>(store: string, key: string) => req<T | undefined>(store, 'readonly', (s) => s.get(key));
export const idbPut = (store: string, key: string, value: unknown) => req<IDBValidKey>(store, 'readwrite', (s) => s.put(value, key));
export const idbDel = (store: string, key: string) => req<undefined>(store, 'readwrite', (s) => s.delete(key));
export const idbKeys = (store: string) => req<IDBValidKey[]>(store, 'readonly', (s) => s.getAllKeys()).then((k) => k.map(String));
