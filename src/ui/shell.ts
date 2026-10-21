import { app } from '../app';
import * as A from '../actions';
import { ADJ_LABELS, ADJ_ORDER } from '../core/adjustments';
import { pickFiles } from '../core/fileio';
import { FILTERS } from '../core/filters';
import { glfx } from '../core/glfx';
import { view } from './canvasview';
import { colorPanel } from './colorpanel';
import { aboutDialog, canvasSizeDialog, exportDialog, filterDialog, imageSizeDialog, newDocDialog, shortcutsDialog } from './dialogs';
import { h, isTyping } from './dom';
import { historyPanel } from './historypanel';
import { layersPanel } from './layerspanel';
import { propertiesPanel } from './properties';
import { closePopups, dialogOpen, icon, popupMenu, toast, type MenuItem } from './widgets';

// ---------- menus & shortcuts ----------

interface Cmd { label: string; accel?: string; alt?: string; run: () => void; enabled?: () => boolean; checked?: () => boolean; native?: boolean }
type MenuDef = { title: string; items: (Cmd | 'sep' | { label: string; sub: () => MenuItem[] })[] };

const hasDoc = () => !!app.doc;
const hasLayer = () => !!app.doc?.active;
const hasSel = () => !!app.doc?.selection;

const open = async () => A.openFiles(await pickFiles('any'));
const place = async () => A.placeFiles((await pickFiles('image')).map((p) => p.file));

const pasteFromMenu = async () => {
  try {
    const items = await navigator.clipboard.read();
    for (const it of items) {
      const t = it.types.find((x) => x.startsWith('image/'));
      if (t) { await A.pasteBlob(await it.getType(t)); return; }
    }
  } catch { /* permission denied: fall back to the in-app clipboard */ }
  await A.pasteBlob(null);
};

