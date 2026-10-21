import { toast } from './widgets';

/** Fonts that ship with Windows 10/11, plus Rajdhani bundled with the app. */
const BUILTIN = [
  'Segoe UI', 'Arial', 'Arial Black', 'Bahnschrift', 'Calibri', 'Cambria', 'Candara', 'Comic Sans MS', 'Consolas',
  'Constantia', 'Corbel', 'Courier New', 'Franklin Gothic Medium', 'Gabriola', 'Georgia', 'Impact', 'Ink Free',
  'Lucida Console', 'Palatino Linotype', 'Rajdhani', 'Segoe Print', 'Segoe Script', 'Sitka Text', 'Sylfaen',
  'Tahoma', 'Times New Roman', 'Trebuchet MS', 'Verdana',
];

let fonts = [...BUILTIN];
let loadedAll = false;

export const fontList = () => fonts;
export const allFontsLoaded = () => loadedAll;

/** Asks the browser for every installed font (Chromium's Local Font Access; prompts once). */
export async function loadInstalledFonts(): Promise<boolean> {
  const q = (window as unknown as { queryLocalFonts?: () => Promise<{ family: string }[]> }).queryLocalFonts;
  if (!q) { toast('This build can only list the common Windows fonts.'); return false; }
  try {
    const list = await q();
    fonts = [...new Set([...BUILTIN, ...list.map((f) => f.family)])].sort((a, b) => a.localeCompare(b));
    loadedAll = true;
    return true;
  } catch {
    toast('Font access was not allowed.');
    return false;
  }
}
