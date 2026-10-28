import { app } from '../app';
import { addGuide, colorRangeSelection, createDoc, cropToContent, deleteLook, exportImage, lookSourceLayers, modifySelection, nextUntitled, resizeCanvas, resizeImage, saveLook } from '../actions';
import { savedLooks } from '../core/looks';
import { colorRangeMask, sampleSource, type Modify, type SelMode } from '../core/selops';
import { checkForUpdate, openReleasePage, type UpdateInfo } from '../core/update';
import { ANIM_EXT, ANIM_MIME, exportAnimation, type AnimExportOptions, type AnimFormat } from '../core/animexport';
import { saveBlob } from '../core/fileio';
import { view } from './canvasview';
import { cloneCanvas, ctx2d } from '../core/layers';
import { FILTERS, maskedMerge, type FilterDef, type Params } from '../core/filters';
import { h } from './dom';
import { paintableTarget } from '../tools/paint';
import { checkbox, dialog, numField, seg, slider, toast } from './widgets';

const PRESETS: [string, number, number][] = [
  ['Full HD 1920 × 1080', 1920, 1080],
  ['4K UHD 3840 × 2160', 3840, 2160],
  ['Square post 1080 × 1080', 1080, 1080],
  ['Portrait post 1080 × 1350', 1080, 1350],
  ['Story 1080 × 1920', 1080, 1920],
  ['YouTube thumbnail 1280 × 720', 1280, 720],
  ['Logo 1024 × 1024', 1024, 1024],
  ['Web banner 1500 × 500', 1500, 500],
  ['A4 @ 300 ppi 2480 × 3508', 2480, 3508],
  ['Letter @ 300 ppi 2550 × 3300', 2550, 3300],
];

export function newDocDialog() {
  let w = 1920, hh = 1080, bg: 'white' | 'black' | 'transparent' | 'bgcolor' = 'white';
  const name = h('input', { type: 'text', value: nextUntitled(), spellcheck: false });
  const wf = numField('Width', w, (v) => { w = v; }, { unit: 'px', min: 1, max: 30000 });
  const hf = numField('Height', hh, (v) => { hh = v; }, { unit: 'px', min: 1, max: 30000 });
  const preset = h('select', {
    onchange: () => {
      const p = PRESETS[Number(preset.value)];
      if (!p) return;
      w = p[1]; hh = p[2]; wf.set(w); hf.set(hh);
    },
  }, ...PRESETS.map(([l], i) => h('option', { value: i }, l)), h('option', { value: -1 }, 'Custom'));
  const swap = h('button', { class: 'btn small', type: 'button', title: 'Swap width and height', onclick: () => { [w, hh] = [hh, w]; wf.set(w); hf.set(hh); } }, '⇄');
  dialog({
    title: 'New image', width: 440,
    body: [
      h('label', { class: 'field wide' }, h('span', null, 'Name'), name),
      h('label', { class: 'field wide' }, h('span', null, 'Preset'), preset),
      h('div', { class: 'row' }, wf, hf, swap),
      h('div', { class: 'field wide' }, h('span', null, 'Background'),
        seg([{ v: 'white', label: 'White' }, { v: 'black', label: 'Black' }, { v: 'transparent', label: 'Transparent' }, { v: 'bgcolor', label: 'BG colour' }], bg, (v) => { bg = v; })),
    ],
    buttons: [
      { label: 'Cancel' },
      {
        label: 'Create', primary: true, onClick: () => {
          const fill = bg === 'white' ? '#ffffff' : bg === 'black' ? '#000000' : bg === 'bgcolor' ? app.bg : null;
          createDoc(name.value.trim() || nextUntitled(), Math.round(w), Math.round(hh), fill);
        },
      },
    ],
  });
}

