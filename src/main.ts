import './styles.css';
import { app } from './app';
import * as A from './actions';
import { artboardTool } from './tools/artboard';
import { cloneTool, healTool } from './tools/clone';
import { cropTool } from './tools/crop';
import { moveTool } from './tools/move';
import { brushTool, eraserTool, fillTool, gradientTool, pickerTool } from './tools/paint';
import { penTool } from './tools/pen';
import { blurTool, burnTool, dodgeTool, sharpenTool, smudgeTool } from './tools/retouch';
import { ellipseSelectTool, lassoTool, rectSelectTool, wandTool } from './tools/select';
import { handTool, shapeTool, zoomTool } from './tools/shape';
import { textTool } from './tools/text';
import type { Project } from './core/project';
import { onGpuRestored } from './core/gpu';
import { fileName, isDesktop, onOpenFiles, readPath, takeLaunchFiles } from './core/platform';
import { autosave, clearRecovery, listRecovery, restoreRecovery } from './core/recovery';
import { flushSettings } from './core/settings';
import { dueForCheck } from './core/update';
import { view } from './ui/canvasview';
import { filterDialog, updateDialog } from './ui/dialogs';
import { flatten } from './core/render';
import { mountShell } from './ui/shell';
import { ask, toast } from './ui/widgets';

app.tools = [moveTool, artboardTool, rectSelectTool, ellipseSelectTool, lassoTool, wandTool, cropTool, pickerTool, brushTool, eraserTool, cloneTool, healTool, dodgeTool, burnTool, blurTool, sharpenTool, smudgeTool, gradientTool, fillTool, penTool, textTool, shapeTool, handTool, zoomTool];
app.tool = brushTool;
app.applyPrefs();
document.title = `AMxPixl ${__APP_VERSION__}`;
mountShell(document.getElementById('app')!);

// Drop images anywhere: onto an open image they become layers, otherwise each opens as a new image.
let dragDepth = 0;
const overlay = document.createElement('div');
overlay.className = 'drop-overlay';
overlay.hidden = true;
document.body.append(overlay);
const hasFiles = (e: DragEvent) => [...(e.dataTransfer?.types ?? [])].includes('Files');
window.addEventListener('dragenter', (e) => {
  if (!hasFiles(e)) return;
  dragDepth++;
  overlay.textContent = app.doc ? 'Drop to add as layers' : 'Drop to open';
  overlay.hidden = false;
});
window.addEventListener('dragleave', (e) => { if (hasFiles(e) && --dragDepth <= 0) { dragDepth = 0; overlay.hidden = true; } });
window.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
window.addEventListener('drop', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth = 0;
  overlay.hidden = true;
  const files = [...(e.dataTransfer?.files ?? [])];
  if (!files.length) return;
  if (app.busy) { toast('Apply or cancel the filter first.'); return; }
  const overCanvas = view.el.contains(e.target as Node);
  if (app.doc && overCanvas) A.placeFiles(files);
  else A.openFiles(files.map((f) => ({ file: f, ref: { name: f.name } })));
});

window.addEventListener('paste', (e) => {
  const t = e.target as HTMLElement;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
  const item = [...(e.clipboardData?.items ?? [])].find((i) => i.type.startsWith('image/'));
  e.preventDefault();
  if (app.busy) return;
  A.pasteBlob(item?.getAsFile() ?? null);
});

// ---------- crash recovery, autosave, files from Explorer ----------

/** Offers to bring back documents left unsaved when the app last closed unexpectedly. */
async function offerRecovery() {
  let list = await listRecovery().catch(() => []);
  // In a browser another tab may be editing these right now; its autosaves are recent, so leave them alone.
  if (!isDesktop) list = list.filter((r) => Date.now() - r.savedAt > 3 * 60_000);
  if (!list.length) return;
  const names = list.length === 1 ? `"${list[0].name}"` : `${list.length} images (${list.map((r) => r.name).join(', ')})`;
  const r = await ask('Recover unsaved work?', `AMxPixl didn't close normally last time. ${names} had unsaved changes that can be restored.`, [
    { id: 'discard', label: 'Discard', danger: true }, { id: 'recover', label: 'Recover', primary: true },
  ]);
  for (const it of list) {
    if (r === 'recover') {
      try { const p = await restoreRecovery(it.uid); if (p) { app.addProject(p); changed.add(p); } } catch (err) { toast(`Couldn't recover ${it.name}: ${(err as Error).message}`, 'error'); }
    } else if (r === 'discard') await clearRecovery(it.uid);
  }
}

// After a graphics reset, draw again what was drawn without the graphics card (adjustment, effect and 3D layers, and
// their thumbnails). Other open images redraw when they're switched to.
onGpuRestored(() => { for (const d of app.docs) d.touch('meta'); });

