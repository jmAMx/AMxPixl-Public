import { app } from '../app';
import { deleteLayer, duplicateLayer, mergeDown, moveLayer, newAdjustment, newLayer, setLayerProp } from '../actions';
import { ADJ_LABELS, ADJ_ORDER } from '../core/adjustments';
import { renderDoc } from '../core/render';
import { BLEND_MODES, type BlendMode, type Layer } from '../core/types';
import { h } from './dom';
import type { IconName } from './icons';
import { icon, popupMenu, slider } from './widgets';

const THUMB = 40;

export function adjustmentMenu(x: number, y: number) {
  popupMenu(ADJ_ORDER.map((k) => ({ label: ADJ_LABELS[k], onClick: () => newAdjustment(k) })), x, y);
}

export function layersPanel() {
  const blend = h('select', { class: 'blend', title: 'Blend mode', onchange: () => { const id = app.doc?.activeId; if (id) setLayerProp(id, { blend: blend.value as BlendMode }, 'Blend mode'); } },
    ...BLEND_MODES.map(([v, l]) => h('option', { value: v }, l)));
  const opacity = slider({
    label: 'Opacity', min: 0, max: 1, display: 100, value: 1, unit: '%', compact: true,
    onInput: (v) => { const id = app.doc?.activeId; if (id) setLayerProp(id, { opacity: v }); },
    onChange: () => app.doc?.commit('Opacity'),
  });
  const list = h('div', { class: 'layer-list', role: 'listbox', 'aria-label': 'Layers' });
  const btn = (ic: IconName, title: string, fn: (e: MouseEvent) => void) => h('button', { class: 'icon-btn', type: 'button', title, 'aria-label': title, onclick: fn }, icon(ic));
  const foot = h('div', { class: 'panel-foot' },
    btn('newLayer', 'New layer (Ctrl+Shift+N)', () => newLayer()),
    btn('adjust', 'New adjustment layer', (e) => { const r = (e.currentTarget as HTMLElement).getBoundingClientRect(); adjustmentMenu(r.left, r.top); }),
    btn('duplicate', 'Duplicate layer (Ctrl+J)', () => duplicateLayer()),
    btn('merge', 'Merge down (Ctrl+E)', () => mergeDown()),
    h('span', { class: 'grow' }),
    btn('trash', 'Delete layer', () => deleteLayer()),
  );
  const el = h('div', { class: 'layers-panel' }, h('div', { class: 'layer-props' }, blend, opacity), list, foot);

  const thumbs = new Map<string, HTMLCanvasElement>();
  let sig = '';
  let thumbTimer = 0;
  let dragId: string | null = null;

  const drawThumb = (l: Layer, c: HTMLCanvasElement) => {
    const doc = app.doc!;
    if (l.type === 'adjust') return;
    const s = Math.min(c.width / doc.width, c.height / doc.height);
    renderDoc(doc, c, [s, 0, 0, s, (c.width - doc.width * s) / 2, (c.height - doc.height * s) / 2], { layers: [{ ...l, visible: true, opacity: 1, blend: 'normal' }], includeHidden: true });
  };

  const refreshThumbs = () => {
    const doc = app.doc;
    if (!doc) return;
    for (const l of doc.layers) { const c = thumbs.get(l.id); if (c) drawThumb(l, c); }
  };

  const typeIcon = (l: Layer): IconName | null => (l.type === 'text' ? 'text' : l.type === 'shape' ? 'shape' : l.type === 'adjust' ? 'adjust' : null);

  const build = () => {
    const doc = app.doc;
    el.classList.toggle('disabled', !doc);
    thumbs.clear();
    if (!doc) { list.replaceChildren(h('div', { class: 'empty-note' }, 'No image open')); return; }
    const rows = [...doc.layers].reverse().map((l) => {
      const thumb = h('canvas', { class: 'thumb', width: THUMB * 2, height: THUMB * 2 });
      if (l.type !== 'adjust') { thumbs.set(l.id, thumb); drawThumb(l, thumb); }
      const ti = typeIcon(l);
      const name = h('span', { class: 'layer-name', title: 'Double-click to rename' }, l.name);
      name.addEventListener('dblclick', () => {
        const inp = h('input', { class: 'rename', type: 'text', value: l.name, spellcheck: false });
        const done = (save: boolean) => { if (save && inp.value.trim() && inp.value !== l.name) setLayerProp(l.id, { name: inp.value.trim() }, 'Rename layer'); else build(); };
        inp.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') done(true); if (e.key === 'Escape') done(false); });
        inp.addEventListener('blur', () => done(true));
        name.replaceWith(inp);
        inp.focus(); inp.select();
      });
      const row = h('div', {
        class: 'layer-row' + (l.id === doc.activeId ? ' active' : '') + (l.visible ? '' : ' hidden-layer'),
        role: 'option', 'aria-selected': String(l.id === doc.activeId), draggable: true,
        onclick: () => { if (doc.activeId !== l.id) { doc.activeId = l.id; doc.touch('meta'); } },
      },
      h('button', {
        class: 'eye', type: 'button', title: l.visible ? 'Hide layer' : 'Show layer', 'aria-label': 'Toggle visibility',
        onclick: (e: MouseEvent) => { e.stopPropagation(); setLayerProp(l.id, { visible: !l.visible }, l.visible ? 'Hide layer' : 'Show layer'); },
      }, icon(l.visible ? 'eye' : 'eyeOff')),
      l.type === 'adjust' ? h('span', { class: 'thumb adj-thumb' }, icon('adjust')) : thumb,
      name,
      ti ? h('span', { class: 'layer-type', title: l.type }, icon(ti)) : null,
      l.blend !== 'normal' || l.opacity < 1 ? h('span', { class: 'layer-badge' }, l.opacity < 1 ? `${Math.round(l.opacity * 100)}%` : '', l.blend !== 'normal' ? ' fx' : '') : null);
      row.addEventListener('dragstart', (e) => { dragId = l.id; e.dataTransfer!.effectAllowed = 'move'; e.dataTransfer!.setData('text/x-layer', l.id); row.classList.add('dragging'); });
      row.addEventListener('dragend', () => { dragId = null; row.classList.remove('dragging'); list.querySelectorAll('.drop-above,.drop-below').forEach((n) => n.classList.remove('drop-above', 'drop-below')); });
      row.addEventListener('dragover', (e) => {
        if (!dragId) return;
        e.preventDefault();
        const r = row.getBoundingClientRect();
        const above = e.clientY < r.top + r.height / 2;
        row.classList.toggle('drop-above', above);
        row.classList.toggle('drop-below', !above);
      });
      row.addEventListener('dragleave', () => row.classList.remove('drop-above', 'drop-below'));
      row.addEventListener('drop', (e) => {
        if (!dragId || dragId === l.id) return;
        e.preventDefault();
        const r = row.getBoundingClientRect();
        const above = e.clientY < r.top + r.height / 2;
        const from = doc.indexOf(dragId);
        let to = doc.indexOf(l.id) + (above ? 1 : 0);
        if (from < to) to--;
        moveLayer(dragId, to);
      });
      return row;
    });
    list.replaceChildren(...rows);
    const a = doc.active;
    blend.disabled = !a || a.type === 'adjust';
    blend.value = a?.blend ?? 'normal';
    opacity.setValue(a?.opacity ?? 1);
  };

  const signature = () => {
    const d = app.doc;
    return d ? JSON.stringify([d.activeId, d.layers.map((l) => [l.id, l.name, l.visible, l.opacity, l.blend, l.type])]) : '';
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