export function imageSizeDialog() {
  const doc = app.doc; if (!doc) return;
  const W = doc.width, H = doc.height;
  let w = W, hh = H, link = true, resample = doc.resample;
  const wf = numField('Width', w, (v) => { w = Math.round(v); if (link) { hh = Math.max(1, Math.round((w * H) / W)); hf.set(hh); } pct(); }, { unit: 'px', min: 1, max: 30000 });
  const hf = numField('Height', hh, (v) => { hh = Math.round(v); if (link) { w = Math.max(1, Math.round((hh * W) / H)); wf.set(w); } pct(); }, { unit: 'px', min: 1, max: 30000 });
  const pctF = numField('Scale', 100, (v) => { w = Math.max(1, Math.round((W * v) / 100)); hh = Math.max(1, Math.round((H * v) / 100)); wf.set(w); hf.set(hh); }, { unit: '%', min: 1, max: 1000, decimals: 1 });
  const pct = () => pctF.set((w / W) * 100);
  dialog({
    title: 'Image size', width: 440,
    body: [
      h('p', { class: 'dialog-msg' }, `Currently ${W} × ${H} px.`),
      h('div', { class: 'row' }, wf, hf),
      h('div', { class: 'row' }, pctF, checkbox('Keep proportions', link, (v) => { link = v; })),
      resampleField(resample, (v) => { resample = v; }),
      h('p', { class: 'dialog-note' }, 'Lossless: every layer keeps its original pixels, so you can resize down and back up with no quality loss. Pixels are only resampled once, when you export. Nearest neighbour keeps pixel art blocky (best at 200%, 300%, 400%…).'),
    ],
    buttons: [{ label: 'Cancel' }, { label: 'Resize', primary: true, onClick: () => { if (w !== W || hh !== H || resample !== doc.resample) resizeImage(w, hh, resample); } }],
  });
}

/** Smooth vs nearest-neighbour resampling (Image Size and Export). */
function resampleField(value: 'smooth' | 'nearest', onChange: (v: 'smooth' | 'nearest') => void) {
  return h('div', { class: 'field wide' }, h('span', null, 'Resample'),
    seg([{ v: 'smooth', label: 'Smooth', title: 'Best for photos and artwork' }, { v: 'nearest', label: 'Nearest neighbour', title: 'Hard, blocky pixels for pixel art' }], value, onChange));
}

export function canvasSizeDialog() {
  const doc = app.doc; if (!doc) return;
  let w = doc.width, hh = doc.height, ax = 0.5, ay = 0.5;
  const grid = h('div', { class: 'anchor-grid' });
  const drawGrid = () => {
    grid.replaceChildren(...[0, 0.5, 1].flatMap((y) => [0, 0.5, 1].map((x) => h('button', {
      type: 'button', class: x === ax && y === ay ? 'on' : '', title: 'Anchor',
      onclick: () => { ax = x; ay = y; drawGrid(); },
    }))));
  };
  drawGrid();
  dialog({
    title: 'Canvas size', width: 440,
    body: [
      h('p', { class: 'dialog-msg' }, `Currently ${doc.width} × ${doc.height} px. Changes the canvas around your layers without scaling them.`),
      h('div', { class: 'row' }, numField('Width', w, (v) => { w = Math.round(v); }, { unit: 'px', min: 1, max: 30000 }), numField('Height', hh, (v) => { hh = Math.round(v); }, { unit: 'px', min: 1, max: 30000 })),
      h('div', { class: 'field wide' }, h('span', null, 'Anchor'), grid),
    ],
    buttons: [
      { label: 'Crop to content', onClick: () => { void cropToContent(); } },
      { label: 'Cancel' }, { label: 'Apply', primary: true, onClick: () => resizeCanvas(w, hh, ax, ay) },
    ],
  });
}

export function exportDialog() {
  const doc = app.doc; if (!doc) return;
  let format: 'png' | 'jpeg' | 'webp' = 'png', quality = 0.92, scale = 1, resample = doc.resample;
  const info = h('p', { class: 'dialog-msg' });
  const q = slider({ label: 'Quality', min: 0.1, max: 1, step: 1, display: 100, value: quality, unit: '%', onInput: (v) => { quality = v; } });
  const upd = () => {
    info.textContent = `${Math.round(doc.width * scale)} × ${Math.round(doc.height * scale)} px · ${format.toUpperCase()}${format === 'jpeg' ? ' (transparent areas become white)' : ''}`;
    q.style.display = format === 'png' ? 'none' : '';
  };
  const sc = numField('Size', 100, (v) => { scale = v / 100; upd(); }, { unit: '%', min: 1, max: 800, decimals: 0 });
  upd();
  dialog({
    title: 'Export image', width: 440,
    body: [
      h('div', { class: 'field wide' }, h('span', null, 'Format'),
        seg([{ v: 'png', label: 'PNG' }, { v: 'jpeg', label: 'JPEG' }, { v: 'webp', label: 'WebP' }], format, (v) => { format = v; upd(); })),
      q, sc, resampleField(resample, (v) => { resample = v; }), info,
      h('p', { class: 'dialog-note' }, 'Exports are resampled straight from each layer\'s originals for the sharpest result. Save as .pixl to keep layers.'),
    ],
    buttons: [{ label: 'Cancel' }, { label: 'Export', primary: true, onClick: () => { exportImage(doc, { format, quality, scale, nearest: resample === 'nearest' }).catch((e) => toast(`Export failed: ${e.message}`, 'error')); } }],
  });
}