// Something that failed with nothing to catch it (opening, placing or pasting, say) says so instead of doing nothing.
// A burst of the same failure shows once.
let lastFailure = 0;
const reportFailure = (err: unknown) => {
  console.error(err);
  const msg = err instanceof Error ? err.message : typeof err === 'string' ? err : '';
  if (err instanceof DOMException && err.name === 'AbortError') return;
  if (performance.now() - lastFailure < 3000) return;
  lastFailure = performance.now();
  toast(`Something went wrong${msg ? `: ${msg}` : '.'}`, 'error');
};
window.addEventListener('unhandledrejection', (e) => reportFailure(e.reason));
window.addEventListener('error', (e) => { if (e.error) reportFailure(e.error); });

// Every minute (or as often as Preferences says), copy files that changed since the last pass (and still have unsaved
// work) to the recovery store.
const changed = new Set<Project>();
app.on('change', ({ doc }) => { const p = app.projectOf(doc); if (p) changed.add(p); });
let autosaving = false, lastPass = Date.now();
setInterval(async () => {
  const every = (app.prefs.autosaveMin ?? 1) * 60_000;
  if (!every || Date.now() - lastPass < every - 1000) return;
  if (autosaving || app.busy || view.busy) return;
  autosaving = true;
  lastPass = Date.now();
  try {
    for (const p of [...changed]) {
      changed.delete(p);
      if (!app.projects.includes(p)) continue;
      if (p.dirty) await autosave(p);
      // Also catches a save that landed while the autosave above was writing.
      if (!p.dirty) await clearRecovery(p);
    }
  } catch { /* storage full or blocked: recovery is best-effort */ } finally { autosaving = false; }
}, 15_000);

const openPaths = async (paths: string[]) => {
  const files = [];
  for (const p of paths) {
    try { files.push({ file: await readPath(p), ref: { name: fileName(p), path: p } }); } catch (err) { toast(`Couldn't open ${fileName(p)}: ${err}`, 'error'); }
  }
  // (A file double-clicked in Explorer during a filter preview opens once the preview is applied or cancelled.)
  while (app.busy) await new Promise((r) => setTimeout(r, 300));
  if (files.length) await A.openFiles(files);
};

offerRecovery().then(async () => {
  await openPaths(await takeLaunchFiles().catch(() => []));
  onOpenFiles(openPaths);
  if (isDesktop && dueForCheck()) setTimeout(() => updateDialog(true), 8000);
});

if (isDesktop) {
  // Desktop app: ask before closing with unsaved work.
  import('@tauri-apps/api/window').then(({ getCurrentWindow }) => {
    const win = getCurrentWindow();
    win.onCloseRequested(async (e) => {
      e.preventDefault();
      // (During a filter preview the layer holds the previewed pixels: saving now would keep a filter never applied.)
      if (app.busy) { toast('Apply or cancel the filter first.'); return; }
      // A field still being typed in commits first, so its edit counts as unsaved work.
      (document.activeElement as HTMLElement | null)?.blur?.();
      const dirty = app.projects.filter((p) => p.dirty);
      if (dirty.length) {
        const what = dirty.length === 1 ? `"${dirty[0].name}" has` : `${dirty.length} images have`;
        const r = await ask('Unsaved changes', `${what} unsaved changes. Save before closing AMxPixl?`, [
          { id: 'cancel', label: 'Cancel' }, { id: 'close', label: 'Close without saving', danger: true },
          { id: 'save', label: dirty.length === 1 ? 'Save' : 'Save all', primary: true },
        ]);
        if (r === 'save') {
          // One at a time, each shown while it's saved (a new image asks where to go); cancelling one keeps the app open.
          for (const p of dirty) {
            if (!app.projects.includes(p) || !p.dirty) continue;
            app.setDoc(p.active);
            if (!(await A.saveDoc(p.active))) return;
          }
        } else if (r === 'close') {
          // Choosing not to save is deliberate, so don't offer that work back next time.
          await Promise.all(dirty.map((d) => clearRecovery(d).catch(() => {})));
        } else return;
      }
      // A setting changed in the last moment (it's normally written 0.4 s later) is written before the window goes.
      await flushSettings().catch(() => {});
      win.destroy();
    });
  });
  // Keep browser-engine shortcuts (reload, print, find, view source) from firing inside the app. This runs after
  // the app's own shortcut handler (registered first), so keys the app uses, like Ctrl+G and Ctrl+R, still work.
  window.addEventListener('keydown', (e) => {
    const k = e.key.toLowerCase();
    if (e.key === 'F5' || e.key === 'F3' || e.key === 'F7' || ((e.ctrlKey || e.metaKey) && ['r', 'p', 'f', 'g', 'u'].includes(k))) e.preventDefault();
  });
  window.addEventListener('contextmenu', (e) => {
    const t = e.target as HTMLElement;
    if (t.tagName !== 'INPUT' && t.tagName !== 'TEXTAREA') e.preventDefault();
  });
} else {
  window.addEventListener('beforeunload', (e) => {
    if (app.projects.some((p) => p.dirty)) { e.preventDefault(); e.returnValue = ''; }
  });
}

// Dev/test hook (harmless in production): lets automated checks drive the editor.
(window as unknown as Record<string, unknown>).__pixl = { app, actions: A, view, recovery: { autosave, restoreRecovery, clearRecovery }, flatten, filterDialog };
