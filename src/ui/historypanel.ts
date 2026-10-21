import { app } from '../app';
import { h } from './dom';

export function historyPanel() {
  const list = h('div', { class: 'history-list', role: 'listbox', 'aria-label': 'History' });
  const build = () => {
    const doc = app.doc;
    if (!doc) { list.replaceChildren(h('div', { class: 'empty-note' }, 'No image open')); return; }
    list.replaceChildren(...doc.entries.map((e, i) => h('button', {
      type: 'button',
      class: 'history-row' + (i === doc.index - 1 ? ' current' : '') + (i >= doc.index ? ' undone' : ''),
      onclick: () => doc.goTo(i + 1),
    }, e.label)));
    list.querySelector('.current')?.scrollIntoView({ block: 'nearest' });
  };
  app.on('docs', build);
  app.on('change', ({ doc, kind }) => { if (doc === app.doc && kind === 'history') build(); });
  build();
  return list;
}
