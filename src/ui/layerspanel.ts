import { app } from '../app';
import {
  addMask, applyLook, applyMask, clearStyles, deleteLayer, deleteMask, duplicateLayer, groupLayer, invertMask, lookSourceLayers, mergeDown,
  moveLayer, newAdjustment, newEffect, newGroup, newLayer, newLut, rasterizeLayer, selectLayerShape, setLayerProp, setMaskProp, toggleClip, ungroup,
} from '../actions';
import { BUILTIN_LOOKS, savedLooks } from '../core/looks';
import { hasStyles } from '../core/styles';
import { manageLooksDialog, saveLookDialog } from './dialogs';
import { ADJ_LABELS, ADJ_ORDER } from '../core/adjustments';

import { FX_DEFS, FX_GROUPS } from '../core/effects';
import { ctx2d } from '../core/layers';
import { mul, setT, xformMatrix, type Mat } from '../core/math';
import { renderDoc } from '../core/render';
import { BLEND_MODES, isFilter, isPlaced, type BlendMode, type Layer } from '../core/types';
import { h } from './dom';
import type { IconName } from './icons';
import { icon, popupMenu, slider, type MenuItem } from './widgets';

const THUMB = 40;

export const adjustmentMenuItems = (): MenuItem[] => ADJ_ORDER.map((k) => ({
  label: k === 'lut' ? `${ADJ_LABELS[k]}…` : ADJ_LABELS[k], disabled: !app.doc, onClick: () => (k === 'lut' ? newLut() : newAdjustment(k)),
}));

export function adjustmentMenu(x: number, y: number) { popupMenu(adjustmentMenuItems(), x, y); }

export const effectMenuItems = (): MenuItem[] => FX_GROUPS.map((g) => ({
  label: g, sub: FX_DEFS.filter((d) => d.group === g).map((d) => ({ label: d.label, disabled: !app.doc, onClick: () => newEffect(d.kind) })),
}));

/** Built-in and saved looks, plus saving the current effect stack as a new one. */
export function looksMenuItems(): MenuItem[] {
  const mine = savedLooks();
  return [
    ...BUILTIN_LOOKS.map((l) => ({ label: l.name, disabled: !app.doc, onClick: () => { applyLook(l); } })),
    ...(mine.length ? [{ sep: true } as MenuItem, ...mine.map((l) => ({ label: l.name, disabled: !app.doc, onClick: () => { applyLook(l); } }))] : []),
    { sep: true },
    { label: 'Save Current Effects as Look…', disabled: !lookSourceLayers().length, onClick: saveLookDialog },
    { label: 'Manage Looks…', onClick: manageLooksDialog },
  ];
}

export function effectMenu(x: number, y: number) { popupMenu([{ label: 'Looks', sub: looksMenuItems() }, { sep: true }, ...effectMenuItems()], x, y); }

export function maskMenuItems(): MenuItem[] {
  const l = app.doc?.active;
  if (!l) return [];
  if (!l.mask) {
    return [
      { label: 'Add Mask: Reveal All', onClick: () => addMask('reveal') },
      { label: 'Add Mask: Hide All', onClick: () => addMask('hide') },
      { label: 'Add Mask from Selection', disabled: !app.doc?.selection, onClick: () => addMask('selection') },
    ];
  }
  return [
    { label: l.mask.enabled ? 'Disable Mask' : 'Enable Mask', onClick: () => setMaskProp({ enabled: !l.mask!.enabled }, l.mask!.enabled ? 'Disable mask' : 'Enable mask') },
    { label: 'Invert Mask', onClick: invertMask },
    { label: 'Apply Mask', disabled: l.type !== 'raster', onClick: applyMask },
    { label: 'Delete Mask', onClick: deleteMask },
  ];
}

function layerContextMenu(l: Layer, x: number, y: number) {
  const doc = app.doc!;
  const at = doc.locate(l.id);
  popupMenu([
    { label: 'Duplicate Layer', accel: 'Ctrl+J', onClick: duplicateLayer },
    { label: 'Delete Layer', onClick: () => deleteLayer() },
    { sep: true },
    { label: l.clip ? 'Release Clipping Mask' : 'Create Clipping Mask', accel: 'Ctrl+Alt+G', disabled: !l.clip && !at?.index, onClick: toggleClip },
    ...maskMenuItems(),
    { sep: true },
    { label: 'Group Layer', accel: 'Ctrl+G', onClick: groupLayer },
    { label: 'Ungroup', accel: 'Ctrl+Shift+G', disabled: l.type !== 'group' && !at?.parent, onClick: ungroup },
    { sep: true },
    { label: 'Merge Down', accel: 'Ctrl+E', disabled: !at?.index, onClick: mergeDown },
    { label: l.type === 'group' ? 'Merge Group' : 'Rasterize', disabled: l.type === 'raster' || isFilter(l), onClick: rasterizeLayer },
    { label: 'Clear Layer Style', disabled: !l.styles, onClick: clearStyles },
    { sep: true },
    { label: 'Save Effects as Look…', disabled: !lookSourceLayers().length, onClick: saveLookDialog },
  ], x, y);
}