/** Destructive filter with live on-canvas preview; Cancel restores the original pixels. */
export function filterDialog(def: FilterDef) {
  const doc = app.doc; if (!doc) return;
  const pt = paintableTarget(doc); if (!pt) return;
  const layer = pt.target;
  const src = doc.canvasOf(layer);
  const key = layer.key;
  const backup = cloneCanvas(src);
  const mask = doc.maskForLayer(layer);
  const params: Params = Object.fromEntries(def.params.map((p) => [p.key, p.value]));
  let preview = true;
  let pending = 0;
  const show = (c: HTMLCanvasElement) => {
    const x = ctx2d(src);
    x.save();
    x.globalCompositeOperation = 'copy';
    x.drawImage(c, 0, 0);
    x.restore();
    doc.markPixels(key);
  };
  const run = () => maskedMerge(backup, def.run(backup, params), mask);
  const schedule = () => {
    cancelAnimationFrame(pending);
    pending = requestAnimationFrame(() => { show(preview ? run() : backup); });
  };
  app.busy = true;
  schedule();
  const done = () => { app.busy = false; cancelAnimationFrame(pending); };
  dialog({
    title: def.name, width: 360, modeless: true,
    body: [
      ...def.params.map((p) => p.bool
        ? checkbox(p.label, !!params[p.key], (v) => { params[p.key] = v ? 1 : 0; schedule(); })
        : slider({ label: p.label, min: p.min, max: p.max, step: p.step, value: p.value, unit: p.unit, onInput: (v) => { params[p.key] = v; schedule(); } })),
      checkbox('Preview', true, (v) => { preview = v; schedule(); }),
      mask ? h('p', { class: 'dialog-note' }, 'Applies inside the selection only.') : null,
    ].filter(Boolean) as HTMLElement[],
    onCancel: () => { done(); show(backup); },
    buttons: [
      { label: 'Cancel', onClick: () => { done(); show(backup); } },
      {
        label: 'Apply', primary: true, onClick: () => {
          done();
          show(run());
          doc.commit(def.name, [{ key, rect: { x: 0, y: 0, w: src.width, h: src.height }, before: backup, after: null }]);
        },
      },
    ],
  });
}

export const filterById = (id: string) => FILTERS.find((f) => f.id === id)!;

export function saveLookDialog() {
  const src = lookSourceLayers();
  if (!src.length) { toast('Select an effect or adjustment layer (or a group of them) to save as a look.'); return; }
  const name = h('input', { type: 'text', value: app.doc?.active?.type === 'group' ? app.doc.active.name.replace(/^Look: /, '') : 'My look', spellcheck: false });
  dialog({
    title: 'Save look', width: 420,
    body: [
      h('p', { class: 'dialog-msg' }, `Saves these ${src.length} layer${src.length === 1 ? '' : 's'} as a reusable look: ${src.map((l) => l.name).join(', ')}.`),
      h('label', { class: 'field wide' }, h('span', null, 'Name'), name),
      h('p', { class: 'dialog-note' }, 'Find it later under Filter › Looks. Applying a look adds these layers as a group above the selected layer.'),
    ],
    buttons: [{ label: 'Cancel' }, { label: 'Save', primary: true, onClick: async () => { const n = name.value.trim(); if (!n) return false; return (await saveLook(n)) ? undefined : false; } }],
  });
}

