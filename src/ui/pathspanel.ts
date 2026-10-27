import { app } from '../app';
import * as A from '../actions';
import { h } from './dom';
import { dialog, icon, numField, seg } from './widgets';

/** Paths panel: the document's Pen paths and what to do with the selected one. */
export function pathsPanel() {
  const el = h('div', { class: 'paths-panel' });
  let sig = '';
  const build = () => {
    const doc = app.doc;
    if (!doc) { el.replaceChildren(h('p', { class: 'empty-note' }, 'No image open')); return; }
    const list = h('div', { class: 'path-list' },
      ...(doc.paths.length ? doc.paths.map((p) => {
        const name = h('span', { class: 'path-name', title: 'Double-click to rename' }, p.name);
        name.addEventListener('dblclick', () => {
          const inp = h('input', { class: 'rename', type: 'text', value: p.name, spellcheck: false });
          const done = (save: boolean) => { if (save && inp.value.trim() && inp.value !== p.name) A.renamePath(p.id, inp.value.trim()); else build(); };
          inp.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') done(true); if (e.key === 'Escape') done(false); });
          inp.addEventListener('blur', () => done(true));
          name.replaceWith(inp); inp.focus(); inp.select();
        });
        return h('div', { class: 'path-row' + (p.id === doc.activePath ? ' active' : ''), onclick: () => A.selectPath(p.id) },
          icon('path'), name, h('span', { class: 'dim' }, `${p.subs.reduce((n, s) => n + s.pts.length, 0)} pts`));
      }) : [h('p', { class: 'empty-note' }, 'Draw a path with the Pen (P), or make one from a selection or shape.')]));
    const has = !!doc.path;
    const btn = (label: string, title: string, fn: () => void, enabled = has) => h('button', { class: 'btn small', type: 'button', title, disabled: !enabled, onclick: fn }, label);
    el.replaceChildren(list,
      h('div', { class: 'btn-row wrap' },
        btn('Fill', 'Fill the path with the foreground colour on the current layer', A.fillPath),
        btn('Stroke…', 'Paint along the path', strokePathDialog),
        btn('To selection', 'Select inside the path (Ctrl+Enter)', () => A.pathToSelection()),
        btn('Text on path', 'Add text that follows the path', A.textOnPath)),
      h('div', { class: 'btn-row wrap' },
        btn('From selection', "Trace the selection's edge into a path", A.selectionToPath, !!doc.selection),
        btn('From shape', 'Turn the selected shape layer into a path', A.shapeToPath, doc.active?.type === 'shape'),
        h('span', { class: 'grow' }),
        h('button', { class: 'icon-btn', type: 'button', title: 'New path', onclick: () => { A.newPath(); app.setTool('pen'); } }, icon('plus')),
        h('button', { class: 'icon-btn', type: 'button', title: 'Delete path', disabled: !has, onclick: () => A.deletePath() }, icon('trash'))));
  };
  const signature = () => {
    const d = app.doc;
    return JSON.stringify([!!d, d?.activePath, d?.paths.map((p) => [p.id, p.name, p.subs.reduce((n, s) => n + s.pts.length, 0)]), !!d?.selection, d?.active?.type]);
  };
  const update = () => { const s = signature(); if (s !== sig) { sig = s; build(); } };
  app.on('docs', update);
  app.on('change', update);
  build();
  return el;
}

/** Edit › Stroke Path: paint along the path with the Brush, or draw a plain line. */
export function strokePathDialog() {
  const doc = app.doc; if (!doc?.path) return;
  let mode: 'brush' | 'line' = 'brush', width = 4;
  const w = numField('Width', width, (v) => { width = v; }, { unit: 'px', min: 0.5, max: 500, decimals: 1 });
  w.hidden = true;
  dialog({
    title: 'Stroke path', width: 400,
    body: [
      h('div', { class: 'field wide' }, h('span', null, 'With'), seg([{ v: 'brush', label: 'Brush' }, { v: 'line', label: 'Line' }], mode, (v) => { mode = v; w.hidden = v !== 'line'; })),
      w,
      h('p', { class: 'dialog-note' }, 'Brush uses the Brush tool\'s current tip, size and settings with the foreground colour. Line draws an even line.'),
    ],
    buttons: [{ label: 'Cancel' }, { label: 'Stroke', primary: true, onClick: () => A.strokePath(mode, width) }],
  });
}