const MENUS: MenuDef[] = [
  {
    title: 'File', items: [
      { label: 'New…', accel: 'Ctrl+N', run: newDocDialog },
      { label: 'Open…', accel: 'Ctrl+O', run: open },
      { label: 'Place Image as Layer…', accel: 'Ctrl+Shift+O', run: place, enabled: hasDoc },
      'sep',
      { label: 'Save', accel: 'Ctrl+S', run: () => A.saveDoc(), enabled: hasDoc },
      { label: 'Save As…', accel: 'Ctrl+Shift+S', run: () => A.saveDoc(app.doc, true), enabled: hasDoc },
      { label: 'Export Image…', accel: 'Ctrl+Shift+E', run: exportDialog, enabled: hasDoc },
      'sep',
      { label: 'Close', accel: 'Ctrl+W', run: () => A.closeDoc(), enabled: hasDoc },
    ],
  },
  {
    title: 'Edit', items: [
      { label: 'Undo', accel: 'Ctrl+Z', run: A.undo, enabled: () => !!app.doc?.canUndo },
      { label: 'Redo', accel: 'Ctrl+Shift+Z', alt: 'Ctrl+Y', run: A.redo, enabled: () => !!app.doc?.canRedo },
      'sep',
      { label: 'Cut', accel: 'Ctrl+X', run: () => A.copy(false, true), enabled: hasLayer },
      { label: 'Copy', accel: 'Ctrl+C', run: () => A.copy(), enabled: hasLayer },
      { label: 'Copy Merged', accel: 'Ctrl+Shift+C', run: () => A.copy(true), enabled: hasDoc },
      { label: 'Paste', accel: 'Ctrl+V', run: pasteFromMenu, native: true },
      { label: 'Clear', accel: 'Delete', alt: 'Backspace', run: A.clearSelection, enabled: hasLayer },
      'sep',
      { label: 'Fill with Foreground', accel: 'Alt+Backspace', run: () => A.fillWith('fg'), enabled: hasLayer },
      { label: 'Fill with Background', accel: 'Ctrl+Backspace', run: () => A.fillWith('bg'), enabled: hasLayer },
      'sep',
      { label: 'Free Transform', accel: 'Ctrl+T', run: () => app.setTool('move'), enabled: hasLayer },
    ],
  },
  {
    title: 'Image', items: [
      { label: 'Image Size…', accel: 'Ctrl+Alt+I', run: imageSizeDialog, enabled: hasDoc },
      { label: 'Canvas Size…', accel: 'Ctrl+Alt+C', run: canvasSizeDialog, enabled: hasDoc },
      { label: 'Crop to Selection', run: A.cropToSelection, enabled: hasSel },
      'sep',
      { label: 'Rotate 90° Clockwise', run: () => A.rotateCanvas(90), enabled: hasDoc },
      { label: 'Rotate 90° Counter-clockwise', run: () => A.rotateCanvas(-90), enabled: hasDoc },
      { label: 'Rotate 180°', run: () => A.rotateCanvas(180), enabled: hasDoc },
      { label: 'Flip Canvas Horizontal', run: () => A.flipCanvas('h'), enabled: hasDoc },
      { label: 'Flip Canvas Vertical', run: () => A.flipCanvas('v'), enabled: hasDoc },
      'sep',
      { label: 'Flatten Image', run: A.flattenImage, enabled: hasDoc },
    ],
  },
  {
    title: 'Layer', items: [
      { label: 'New Layer', accel: 'Ctrl+Shift+N', run: A.newLayer, enabled: hasDoc },
      { label: 'New Adjustment Layer', sub: () => ADJ_ORDER.map((k) => ({ label: ADJ_LABELS[k], disabled: !app.doc, onClick: () => A.newAdjustment(k) })) },
      { label: 'Duplicate Layer', accel: 'Ctrl+J', run: A.duplicateLayer, enabled: hasLayer },
      { label: 'Delete Layer', run: () => A.deleteLayer(), enabled: hasLayer },
      'sep',
      { label: 'Merge Down', accel: 'Ctrl+E', run: A.mergeDown, enabled: hasLayer },
      { label: 'Rasterize', run: A.rasterizeLayer, enabled: () => app.doc?.active?.type === 'text' || app.doc?.active?.type === 'shape' },
      'sep',
      { label: 'Transform', sub: () => [
        { label: 'Flip Horizontal', onClick: () => A.flipLayer('h'), disabled: !app.doc?.activePlaced },
        { label: 'Flip Vertical', onClick: () => A.flipLayer('v'), disabled: !app.doc?.activePlaced },
        { label: 'Rotate 90° Clockwise', onClick: () => A.rotateLayer90(1), disabled: !app.doc?.activePlaced },
        { label: 'Rotate 90° Counter-clockwise', onClick: () => A.rotateLayer90(-1), disabled: !app.doc?.activePlaced },
        { sep: true },
        { label: 'Reset Transform', onClick: () => A.resetTransform(), disabled: !app.doc?.activePlaced },
      ] },
      { label: 'Arrange', sub: () => [
        { label: 'Bring to Front', accel: 'Ctrl+Shift+]', onClick: () => A.arrange('top'), disabled: !hasLayer() },
        { label: 'Bring Forward', accel: 'Ctrl+]', onClick: () => A.arrange('up'), disabled: !hasLayer() },
        { label: 'Send Backward', accel: 'Ctrl+[', onClick: () => A.arrange('down'), disabled: !hasLayer() },
        { label: 'Send to Back', accel: 'Ctrl+Shift+[', onClick: () => A.arrange('bottom'), disabled: !hasLayer() },
      ] },
    ],
  },
  {
    title: 'Select', items: [
      { label: 'All', accel: 'Ctrl+A', run: A.selectAll, enabled: hasDoc },
      { label: 'Deselect', accel: 'Ctrl+D', run: A.deselect, enabled: hasSel },
      { label: 'Inverse', accel: 'Ctrl+Shift+I', run: A.invertSelection, enabled: hasDoc },
    ],
  },
  {
    title: 'Filter', items: FILTERS.map((f) => ({ label: `${f.name}…`, run: () => filterDialog(f), enabled: hasLayer })),
  },
  {
    title: 'View', items: [
      { label: 'Zoom In', accel: 'Ctrl+=', run: () => view.zoomStep(1), enabled: hasDoc },
      { label: 'Zoom Out', accel: 'Ctrl+-', run: () => view.zoomStep(-1), enabled: hasDoc },
      { label: 'Fit on Screen', accel: 'Ctrl+0', run: () => view.fit(), enabled: hasDoc },
      { label: 'Actual Pixels (100%)', accel: 'Ctrl+1', run: () => { view.setZoom(1); view.center(); }, enabled: hasDoc },
      'sep',
      { label: 'Dark Theme', run: () => app.setPrefs({ theme: app.prefs.theme === 'dark' ? 'light' : 'dark' }), checked: () => app.prefs.theme === 'dark' },
      { label: 'Glow Effects', run: () => app.setPrefs({ glow: !app.prefs.glow }), checked: () => app.prefs.glow },
    ],
  },
  {
    title: 'Help', items: [
      { label: 'Keyboard Shortcuts', accel: 'F1', run: showShortcuts },
      { label: 'About AMxPixl', run: aboutDialog },
    ],
  },
];

