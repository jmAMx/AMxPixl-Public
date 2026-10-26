/**
 * Desktop (Tauri) file access: native open/save dialogs and reading/writing real paths, so files can be saved back
 * in place, reopened from Recent Files, and opened by double-clicking in Explorer. In a plain browser these are
 * unavailable and callers fall back to the File System Access API.
 */
export const isDesktop = '__TAURI_INTERNALS__' in window;

const core = () => import('@tauri-apps/api/core');

export const fileName = (path: string) => path.split(/[\\/]/).pop() || path;

export async function readPath(path: string): Promise<File> {
  const { invoke } = await core();
  const buf = await invoke<ArrayBuffer>('read_file', { path });
  return new File([buf], fileName(path));
}

export async function writePath(path: string, blob: Blob) {
  const { invoke } = await core();
  await invoke('write_file', new Uint8Array(await blob.arrayBuffer()), { headers: { path: encodeURIComponent(path) } });
}

export type Filters = { name: string; extensions: string[] }[];

export async function openDialog(filters: Filters, multiple = true): Promise<string[]> {
  const { open } = await import('@tauri-apps/plugin-dialog');
  const r = await open({ multiple, filters });
  return r ? (Array.isArray(r) ? r : [r]) : [];
}

export async function saveDialog(suggested: string, filters: Filters): Promise<string | null> {
  const { save } = await import('@tauri-apps/plugin-dialog');
  return (await save({ defaultPath: suggested, filters })) ?? null;
}

/** Files the app was launched with (double-clicked in Explorer), once. */
export async function takeLaunchFiles(): Promise<string[]> {
  if (!isDesktop) return [];
  const { invoke } = await core();
  return invoke<string[]>('take_open_files');
}

/** Calls `f` whenever another launch (double-clicking a file while open) passes files along. */
export async function onOpenFiles(f: (paths: string[]) => void) {
  if (!isDesktop) return;
  const { listen } = await import('@tauri-apps/api/event');
  await listen<string[]>('open-files', (e) => f(e.payload));
}
