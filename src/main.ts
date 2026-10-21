import './styles.css';
import { app } from './app';
import * as A from './actions';
import { cropTool } from './tools/crop';
import { moveTool } from './tools/move';
import { brushTool, eraserTool, fillTool, gradientTool, pickerTool } from './tools/paint';
import { ellipseSelectTool, lassoTool, rectSelectTool } from './tools/select';
import { handTool, shapeTool, zoomTool } from './tools/shape';
import { textTool } from './tools/text';
import { view } from './ui/canvasview';
import { mountShell } from './ui/shell';
import { ask } from './ui/widgets';

app.tools = [moveTool, rectSelectTool, ellipseSelectTool, lassoTool, cropTool, pickerTool, brushTool, eraserTool, gradientTool, fillTool, textTool, shapeTool, handTool, zoomTool];
app.tool = brushTool;
app.applyPrefs();
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
  const overCanvas = view.el.contains(e.target as Node);
  if (app.doc && overCanvas) A.placeFiles(files);
  else A.openFiles(files.map((f) => ({ file: f, handle: null })));
});

window.addEventListener('paste', (e) => {
  const t = e.target as HTMLElement;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
  const item = [...(e.clipboardData?.items ?? [])].find((i) => i.type.startsWith('image/'));
  e.preventDefault();
  A.pasteBlob(item?.getAsFile() ?? null);
});

const isDesktop = '__TAURI_INTERNALS__' in window;

if (isDesktop) {
  // Desktop app: ask before closing with unsaved work.
  import('@tauri-apps/api/window').then(({ getCurrentWindow }) => {
    const win = getCurrentWindow();
    win.onCloseRequested(async (e) => {
      const dirty = app.docs.filter((d) => d.dirty);
      if (!dirty.length) return;
      e.preventDefault();
      const what = dirty.length === 1 ? `"${dirty[0].name}" has` : `${dirty.length} images have`;
      const r = await ask('Unsaved changes', `${what} unsaved changes. Close AMxPixl anyway?`, [
        { id: 'cancel', label: 'Cancel', primary: true }, { id: 'close', label: 'Close without saving', danger: true },
      ]);
      if (r === 'close') win.destroy();
    });
  });
  // Keep browser-engine shortcuts (reload, print, find, view source) from firing inside the app.
  window.addEventListener('keydown', (e) => {
    const k = e.key.toLowerCase();
    if (e.key === 'F5' || e.key === 'F3' || e.key === 'F7' || ((e.ctrlKey || e.metaKey) && ['r', 'p', 'f', 'g', 'u'].includes(k))) e.preventDefault();
  }, true);
  window.addEventListener('contextmenu', (e) => {
    const t = e.target as HTMLElement;
    if (t.tagName !== 'INPUT' && t.tagName !== 'TEXTAREA') e.preventDefault();
  });
} else {
  window.addEventListener('beforeunload', (e) => {
    if (app.docs.some((d) => d.dirty)) { e.preventDefault(); e.returnValue = ''; }
  });
}

// Dev/test hook (harmless in production): lets automated checks drive the editor.
(window as unknown as Record<string, unknown>).__pixl = { app, actions: A, view };