const extraShortcuts: [string, string][] = [
  ['V', 'Move & transform'], ['M', 'Rectangle / ellipse select'], ['L', 'Lasso'], ['C', 'Crop'], ['I', 'Eyedropper'],
  ['B', 'Brush'], ['E', 'Eraser'], ['G', 'Gradient / paint bucket'], ['T', 'Text'], ['U', 'Shape'], ['H', 'Hand'], ['Z', 'Zoom'],
  ['X', 'Swap colours'], ['D', 'Default colours'], ['[ / ]', 'Brush size'], ['Space (hold)', 'Pan'], ['Ctrl + wheel', 'Zoom at cursor'],
  ['Alt + click (brush)', 'Pick colour'], ['Shift + drag', 'Add to selection / constrain'], ['Alt + drag', 'Subtract from selection'],
];

function showShortcuts() {
  const rows: [string, string][] = [];
  for (const m of MENUS) for (const it of m.items) if (it !== 'sep' && 'accel' in it && it.accel) rows.push([it.accel, `${m.title} › ${it.label.replace('…', '')}`]);
  shortcutsDialog([...extraShortcuts, ...rows]);
}

function menuItems(def: MenuDef): MenuItem[] {
  return def.items.map((it) => {
    if (it === 'sep') return { sep: true };
    if ('sub' in it) return { label: it.label, sub: it.sub() };
    return { label: it.label, accel: it.accel, disabled: it.enabled ? !it.enabled() : false, checked: it.checked?.(), onClick: it.run };
  });
}

const accelMap = new Map<string, Cmd>();
for (const m of MENUS) for (const it of m.items) {
  if (it === 'sep' || 'sub' in it || it.native) continue;
  if (it.accel) accelMap.set(it.accel, it);
  if (it.alt) accelMap.set(it.alt, it);
}
const arrangeKeys: Record<string, () => void> = {
  'Ctrl+]': () => A.arrange('up'), 'Ctrl+[': () => A.arrange('down'),
  'Ctrl+Shift+]': () => A.arrange('top'), 'Ctrl+Shift+[': () => A.arrange('bottom'),
  'Ctrl+Shift+=': () => view.zoomStep(1),
};

const CODE_KEYS: Record<string, string> = { BracketLeft: '[', BracketRight: ']', Equal: '=', Minus: '-', NumpadAdd: '=', NumpadSubtract: '-', Backquote: '`' };

function accelOf(e: KeyboardEvent) {
  let k = e.key;
  if (/^Key[A-Z]$/.test(e.code)) k = e.code.slice(3);
  else if (/^Digit\d$/.test(e.code)) k = e.code.slice(5);
  else if (CODE_KEYS[e.code]) k = CODE_KEYS[e.code];
  else if (k.length === 1) k = k.toUpperCase();
  const mods = [(e.ctrlKey || e.metaKey) && 'Ctrl', e.altKey && 'Alt', e.shiftKey && 'Shift'].filter(Boolean);
  return [...mods, k].join('+');
}

