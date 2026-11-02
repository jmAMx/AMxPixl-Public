import { app } from '../app';
import type { FxParam, FxValue } from '../core/effects';
import { h } from './dom';
import { checkbox, seg, slider } from './widgets';

/** A colour well with a button to take the foreground colour. */
export function colorInput(value: string, onInput: (v: string) => void, onDone: () => void) {
  const inp = h('input', { type: 'color', value, class: 'color-input' });
  inp.addEventListener('input', () => onInput(inp.value));
  inp.addEventListener('change', onDone);
  return h('span', { class: 'color-pair' }, inp,
    h('button', { class: 'btn small', type: 'button', title: 'Use the foreground colour', onclick: () => { inp.value = app.fg; onInput(app.fg); onDone(); } }, 'Use FG'));
}

/**
 * The control for one effect setting (Properties panel, filter dialog). `set` gets each change, with `final` once the
 * change is finished (a slider let go); `done` is called when a slider or colour is let go.
 */
export function fxParamControl(p: FxParam, cur: FxValue, set: (key: string, v: FxValue, final: boolean) => void, done: () => void): HTMLElement {
  switch (p.type) {
    case 'range': return slider({ label: p.label, min: p.min, max: p.max, step: p.step ?? 1, value: Number(cur), unit: p.unit, onInput: (v) => set(p.key, v, false), onChange: done });
    case 'bool': return checkbox(p.label, !!cur, (v) => set(p.key, v, true));
    case 'color': return h('div', { class: 'prop-line' }, h('span', { class: 'dim' }, p.label), colorInput(String(cur), (v) => set(p.key, v, false), done));
    case 'select': return h('label', { class: 'field wide' }, h('span', null, p.label),
      p.options.length <= 3 ? seg(p.options.map(([v, lab]) => ({ v, label: lab })), String(cur), (v) => set(p.key, v, true))
        : h('select', { onchange: (ev: Event) => set(p.key, (ev.target as HTMLSelectElement).value, true) }, ...p.options.map(([v, lab]) => h('option', { value: v, selected: v === cur }, lab))));
  }
}
