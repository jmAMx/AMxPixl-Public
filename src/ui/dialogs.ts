import { app } from '../app';
import { createDoc, exportImage, nextUntitled, resizeCanvas, resizeImage } from '../actions';
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
  let w = W, hh = H, link = true;
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
      h('p', { class: 'dialog-note' }, 'Lossless: every layer keeps its original pixels, so you can resize down and back up with no quality loss. Pixels are only resampled once, when you export.'),
    ],
    buttons: [{ label: 'Cancel' }, { label: 'Resize', primary: true, onClick: () => { if (w !== W || hh !== H) resizeImage(w, hh); } }],
  });
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
    buttons: [{ label: 'Cancel' }, { label: 'Apply', primary: true, onClick: () => resizeCanvas(w, hh, ax, ay) }],
  });
}

export function exportDialog() {
  const doc = app.doc; if (!doc) return;
  let format: 'png' | 'jpeg' | 'webp' = 'png', quality = 0.92, scale = 1;
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
      q, sc, info,
      h('p', { class: 'dialog-note' }, 'Exports are resampled straight from each layer\'s originals for the sharpest result. Save as .pixl to keep layers.'),
    ],
    buttons: [{ label: 'Cancel' }, { label: 'Export', primary: true, onClick: () => { exportImage(doc, { format, quality, scale }).catch((e) => toast(`Export failed: ${e.message}`, 'error')); } }],
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

export function shortcutsDialog(rows: [string, string][]) {
  dialog({
    title: 'Keyboard shortcuts', width: 560,
    body: h('div', { class: 'shortcut-list' }, ...rows.map(([k, l]) => h('div', { class: 'shortcut' }, h('span', null, l), h('kbd', null, k)))),
    buttons: [{ label: 'Close', primary: true }],
  });
}

export function aboutDialog() {
  dialog({
    title: 'About AMxPixl', width: 420,
    body: [
      h('div', { class: 'about' },
        h('img', { src: 'brand/icon.png', alt: '', width: 64, height: 64 }),
        h('div', null, h('strong', null, 'Pixl Editor'), h('div', { class: 'dim' }, `AMxPixl · version ${__APP_VERSION__}`))),
      h('p', { class: 'dialog-msg' }, 'A lightweight, non-destructive image editor. Layers keep their original pixels, adjustments run on the GPU, and everything stays on this PC.'),
    ],
    buttons: [{ label: 'Close', primary: true }],
  });
}
