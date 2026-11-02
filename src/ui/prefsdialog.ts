import { app } from '../app';
import { h } from './dom';
import { ask, checkbox, dialog, icon, seg, toast } from './widgets';

/** One command or tool in Preferences › Shortcuts. */
export interface ShortcutRow {
  /** What the change is kept under in prefs.shortcuts. */
  id: string;
  group: string;
  label: string;
  /** Its shortcut now ('' for none), and its own one. */
  keys: string;
  own: string;
  /** A tool: one key, no Ctrl, Alt or Shift (tools may share a key; pressing it again switches between them). */
  single?: boolean;
  /** Handled by the system (copy, paste): shown, not changeable. */
  fixed?: boolean;
}

/** Keys that do something of their own and can't be given to a tool. */
const RESERVED = new Set(['X', 'D', 'Space', '[', ']']);
const MODIFIER_KEYS = new Set(['Control', 'Shift', 'Alt', 'Meta', 'AltGraph', 'CapsLock']);

/**
 * Edit › Preferences: General (looks, toolbox, crash recovery, layout) and Shortcuts (every menu command and tool,
 * changed by pressing the new keys). Changes apply as they're made.
 */
export function preferencesDialog(rowsNow: () => ShortcutRow[], accelOf: (e: KeyboardEvent) => string) {
  const p = app.prefs;
  const setShortcut = (id: string, keys: string, own: string) => {
    const s = { ...(app.prefs.shortcuts ?? {}) };
    if (keys === own) delete s[id]; else s[id] = keys;
    app.setPrefs({ shortcuts: s });
  };

  // ---------- General ----------
  const row = (label: string, control: HTMLElement) => h('div', { class: 'field wide' }, h('span', null, label), control);
  const general = h('div', { class: 'prefs-pane' },
    h('h3', { class: 'prefs-sub' }, 'Look'),
    row('Theme', seg([{ v: 'dark', label: 'Dark' }, { v: 'light', label: 'Light' }], p.theme, (v) => app.setPrefs({ theme: v }))),
    checkbox('Glow effects on the accent colour', p.glow, (v) => app.setPrefs({ glow: v })),
    h('h3', { class: 'prefs-sub' }, 'Toolbox'),
    checkbox('Show tool names', p.toolLabels, (v) => app.setPrefs({ toolLabels: v })),
    row('Tool options', seg([{ v: 'top', label: 'Bar along the top' }, { v: 'side', label: 'Under the tools' }], p.optionsDock, (v) => app.setPrefs({ optionsDock: v }))),
    h('h3', { class: 'prefs-sub' }, 'Crash recovery'),
    row('Keep a copy of unsaved work', h('select', { onchange: (e: Event) => app.setPrefs({ autosaveMin: Number((e.target as HTMLSelectElement).value) }) },
      ...[[1, 'Every minute'], [2, 'Every 2 minutes'], [5, 'Every 5 minutes'], [10, 'Every 10 minutes'], [0, 'Never']].map(([v, l]) =>
        h('option', { value: v, selected: (p.autosaveMin ?? 1) === v }, String(l))))),
    h('p', { class: 'dialog-note' }, 'If Pixl closes unexpectedly, it offers these copies back the next time it starts. Saving a file clears its copy.'),
    h('h3', { class: 'prefs-sub' }, 'Layout'),
    h('div', { class: 'btn-row' },
      h('button', { class: 'btn small', type: 'button', onclick: () => { app.setPrefs({ panelHeights: {}, toolGridH: undefined }); toast('Panels are back to sizing themselves.'); } }, 'Reset panel sizes'),
      h('button', { class: 'btn small', type: 'button', onclick: () => { app.setPrefs({ toolOrder: undefined }); toast('The tools are back in their first order.'); } }, 'Reset tool order')));

  // ---------- Shortcuts ----------
  const search = h('input', { type: 'search', class: 'prefs-search', placeholder: 'Find a command or tool', spellcheck: false });
  const list = h('div', { class: 'sc-list' });
  let capture: { row: ShortcutRow; btn: HTMLElement } | null = null;
  const stopCapture = () => { window.removeEventListener('keydown', onCapture, true); capture = null; };
  const assign = async (r: ShortcutRow, keys: string) => {
    if (keys && !r.single) {
      // A command's shortcut is one command's only: offer to move it here.
      const other = rowsNow().find((o) => !o.single && o.id !== r.id && o.keys === keys);
      if (other?.fixed) { toast(`${keys} is ${other.group} › ${other.label}, which can't be changed.`); return; }
      if (other) {
        const a = await ask('Shortcut in use', `${keys} is already ${other.group} › ${other.label}. Use it for ${r.group} › ${r.label} instead?`,
          [{ id: 'no', label: 'Cancel' }, { id: 'yes', label: 'Use it here', primary: true }]);
        if (a !== 'yes') return;
        setShortcut(other.id, '', other.own);
      }
    }
    setShortcut(r.id, keys, r.own);
    render();
  };
  function onCapture(e: KeyboardEvent) {
    if (!capture) return;
    e.preventDefault(); e.stopImmediatePropagation();
    if (MODIFIER_KEYS.has(e.key)) return;
    const { row: r } = capture;
    stopCapture();
    if (e.key === 'Escape') { render(); return; }
    if (e.key === 'Backspace' || e.key === 'Delete') { void assign(r, ''); return; }
    const keys = e.code === 'Space' ? 'Space' : accelOf(e);
    const mods = /^(Ctrl|Alt|Shift)\+/.test(keys);
    if (r.single) {
      if (mods) { toast('A tool takes a single key, without Ctrl, Alt or Shift.'); render(); return; }
      if (RESERVED.has(keys)) { toast(`${keys} is kept for ${keys === 'X' ? 'swapping colours' : keys === 'D' ? 'default colours' : keys === 'Space' ? 'panning' : 'brush size'}.`); render(); return; }
      // (Menu commands come first, so a key one of them has wouldn't reach the tool.)
      const cmd = rowsNow().find((o) => !o.single && o.keys === keys);
      if (cmd) { toast(`${keys} is ${cmd.group} › ${cmd.label}. Change that first to give it to a tool.`); render(); return; }
    } else if (!mods && !/^F\d+$/.test(keys)) {
      toast('Use Ctrl, Alt or Shift with it, or a function key: single keys are for tools.'); render(); return;
    }
    void assign(r, keys);
  }
  function render() {
    const q = search.value.trim().toLowerCase();
    const rows = rowsNow().filter((r) => !q || `${r.group} ${r.label} ${r.keys}`.toLowerCase().includes(q));
    const kids: HTMLElement[] = [];
    let group = '';
    for (const r of rows) {
      if (r.group !== group) { group = r.group; kids.push(h('div', { class: 'sc-group' }, group)); }
      const key = h('button', {
        class: 'sc-key' + (r.keys ? '' : ' none'), type: 'button', disabled: r.fixed,
        title: r.fixed ? 'Handled by the system' : 'Click, then press the new keys (Backspace for none, Esc to keep it)',
        onclick: () => {
          if (capture) { stopCapture(); render(); }
          capture = { row: r, btn: key };
          key.textContent = 'Press keys…';
          key.classList.add('capturing');
          window.addEventListener('keydown', onCapture, true);
        },
      }, r.keys || 'None');
      kids.push(h('div', { class: 'sc-row' + (r.keys !== r.own ? ' changed' : '') },
        h('span', { class: 'sc-label' }, r.label),
        key,
        r.keys !== r.own && !r.fixed
          ? h('button', { class: 'icon-btn', type: 'button', title: `Back to ${r.own || 'none'}`, onclick: () => void assign(r, r.own) }, icon('undo'))
          : h('span', { class: 'sc-spacer' })));
    }
    list.replaceChildren(...(kids.length ? kids : [h('p', { class: 'dialog-note' }, 'Nothing matches.')]));
  }
  search.addEventListener('input', render);
  render();
  const shortcuts = h('div', { class: 'prefs-pane' }, search, list,
    h('div', { class: 'btn-row' },
      h('button', { class: 'btn small', type: 'button', onclick: async () => {
        if (!Object.keys(app.prefs.shortcuts ?? {}).length) return;
        const a = await ask('Reset shortcuts', 'Put every shortcut back to how it came?', [{ id: 'no', label: 'Cancel' }, { id: 'yes', label: 'Reset all', primary: true, danger: true }]);
        if (a === 'yes') { app.setPrefs({ shortcuts: {} }); render(); }
      } }, 'Reset all shortcuts')));

  // ---------- the dialog ----------
  const panes = { general, shortcuts };
  const show = (k: keyof typeof panes) => { for (const [n, el] of Object.entries(panes)) el.hidden = n !== k; };
  show('general');
  dialog({
    title: 'Preferences', width: 560,
    body: [seg([{ v: 'general', label: 'General' }, { v: 'shortcuts', label: 'Shortcuts' }], 'general', (v) => show(v as keyof typeof panes)), general, shortcuts],
    onCancel: stopCapture,
    buttons: [{ label: 'Close', primary: true, onClick: () => { stopCapture(); } }],
  });
}