function onKey(e: KeyboardEvent) {
  if (e.defaultPrevented || dialogOpen() || app.busy) return;
  if (isTyping(e.target)) return;
  const accel = accelOf(e);
  const mod = e.ctrlKey || e.metaKey;
  if (!mod && app.doc && app.tool.keydown?.(e)) { e.preventDefault(); return; }
  const cmd = accelMap.get(accel);
  if (cmd) {
    e.preventDefault();
    if (!cmd.enabled || cmd.enabled()) cmd.run();
    return;
  }
  if (arrangeKeys[accel]) { e.preventDefault(); if (app.doc) arrangeKeys[accel](); return; }
  if (mod || e.altKey) return;
  const key = accel.replace('Shift+', '');
  if (key === 'X') { const f = app.fg; app.setColor('fg', app.bg); app.setColor('bg', f); return; }
  if (key === 'D') { app.setColor('fg', '#000000'); app.setColor('bg', '#ffffff'); return; }
  const group = app.tools.filter((t) => t.key === key);
  if (group.length) {
    e.preventDefault();
    const i = group.indexOf(app.tool);
    app.setTool(group[i >= 0 ? (i + 1) % group.length : 0].id);
  }
}

// ---------- layout ----------

function menubar() {
  let openIdx = -1;
  const buttons: HTMLButtonElement[] = [];
  const openMenu = (i: number) => {
    openIdx = i;
    buttons.forEach((b, j) => b.classList.toggle('open', j === i));
    const r = buttons[i].getBoundingClientRect();
    popupMenu(menuItems(MENUS[i]), r.left, r.bottom + 2, () => { if (openIdx === i) { openIdx = -1; buttons[i].classList.remove('open'); } });
  };
  MENUS.forEach((m, i) => {
    const b = h('button', { class: 'menu-btn', type: 'button' }, m.title);
    b.addEventListener('pointerdown', (e) => { e.preventDefault(); if (openIdx === i) { closePopups(); } else openMenu(i); });
    b.addEventListener('pointerenter', () => { if (openIdx >= 0 && openIdx !== i) openMenu(i); });
    buttons.push(b);
  });
  const themeBtn = h('button', { class: 'round-btn', type: 'button', title: 'Switch light/dark theme', onclick: () => app.setPrefs({ theme: app.prefs.theme === 'dark' ? 'light' : 'dark' }) });
  const drawTheme = () => themeBtn.replaceChildren(icon(app.prefs.theme === 'dark' ? 'sun' : 'moon'));
  drawTheme();
  app.on('prefs', drawTheme);
  const undoBtn = h('button', { class: 'icon-btn', type: 'button', title: 'Undo (Ctrl+Z)', onclick: A.undo }, icon('undo'));
  const redoBtn = h('button', { class: 'icon-btn', type: 'button', title: 'Redo (Ctrl+Shift+Z)', onclick: A.redo }, icon('redo'));
  const syncUndo = () => { undoBtn.disabled = !app.doc?.canUndo; redoBtn.disabled = !app.doc?.canRedo; };
  app.on('change', syncUndo); app.on('docs', syncUndo); syncUndo();
  return h('header', { class: 'menubar' },
    h('div', { class: 'brand', title: 'AMxPixl' },
      h('img', { class: 'mono for-dark', src: 'brand/monogram-dark.png', alt: '' }),
      h('img', { class: 'mono for-light', src: 'brand/monogram-light.png', alt: '' }),
      h('span', { class: 'wordmark' }, h('span', { class: 'px-name' }, 'Pixl')),
      h('span', { class: 'app-version', title: `AMxPixl version ${__APP_VERSION__}` }, `v${__APP_VERSION__}`)),
    h('nav', { class: 'menus' }, ...buttons),
    h('div', { class: 'grow' }),
    undoBtn, redoBtn, themeBtn);
}