export function manageLooksDialog() {
  const list = h('div', { class: 'look-list' });
  const draw = () => {
    const looks = savedLooks();
    list.replaceChildren(...(looks.length ? looks.map((l) => h('div', { class: 'look-row' },
      h('span', null, l.name), h('span', { class: 'dim' }, `${l.items.length} layer${l.items.length === 1 ? '' : 's'}`),
      h('button', { class: 'btn small danger', type: 'button', onclick: () => { deleteLook(l.name); draw(); } }, 'Delete')))
      : [h('p', { class: 'dialog-msg dim' }, 'No saved looks yet. Select some effect layers and use Filter › Looks › Save Current Effects as Look.')]));
  };
  draw();
  dialog({ title: 'Manage looks', width: 440, body: list, buttons: [{ label: 'Close', primary: true }] });
}

export function newGuideDialog() {
  const doc = app.doc; if (!doc) return;
  let axis: 'x' | 'y' = 'x', pos = Math.round(doc.width / 2);
  const f = numField('Position', pos, (v) => { pos = v; }, { unit: 'px' });
  dialog({
    title: 'New guide', width: 380,
    body: [
      h('div', { class: 'field wide' }, h('span', null, 'Direction'), seg([{ v: 'x', label: 'Vertical' }, { v: 'y', label: 'Horizontal' }], axis, (v) => { axis = v; f.set(pos = Math.round((v === 'x' ? doc.width : doc.height) / 2)); })),
      f,
      h('p', { class: 'dialog-note' }, 'Tip: with rulers on (View › Rulers), drag from a ruler to place a guide; drag it back onto a ruler to remove it.'),
    ],
    buttons: [{ label: 'Cancel' }, { label: 'Add', primary: true, onClick: () => addGuide(axis, pos) }],
  });
}

/** Select › Colour Range: click the image (or use the foreground colour) and tune how far the match reaches. */
export function colorRangeDialog() {
  const doc = app.doc; if (!doc) return;
  const src = sampleSource(doc, true, null);
  const hexRgb = (hex: string): [number, number, number] => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255) as [number, number, number];
  let mode = 0, fuzz = 40, rgb = hexRgb(app.fg), how: SelMode = 'replace', pending = 0;
  // Live preview of the mask: white is selected.
  const scale = Math.min(1, 300 / Math.max(doc.width, doc.height));
  const thumb = h('canvas', { class: 'range-preview', width: Math.max(1, Math.round(doc.width * scale)), height: Math.max(1, Math.round(doc.height * scale)) });
  const swatch = h('span', { class: 'range-swatch' });
  const draw = () => {
    cancelAnimationFrame(pending);
    pending = requestAnimationFrame(() => {
      swatch.style.background = `rgb(${rgb.map((v) => Math.round(v * 255)).join(',')})`;
      const m = colorRangeMask(src, mode, fuzz, rgb);
      const x = ctx2d(thumb);
      x.globalCompositeOperation = 'source-over';
      x.fillStyle = '#000';
      x.fillRect(0, 0, thumb.width, thumb.height);
      x.drawImage(m, 0, 0, thumb.width, thumb.height);
    });
  };
  // While open, a click on the image samples its colour.
  const sample = (e: PointerEvent) => {
    if (e.button !== 0 || mode !== 0) return;
    const r = view.clientRect();
    const p = view.toDoc(e.clientX - r.left, e.clientY - r.top);
    if (p.x < 0 || p.y < 0 || p.x >= doc.width || p.y >= doc.height) return;
    e.preventDefault(); e.stopPropagation();
    const d = ctx2d(src).getImageData(Math.floor(p.x), Math.floor(p.y), 1, 1).data;
    rgb = [d[0] / 255, d[1] / 255, d[2] / 255];
    draw();
  };
  view.el.addEventListener('pointerdown', sample, true);
  const done = () => { cancelAnimationFrame(pending); view.el.removeEventListener('pointerdown', sample, true); };
  const fuzzSlider = slider({ label: 'Fuzziness', min: 0, max: 200, value: fuzz, onInput: (v) => { fuzz = v; draw(); } });
  draw();
  dialog({
    title: 'Colour Range', width: 380, modeless: true,
    body: [
      h('div', { class: 'field wide' }, h('span', null, 'Select'), seg([{ v: '0', label: 'Colour' }, { v: '1', label: 'Highlights' }, { v: '2', label: 'Midtones' }, { v: '3', label: 'Shadows' }], '0', (v) => {
        mode = +v; fuzzSlider.hidden = mode !== 0; draw();
      })),
      h('div', { class: 'field wide' }, h('span', null, 'Colour'), h('div', { class: 'range-pick' }, swatch,
        h('button', { class: 'btn small', type: 'button', onclick: () => { rgb = hexRgb(app.fg); draw(); } }, 'Use foreground'))),
      fuzzSlider,
      thumb,
      h('div', { class: 'field wide' }, h('span', null, 'Result'), seg([{ v: 'replace', label: 'New' }, { v: 'add', label: 'Add' }, { v: 'sub', label: 'Subtract' }], how, (v) => { how = v as SelMode; })),
      h('p', { class: 'dialog-note' }, 'Click the image to pick the colour. White in the preview is what gets selected.'),
    ],
    onCancel: done,
    buttons: [
      { label: 'Cancel', onClick: done },
      { label: 'OK', primary: true, onClick: () => { done(); colorRangeSelection(src, mode, fuzz, rgb, how); } },
    ],
  });
}

