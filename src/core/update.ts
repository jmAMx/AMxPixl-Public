import { isDesktop } from './platform';

/**
 * Update check against the public AMxPixl repository's GitHub releases (published by scripts/release.ps1). If the check
 * fails (offline, no releases yet) the quiet startup check says nothing.
 */
const REPO = 'jmAMx/AMxPixl-public';
export const RELEASES_URL = `https://github.com/${REPO}/releases/latest`;
const LAST_CHECK = 'amxpixl.updateCheck';

export interface UpdateInfo { version: string; url: string; notes: string }

/** "0.10.1" > "0.9.3": compares dotted numbers, ignoring a leading "v". */
export function newer(a: string, b: string) {
  const pa = a.replace(/^v/i, '').replace('+', '.').split('.').map((n) => parseInt(n) || 0);
  const pb = b.replace(/^v/i, '').replace('+', '.').split('.').map((n) => parseInt(n) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0);
  return false;
}

/** The latest release if it's newer than this build, null if up to date. Throws if the check couldn't be made. */
export async function checkForUpdate(): Promise<UpdateInfo | null> {
  const r = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, { headers: { Accept: 'application/vnd.github+json' }, cache: 'no-store' });
  if (r.status === 404) throw new Error('No public release found to compare against.');
  if (!r.ok) throw new Error(`GitHub answered ${r.status}.`);
  const j = await r.json() as { tag_name: string; html_url: string; body?: string };
  try { localStorage.setItem(LAST_CHECK, String(Date.now())); } catch { /* blocked */ }
  return newer(j.tag_name, __APP_VERSION__) ? { version: j.tag_name.replace(/^v/i, ''), url: j.html_url, notes: j.body ?? '' } : null;
}

/** At most once a day, quietly. */
export function dueForCheck() {
  try { return Date.now() - Number(localStorage.getItem(LAST_CHECK) || 0) > 24 * 3600_000; } catch { return false; }
}

export async function openReleasePage(url = RELEASES_URL) {
  if (!url.startsWith(`https://github.com/${REPO}/releases`)) url = RELEASES_URL;
  if (isDesktop) {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('open_release_page', { url });
  } else window.open(url, '_blank', 'noopener');
}