function optionsBar() {
  const el = h('div', { class: 'optionsbar' });
  let lastActive: string | null = null;
  const build = () => {
    const t = app.tool;
    el.replaceChildren(h('span', { class: 'opt-tool' }, icon(t.icon), t.name));
    const box = h('div', { class: 'opt-controls' });
    t.options?.(box);
    el.append(box);
  };
  app.on('tool', build);
  // Reflect option changes made elsewhere (e.g. [ ] brush size) unless the user is editing a field here.
  app.on('options', () => { if (!el.contains(document.activeElement)) build(); });
  app.on('colors', () => { if (app.tool.id === 'text') build(); });
  app.on('change', ({ doc }) => {
    if (doc !== app.doc) return;
    if (doc.activeId !== lastActive) { lastActive = doc.activeId; if (app.tool.id === 'text') build(); }
  });
  build();
  return el;
}

function toolbox() {
  const el = h('nav', { class: 'toolbox', 'aria-label': 'Tools' });
  const btns = app.tools.map((t) => {
    const b = h('button', { class: 'tool', type: 'button', title: `${t.name} (${t.key})`, 'aria-label': t.name, onclick: () => app.setTool(t.id) }, icon(t.icon));
    b.dataset.tool = t.id;
    return b;
  });
  const sync = () => btns.forEach((b) => b.classList.toggle('on', b.dataset.tool === app.tool.id));
  const fg = h('button', { class: 'sw fg', type: 'button', title: 'Foreground colour' });
  const bg = h('button', { class: 'sw bg', type: 'button', title: 'Background colour' });
  const syncColors = () => { fg.style.background = app.fg; bg.style.background = app.bg; };
  const showColor = () => { if (!app.prefs.dock.color) { app.prefs.dock.color = true; app.setPrefs({}); } };
  fg.addEventListener('click', showColor);
  bg.addEventListener('click', showColor);
  app.on('tool', sync); app.on('colors', syncColors);
  sync(); syncColors();
  el.append(...btns, h('div', { class: 'grow' }),
    h('div', { class: 'swatch-stack' }, bg, fg),
    h('div', { class: 'swatch-btns' },
      h('button', { class: 'mini', type: 'button', title: 'Default colours (D)', onclick: () => { app.setColor('fg', '#000000'); app.setColor('bg', '#ffffff'); } }, icon('resetColors')),
      h('button', { class: 'mini', type: 'button', title: 'Swap colours (X)', onclick: () => { const f = app.fg; app.setColor('fg', app.bg); app.setColor('bg', f); } }, icon('swap'))));
  return el;
}

function tabs() {
  const el = h('div', { class: 'tabs', role: 'tablist' });
  const build = () => {
    el.replaceChildren(...app.docs.map((d) => {
      const t = h('div', { class: 'tab' + (d === app.doc ? ' on' : ''), role: 'tab', title: `${d.name} · ${d.width} × ${d.height}` },
        h('span', { class: 'tab-name' }, d.name), d.dirty ? h('span', { class: 'dirty', title: 'Unsaved changes' }, '●') : null,
        h('button', { class: 'tab-x', type: 'button', title: 'Close (Ctrl+W)', onclick: (e: MouseEvent) => { e.stopPropagation(); A.closeDoc(d); } }, icon('close')));
      t.addEventListener('pointerdown', (e) => { if (e.button === 1) { e.preventDefault(); A.closeDoc(d); } else if (d !== app.doc) app.setDoc(d); });
      return t;
    }), h('button', { class: 'tab-new', type: 'button', title: 'New image (Ctrl+N)', onclick: newDocDialog }, icon('plus')));
  };
  let lastDirty = '';
  app.on('docs', build);
  app.on('change', () => { const s = app.docs.map((d) => d.dirty).join(); if (s !== lastDirty) { lastDirty = s; build(); } });
  build();
  return el;
}