const MODIFY: { v: Modify; label: string; note: string; max: number; def: number }[] = [
  { v: 'feather', label: 'Feather', note: 'Softens the edge over this many pixels.', max: 250, def: 5 },
  { v: 'grow', label: 'Expand', note: 'Pushes the edge outward.', max: 100, def: 4 },
  { v: 'shrink', label: 'Contract', note: 'Pulls the edge inward.', max: 100, def: 4 },
  { v: 'smooth', label: 'Smooth', note: 'Rounds off corners and removes specks.', max: 100, def: 4 },
  { v: 'border', label: 'Border', note: 'Keeps only a band this wide along the edge.', max: 200, def: 8 },
];

/** Select › Modify: feather, expand, contract, smooth or border. */
export function modifySelectionDialog(kind: Modify) {
  if (!app.doc?.selection) { toast('Make a selection first.'); return; }
  const m = MODIFY.find((x) => x.v === kind)!;
  let r = m.def;
  dialog({
    title: `${m.label} selection`, width: 360,
    body: [
      slider({ label: 'Radius', min: 1, max: m.max, value: r, unit: 'px', onInput: (v) => { r = v; } }),
      h('p', { class: 'dialog-note' }, m.note),
    ],
    buttons: [{ label: 'Cancel' }, { label: 'OK', primary: true, onClick: () => modifySelection(kind, r) }],
  });
}

export function shortcutsDialog(rows: [string, string][]) {
  dialog({
    title: 'Keyboard shortcuts', width: 560,
    body: h('div', { class: 'shortcut-list' }, ...rows.map(([k, l]) => h('div', { class: 'shortcut' }, h('span', null, l), h('kbd', null, k)))),
    buttons: [{ label: 'Close', primary: true }],
  });
}

