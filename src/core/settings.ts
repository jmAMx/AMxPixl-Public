import { isDesktop } from './platform';

/**
 * Everything Pixl remembers between sessions (preferences, tool options, colours, saved looks, recent files, brush
 * presets and tips) lives in localStorage under "amxpixl." keys. In the desktop app it's also mirrored to
 * settings.json in the app's config folder, because the web view's own storage isn't dependable across updates:
 * at startup, any key missing from localStorage is put back from that file.
 */
const PREFIX = 'amxpixl.';
let timer = 0;

/** Fills in any settings localStorage has lost from the settings file. Runs before the app reads its settings. */
export async function restoreSettings() {
  if (!isDesktop) return;
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    const text = await invoke<string>('read_settings');
    if (!text) { saveSettingsSoon(); return; }
    const saved = JSON.parse(text) as Record<string, string>;
    let restored = 0;
    for (const [k, v] of Object.entries(saved)) {
      if (k.startsWith(PREFIX) && typeof v === 'string' && localStorage.getItem(k) === null) { localStorage.setItem(k, v); restored++; }
    }
    // Put back what was missing, and bring the file up to date with anything only localStorage had.
    if (restored || Object.keys(saved).length !== allSettings().length) saveSettingsSoon();
  } catch { /* no file yet, or storage blocked: carry on with what there is */ }
}

function allSettings(): [string, string][] {
  const out: [string, string][] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k?.startsWith(PREFIX)) out.push([k, localStorage.getItem(k)!]);
  }
  return out;
}

/** A settings change not yet in the file. */
let pending = false;

async function writeSettings() {
  pending = false;
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('write_settings', { json: JSON.stringify(Object.fromEntries(allSettings())) });
  } catch { pending = true; /* the next change (or closing) tries again */ }
}

/** Writes the settings file shortly (several changes in a row are saved once). */
export function saveSettingsSoon() {
  if (!isDesktop) return;
  pending = true;
  clearTimeout(timer);
  timer = window.setTimeout(() => { void writeSettings(); }, 400);
}

/** Writes any settings change still waiting, now (when the app closes). */
export async function flushSettings() {
  clearTimeout(timer);
  if (pending) await writeSettings();
}

/** localStorage.setItem for a setting, also saved to the settings file. Throws like setItem when storage is full. */
export function setSetting(key: string, value: string) {
  localStorage.setItem(key, value);
  saveSettingsSoon();
}