function welcome() {
  const el = h('div', { class: 'welcome' },
    h('div', { class: 'welcome-card' },
      h('img', { class: 'mono for-dark', src: 'brand/monogram-dark.png', alt: '' }),
      h('img', { class: 'mono for-light', src: 'brand/monogram-light.png', alt: '' }),
      h('h1', { class: 'wordmark big' }, h('span', { class: 'px-name' }, 'Pixl'), h('span', { class: 'dim' }, ' Editor')),
      h('p', { class: 'dim' }, 'Lossless layers, GPU adjustments, everything on this PC.'),
      h('div', { class: 'welcome-actions' },
        h('button', { class: 'btn primary', type: 'button', onclick: newDocDialog }, icon('plus'), 'New image'),
        h('button', { class: 'btn', type: 'button', onclick: open }, icon('folder'), 'Open…')),
      h('p', { class: 'dim small' }, 'or drop images here · Ctrl+V pastes from the clipboard')));
  const sync = () => { el.hidden = app.docs.length > 0; };
  app.on('docs', sync);
  sync();
  return el;
}

function statusbar() {
  const hint = h('span', { class: 'st-hint' });
  const pos = h('span', { class: 'st-pos' });
  const size = h('span', { class: 'st-size' });
  const zoom = h('input', { class: 'st-zoom', type: 'text', title: 'Zoom (type a value)', spellcheck: false });
  zoom.addEventListener('change', () => { const v = parseFloat(zoom.value); if (v > 0) view.setZoom(v / 100); syncZoom(); });
  zoom.addEventListener('keydown', (e) => { if (e.key === 'Enter') zoom.blur(); });
  const gpu = h('span', { class: 'st-gpu', title: glfx.ok ? `Adjustments run on the GPU (max texture ${glfx.maxSize}px)` : 'WebGL2 unavailable: adjustment layers are disabled' }, glfx.ok ? 'GPU' : 'GPU off');
  gpu.classList.toggle('bad', !glfx.ok);
  const syncZoom = () => { if (document.activeElement !== zoom) zoom.value = app.doc ? `${+(app.doc.zoom * 100).toFixed(1)}%` : ''; };
  const sync = () => {
    hint.textContent = app.tool?.hint ?? '';
    const d = app.doc;
    size.textContent = d ? `${d.width} × ${d.height} px · ${d.layers.length} layer${d.layers.length === 1 ? '' : 's'}` : '';
    zoom.disabled = !d;
    syncZoom();
  };
  view.onCursor = (p) => { pos.textContent = p && app.doc ? `${Math.floor(p.x)}, ${Math.floor(p.y)}` : ''; };
  app.on('tool', sync); app.on('docs', sync); app.on('view', syncZoom); app.on('change', sync);
  sync();
  return h('footer', { class: 'statusbar' }, hint, h('span', { class: 'grow' }), pos, size, zoom, gpu);
}

function dock() {
  const panels: { id: keyof typeof app.prefs.dock & string; title: string; el: HTMLElement; grow?: boolean }[] = [
    { id: 'color', title: 'Colour', el: colorPanel() },
    { id: 'properties', title: 'Properties', el: propertiesPanel(), grow: true },
    { id: 'layers', title: 'Layers', el: layersPanel(), grow: true },
    { id: 'history', title: 'History', el: historyPanel() },
  ];
  const el = h('aside', { class: 'dock' });
  const build = () => {
    el.replaceChildren(...panels.map((p) => {
      const openP = app.prefs.dock[p.id] !== false;
      return h('section', { class: `panel panel-${p.id}` + (openP ? ' open' : '') + (p.grow ? ' grow' : '') },
        h('button', { class: 'panel-head', type: 'button', 'aria-expanded': String(openP), onclick: () => { app.prefs.dock[p.id] = !openP; app.setPrefs({}); } },
          h('span', { class: 'chev' }, icon('chevron')), p.title),
        h('div', { class: 'panel-body' }, p.el));
    }));
  };
  app.on('prefs', build);
  build();
  return el;
}

export function mountShell(root: HTMLElement) {
  const ws = view.el;
  ws.append(welcome());
  root.append(
    menubar(),
    optionsBar(),
    h('div', { class: 'main' },
      toolbox(),
      h('section', { class: 'center' }, tabs(), ws),
      dock()),
    statusbar());
  window.addEventListener('keydown', onKey);
}

export { toast };