/** File › Export Animation: GIF, animated PNG, MP4 or WebM from the Timeline's frames. */
export function animExportDialog() {
  const doc = app.doc; if (!doc) return;
  const a = doc.anim;
  if (!a) {
    toast('Make an animation first: View › Timeline, then "Frames from layers" or "Effects loop".');
    if (!app.prefs.dock.timeline) app.setPrefs({ dock: { ...app.prefs.dock, timeline: true } });
    return;
  }
  let format: AnimFormat = 'gif', scale = 1, background: AnimExportOptions['background'] = 'transparent', repeat = 1, busy = false;
  const total = a.frames.reduce((t, f) => t + (f.ms ?? 1000 / a.fps), 0);
  const info = h('p', { class: 'dialog-msg' });
  const bgRow = h('div', { class: 'field wide' }, h('span', null, 'Background'),
    seg([{ v: 'transparent', label: 'See-through' }, { v: 'white', label: 'White' }, { v: 'black', label: 'Black' }], background, (v) => { background = v; upd(); }));
  const repeatF = numField('Repeat', repeat, (v) => { repeat = v; upd(); }, { min: 1, max: 50, unit: '×' });
  const progress = h('progress', { class: 'export-progress', max: 1, value: 0 });
  progress.hidden = true;
  const upd = () => {
    const video = format === 'mp4' || format === 'webm';
    let w = Math.round(doc.width * scale), hh = Math.round(doc.height * scale);
    if (video) { w += w % 2; hh += hh % 2; }
    info.textContent = `${w} × ${hh} px · ${a.frames.length} frames · ${((total * (video ? repeat : 1)) / 1000).toFixed(2)} s${video ? '' : a.loop ? ' · loops' : ' · plays once'}`
      + (video && background === 'transparent' ? ' · video has no transparency, so see-through areas become black' : '')
      + (format === 'gif' ? ' · GIF is limited to 256 colours per frame' : '');
    repeatF.hidden = !video;
  };
  upd();
  dialog({
    title: 'Export animation', width: 470,
    body: [
      h('div', { class: 'field wide' }, h('span', null, 'Format'),
        seg([{ v: 'gif', label: 'GIF' }, { v: 'apng', label: 'Animated PNG' }, { v: 'mp4', label: 'MP4' }, { v: 'webm', label: 'WebM' }], format, (v) => { format = v; upd(); })),
      numField('Size', 100, (v) => { scale = v / 100; upd(); }, { unit: '%', min: 1, max: 400 }),
      bgRow, repeatF,
      resampleField(doc.resample, (v) => { doc.resample = v; }),
      info, progress,
      h('p', { class: 'dialog-note' }, 'Animated PNG keeps full colour and soft transparency (most browsers, Discord). MP4 plays everywhere; WebM is smaller for the web.'),
    ],
    buttons: [
      { label: 'Cancel' },
      {
        label: 'Export', primary: true, onClick: async () => {
          if (busy) return false;
          busy = true;
          progress.hidden = false;
          try {
            const blob = await exportAnimation(doc, { format, scale, nearest: doc.resample === 'nearest', background, repeat, onProgress: (d, t) => { progress.value = d / t; } });
            const ext = ANIM_EXT[format];
            const ref = await saveBlob(blob, `${doc.name.replace(/\.[^.]+$/, '')}.${ext}`, null, { [ANIM_MIME[format]]: [`.${ext}`] });
            if (ref !== undefined) toast(`Exported ${format.toUpperCase()} (${(blob.size / 1024 / 1024).toFixed(2)} MB)`);
          } catch (err) {
            toast(`Export failed: ${(err as Error).message}`, 'error');
            busy = false;
            progress.hidden = true;
            return false;
          }
          return undefined;
        },
      },
    ],
  });
}

/** Help › Check for Updates (or `quiet` at startup: only speaks up when there is something new). */
export async function updateDialog(quiet = false) {
  let info: UpdateInfo | null;
  try { info = await checkForUpdate(); } catch (err) {
    if (!quiet) toast(`Couldn't check for updates: ${(err as Error).message}`, 'error');
    return;
  }
  if (!info) { if (!quiet) toast(`You're up to date (version ${__APP_VERSION__}).`); return; }
  const notes = info.notes.trim().split('\n').slice(0, 12).join('\n');
  dialog({
    title: 'Update available', width: 440,
    body: [
      h('p', { class: 'dialog-msg' }, `AMxPixl ${info.version} is available. You have ${__APP_VERSION__}.`),
      notes ? h('pre', { class: 'update-notes' }, notes) : null,
      h('p', { class: 'dialog-note' }, 'Download the installer and run it: it replaces this version and keeps your settings.'),
    ].filter(Boolean) as HTMLElement[],
    buttons: [{ label: 'Later' }, { label: 'Open download page', primary: true, onClick: () => { openReleasePage(info!.url).catch(() => {}); } }],
  });
}

export function aboutDialog() {
  dialog({
    title: 'About AMxPixl', width: 420,
    body: [
      h('div', { class: 'about' },
        h('img', { src: 'brand/pixl-logo-256.png', alt: '', width: 72, height: 72 }),
        h('div', null, h('strong', null, 'Pixl Editor'), h('div', { class: 'dim' }, `AMxPixl · version ${__APP_VERSION__} · an AMx app`))),
      h('p', { class: 'dialog-msg' }, 'A lightweight, non-destructive image editor. Layers keep their original pixels, adjustments run on the GPU, and everything stays on this PC.'),
      h('p', { class: 'dialog-msg dim' }, '© 2026 AutoMatrix Solutions LLC · Free and open source under the MIT licence.'),
    ],
    buttons: [{ label: 'Close', primary: true }],
  });
}