/** The mask as a white-on-black thumbnail. */
function drawMaskThumb(l: Layer, c: HTMLCanvasElement) {
  const doc = app.doc!;
  const m = l.mask!;
  const src = doc.pool.get(m.key);
  const x = ctx2d(c);
  x.setTransform(1, 0, 0, 1, 0, 0);
  x.fillStyle = '#000';
  x.fillRect(0, 0, c.width, c.height);
  if (!src) return;
  const s = Math.min(c.width / doc.width, c.height / doc.height);
  const v: Mat = [s, 0, 0, s, (c.width - doc.width * s) / 2, (c.height - doc.height * s) / 2];
  x.save();
  setT(x, mul(v, xformMatrix(m.t)));
  x.imageSmoothingQuality = 'high';
  x.drawImage(src, 0, 0);
  x.restore();
  if (!m.enabled) {
    x.strokeStyle = '#e5484d';
    x.lineWidth = 6;
    x.beginPath(); x.moveTo(8, 8); x.lineTo(c.width - 8, c.height - 8); x.moveTo(c.width - 8, 8); x.lineTo(8, c.height - 8); x.stroke();
  }
}

export function layersPanel() {
  const blend = h('select', { class: 'blend', title: 'Blend mode', onchange: () => { const id = app.doc?.activeId; if (id) setLayerProp(id, { blend: blend.value as BlendMode }, 'Blend mode'); } });
  const opacity = slider({
    label: 'Opacity', min: 0, max: 1, display: 100, value: 1, unit: '%', compact: true,
    onInput: (v) => { const id = app.doc?.activeId; if (id) setLayerProp(id, { opacity: v }); },
    onChange: () => app.doc?.commit('Opacity'),
  });
  const list = h('div', { class: 'layer-list', role: 'tree', 'aria-label': 'Layers' });
  const btn = (ic: IconName, title: string, fn: (e: MouseEvent) => void) => h('button', { class: 'icon-btn', type: 'button', title, 'aria-label': title, onclick: fn }, icon(ic));
  const at = (e: MouseEvent) => (e.currentTarget as HTMLElement).getBoundingClientRect();
  const foot = h('div', { class: 'panel-foot' },
    btn('newLayer', 'New layer (Ctrl+Shift+N)', () => newLayer()),
    btn('group', 'New group', () => newGroup()),
    btn('mask', 'Add layer mask (from the selection if there is one)', (e) => { if (app.doc?.active?.mask) { const r = at(e); popupMenu(maskMenuItems(), r.left, r.top); } else addMask(); }),
    btn('adjust', 'New adjustment layer', (e) => { const r = at(e); adjustmentMenu(r.left, r.top); }),
    btn('fx', 'New effect layer (film, lens, CRT…)', (e) => { const r = at(e); effectMenu(r.left, r.top); }),
    btn('duplicate', 'Duplicate layer (Ctrl+J)', () => duplicateLayer()),
    btn('merge', 'Merge down (Ctrl+E)', () => mergeDown()),
    h('span', { class: 'grow' }),
    btn('trash', 'Delete layer', () => deleteLayer()),
  );
  const el = h('div', { class: 'layers-panel' }, h('div', { class: 'layer-props' }, blend, opacity), list, foot);

  const thumbs = new Map<string, { c: HTMLCanvasElement; mask: boolean }[]>();
  let sig = '';
  let thumbTimer = 0;
  let dragId: string | null = null;

  const drawThumb = (l: Layer, c: HTMLCanvasElement) => {
    const doc = app.doc!;
    if (!isPlaced(l)) return;
    const s = Math.min(c.width / doc.width, c.height / doc.height);
    renderDoc(doc, c, [s, 0, 0, s, (c.width - doc.width * s) / 2, (c.height - doc.height * s) / 2], { layers: [{ ...l, visible: true, opacity: 1, blend: 'normal', mask: null, clip: false }], includeHidden: true });
  };

  const refreshThumbs = () => {
    const doc = app.doc;
    if (!doc) return;
    for (const l of doc.all()) for (const t of thumbs.get(l.id) ?? []) t.mask ? drawMaskThumb(l, t.c) : drawThumb(l, t.c);
  };

  const typeIcon = (l: Layer): IconName | null => (l.type === 'text' ? 'text' : l.type === 'shape' ? 'shape' : null);

  const row = (l: Layer, depth: number): HTMLElement[] => {
    const doc = app.doc!;
    const isActive = l.id === doc.activeId;
    const t: { c: HTMLCanvasElement; mask: boolean }[] = [];
    thumbs.set(l.id, t);

    let main: HTMLElement;
    if (isPlaced(l)) {
      const c = h('canvas', { class: 'thumb', width: THUMB * 2, height: THUMB * 2 });
      drawThumb(l, c);
      t.push({ c, mask: false });
      main = c;
    } else {
      main = h('span', { class: `thumb icon-thumb ${l.type}-thumb` }, icon(l.type === 'group' ? 'group' : l.type === 'effect' ? 'fx' : 'adjust'));
    }
    main.classList.toggle('target', isActive && !doc.maskEdit);
    main.title = l.type === 'adjust' || l.type === 'effect' ? 'Edit layer' : 'Edit layer (Ctrl+click to select its shape)';
    main.addEventListener('click', (e) => {
      e.stopPropagation();
      if (e.ctrlKey || e.metaKey) { selectLayerShape(l.id, e.shiftKey ? 'add' : e.altKey ? 'sub' : 'replace'); return; }
      doc.setActive(l.id, false); doc.touch('meta');
    });

    let maskEl: HTMLElement | null = null;
    if (l.mask) {
      const c = h('canvas', { class: 'thumb mask-thumb' + (isActive && doc.maskEdit ? ' target' : ''), width: THUMB * 2, height: THUMB * 2, title: 'Edit mask (Shift+click to turn it on/off)' });
      drawMaskThumb(l, c);
      t.push({ c, mask: true });
      c.addEventListener('click', (e) => {
        e.stopPropagation();
        if (e.shiftKey) { setMaskProp({ enabled: !l.mask!.enabled }, l.mask!.enabled ? 'Disable mask' : 'Enable mask'); return; }
        doc.setActive(l.id, true);
        doc.touch('meta');
      });
      maskEl = c;
    }

    const name = h('span', { class: 'layer-name', title: 'Double-click to rename' }, l.name);
    name.addEventListener('dblclick', () => {
      const inp = h('input', { class: 'rename', type: 'text', value: l.name, spellcheck: false });
      const done = (save: boolean) => { if (save && inp.value.trim() && inp.value !== l.name) setLayerProp(l.id, { name: inp.value.trim() }, 'Rename layer'); else build(); };
      inp.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') done(true); if (e.key === 'Escape') done(false); });
      inp.addEventListener('blur', () => done(true));
      name.replaceWith(inp);
      inp.focus(); inp.select();
    });

    const ti = typeIcon(l);
    const chevron = l.type === 'group'
      ? h('button', { class: 'chev-btn', type: 'button', title: l.open ? 'Collapse' : 'Expand', onclick: (e: MouseEvent) => { e.stopPropagation(); l.open = !l.open; build(); } }, icon(l.open ? 'chevron' : 'chevronR'))
      : h('span', { class: 'chev-space' });

    const r = h('div', {
      class: 'layer-row' + (isActive ? ' active' : '') + (l.visible ? '' : ' hidden-layer') + (l.clip ? ' clipped' : '') + (l.type === 'group' ? ' group-row' : ''),
      role: 'treeitem', 'aria-selected': String(isActive), draggable: true, style: `padding-left:${2 + depth * 14}px`,
      onclick: () => { if (doc.activeId !== l.id) { doc.setActive(l.id, false); doc.touch('meta'); } },
    },
    h('button', {
      class: 'eye', type: 'button', title: l.visible ? 'Hide layer' : 'Show layer', 'aria-label': 'Toggle visibility',
      onclick: (e: MouseEvent) => { e.stopPropagation(); setLayerProp(l.id, { visible: !l.visible }, l.visible ? 'Hide layer' : 'Show layer'); },
    }, icon(l.visible ? 'eye' : 'eyeOff')),
    chevron,
    l.clip ? h('span', { class: 'clip-arrow', title: 'Clipped to the layer below' }, icon('clip')) : null,
    main, maskEl, name,
    ti ? h('span', { class: 'layer-type', title: l.type }, icon(ti)) : null,
    hasStyles(l.styles) ? h('span', { class: 'layer-fx', title: 'Has layer styles' }, 'fx') : null,
    l.blendIf?.on ? h('span', { class: 'layer-fx', title: 'Blend If is on' }, 'BI') : null,
    l.type === 'raster' && l.warp ? h('span', { class: 'layer-type', title: 'Warped (lossless)' }, icon('warp')) : null,
    l.blend !== 'normal' && l.blend !== 'pass-through' || l.opacity < 1 ? h('span', { class: 'layer-badge' }, l.opacity < 1 ? `${Math.round(l.opacity * 100)}%` : '', l.blend !== 'normal' && l.blend !== 'pass-through' ? ' fx' : '') : null);

    r.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (doc.activeId !== l.id) { doc.setActive(l.id, false); doc.touch('meta'); }
      layerContextMenu(l, e.clientX, e.clientY);
    });

    // Drag to reorder: top/bottom of a row drops above/below it; the middle of a group row drops inside.
    const zone = (e: DragEvent) => {
      const b = r.getBoundingClientRect();
      const f = (e.clientY - b.top) / b.height;
      return l.type === 'group' && f > 0.28 && f < 0.72 ? 'into' : f < 0.5 ? 'above' : 'below';
    };
    r.addEventListener('dragstart', (e) => { dragId = l.id; e.dataTransfer!.effectAllowed = 'move'; e.dataTransfer!.setData('text/x-layer', l.id); r.classList.add('dragging'); });
    r.addEventListener('dragend', () => { dragId = null; r.classList.remove('dragging'); list.querySelectorAll('.drop-above,.drop-below,.drop-into').forEach((n) => n.classList.remove('drop-above', 'drop-below', 'drop-into')); });
    r.addEventListener('dragover', (e) => {
      if (!dragId || dragId === l.id) return;
      e.preventDefault();
      const z = zone(e);
      r.classList.toggle('drop-above', z === 'above');
      r.classList.toggle('drop-below', z === 'below');
      r.classList.toggle('drop-into', z === 'into');
    });
    r.addEventListener('dragleave', () => r.classList.remove('drop-above', 'drop-below', 'drop-into'));
    r.addEventListener('drop', (e) => {
      if (!dragId || dragId === l.id) return;
      e.preventDefault();
      const z = zone(e);
      if (z === 'into' && l.type === 'group') { l.open = true; moveLayer(dragId, l.children, l.children.length); return; }
      const loc = doc.locate(l.id)!;
      moveLayer(dragId, loc.list, loc.index + (z === 'above' ? 1 : 0));
    });

    const out: HTMLElement[] = [r];
    if (l.type === 'group' && l.open) {
      const kids = [...l.children].reverse().flatMap((c) => row(c, depth + 1));
      out.push(...(kids.length ? kids : [h('div', { class: 'layer-empty', style: `padding-left:${40 + (depth + 1) * 14}px` }, 'Empty group: drag layers here')]));
    }
    return out;
  };

  const build = () => {
    const doc = app.doc;
    el.classList.toggle('disabled', !doc);
    thumbs.clear();
    if (!doc) { list.replaceChildren(h('div', { class: 'empty-note' }, 'No image open')); return; }
    list.replaceChildren(...[...doc.layers].reverse().flatMap((l) => row(l, 0)));
    const a = doc.active;
    blend.replaceChildren(...[
      ...(a?.type === 'group' ? [h('option', { value: 'pass-through' }, 'Pass Through')] : []),
      ...BLEND_MODES.map(([v, label]) => h('option', { value: v }, label)),
    ]);
    blend.disabled = !a || isFilter(a);
    blend.value = a?.blend ?? 'normal';
    opacity.setValue(a?.opacity ?? 1);
  };

  const signature = () => {
    const d = app.doc;
    if (!d) return '';
    const s = (ls: Layer[]): unknown => ls.map((l) => [l.id, l.name, l.visible, l.opacity, l.blend, l.type, !!l.clip, l.mask ? [l.mask.key, l.mask.enabled] : 0,
      hasStyles(l.styles), !!l.blendIf?.on, l.type === 'raster' && !!l.warp, l.type === 'group' ? [l.open, s(l.children)] : 0]);
    return JSON.stringify([d.activeId, d.maskEdit, s(d.layers)]);
  };

  const update = (kind: string) => {
    const s = signature();
    if (s !== sig || kind === 'docs') { sig = s; build(); return; }
    clearTimeout(thumbTimer);
    thumbTimer = window.setTimeout(refreshThumbs, kind === 'pixels' ? 350 : 120);
  };

  app.on('docs', () => update('docs'));
  app.on('change', ({ doc, kind }) => { if (doc === app.doc) update(kind); });
  build();
  return el;
}
