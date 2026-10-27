import { app } from '../app';
import type { Tool } from '../tools/tool';
import { h } from './dom';
import { icon, popupMenu, type MenuItem } from './widgets';

// ---------- tool options (top bar or sidebar) ----------

const topOptions = h('div', { class: 'opt-body' });
const sideOptions = h('div', { class: 'opt-body side' });
const optionsHost = () => (app.prefs.optionsDock === 'side' ? sideOptions : topOptions);

/** The ⋯ button: where the tool options live. */
function optionsMenuButton() {
  return h('button', {
    class: 'icon-btn opt-more', type: 'button', title: 'Tool options layout',
    onclick: (e: MouseEvent) => {
      const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
      const side = app.prefs.optionsDock === 'side';
      popupMenu([
        { label: 'Show Options in Top Bar', checked: !side, onClick: () => app.setPrefs({ optionsDock: 'top' }) },
        { label: 'Show Options in Sidebar', checked: side, onClick: () => app.setPrefs({ optionsDock: 'side' }) },
      ], r.right, r.bottom + 2);
    },
  }, icon('more'));
}

/** Builds the current tool's options into whichever place they're shown, and keeps them current. */
function mountToolOptions() {
  let lastActive: string | null = null, lastDock = app.prefs.optionsDock;
  const build = () => {
    const t = app.tool, host = optionsHost();
    (host === topOptions ? sideOptions : topOptions).replaceChildren();
    const title = h('span', { class: 'opt-tool' }, icon(t.icon), t.name);
    const box = h('div', { class: 'opt-controls' });
    t.options?.(box);
    if (host === sideOptions) host.replaceChildren(h('div', { class: 'opt-head' }, title, h('span', { class: 'grow' }), optionsMenuButton()), box);
    else host.replaceChildren(title, box);
  };
  app.on('tool', build);
  // Reflect option changes made elsewhere (e.g. [ ] brush size) unless the user is editing a field here.
  app.on('options', () => { if (!optionsHost().contains(document.activeElement)) build(); });
  app.on('colors', () => { if (app.tool.id === 'text') build(); });
  app.on('change', ({ doc }) => {
    if (doc !== app.doc) return;
    if (doc.activeId !== lastActive) { lastActive = doc.activeId; if (app.tool.id === 'text') build(); }
  });
  app.on('prefs', () => { if (app.prefs.optionsDock !== lastDock) { lastDock = app.prefs.optionsDock; build(); } });
  build();
}

export function optionsBar() {
  const el = h('div', { class: 'optionsbar' }, topOptions, optionsMenuButton());
  const sync = () => { el.hidden = app.prefs.optionsDock === 'side'; };
  app.on('prefs', sync);
  sync();
  mountToolOptions();
  return el;
}

// ---------- layout: columns, names, width ----------

const TOOL_GAP = 2, TOOL_PAD = 6, MAX_TOOL_COLS = 6;
/** Room the tool options need when they're shown in the sidebar. */
const SIDE_OPTIONS_W = 212;
const toolCell = () => (app.prefs.toolLabels ? 62 : 34);
const toolboxWidth = (cols: number) => cols * toolCell() + (cols - 1) * TOOL_GAP + TOOL_PAD * 2;
const clampCols = (n: number) => Math.max(1, Math.min(MAX_TOOL_COLS, Math.round(n) || 1));

/**
 * Lays the toolbox out in `cols` columns, sized to fit them. With the tool options in the sidebar it's at least wide
 * enough for them, and the tools spread into as many columns as fit that width.
 */
function layoutToolbox(el: HTMLElement, cols: number) {
  let w = toolboxWidth(cols);
  if (app.prefs.optionsDock === 'side') {
    while (cols < MAX_TOOL_COLS && toolboxWidth(cols + 1) <= SIDE_OPTIONS_W) cols++;
    w = Math.max(toolboxWidth(cols), SIDE_OPTIONS_W);
  }
  document.documentElement.style.setProperty('--toolbox-w', `${w}px`);
  el.style.setProperty('--tool-cols', String(cols));
  el.style.setProperty('--tool-cell', `${toolCell()}px`);
  el.classList.toggle('labels', app.prefs.toolLabels);
}

/** The strip on the toolbox's right edge: drag it wider to lay the tools out in a grid; double-click for one column. */
export function toolboxGrip(box: HTMLElement) {
  const grip = h('div', { class: 'toolbox-grip', title: 'Drag to show the tools in more columns · double-click for one column' });
  grip.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    try { grip.setPointerCapture(e.pointerId); } catch { /* pointer already gone */ }
    grip.classList.add('drag');
    const left = box.getBoundingClientRect().left;
    let cols = app.prefs.toolCols;
    const move = (ev: PointerEvent) => {
      const n = clampCols((ev.clientX - left - TOOL_PAD * 2 + TOOL_GAP) / (toolCell() + TOOL_GAP));
      if (n !== cols) { cols = n; layoutToolbox(box, cols); }
    };
    const up = () => {
      grip.classList.remove('drag');
      grip.removeEventListener('pointermove', move);
      grip.removeEventListener('pointerup', up);
      grip.removeEventListener('pointercancel', up);
      if (cols !== app.prefs.toolCols) app.setPrefs({ toolCols: cols });
    };
    grip.addEventListener('pointermove', move);
    grip.addEventListener('pointerup', up);
    grip.addEventListener('pointercancel', up);
  });
  grip.addEventListener('dblclick', () => app.setPrefs({ toolCols: 1 }));
  return grip;
}

// ---------- tool groups ----------

const toolById = (id: string) => app.tools.find((t) => t.id === id);
const toolIndex = (id: string) => app.tools.findIndex((t) => t.id === id);

/** The saved groups, cleaned up: known tools only, each in one group, in toolbox order, two or more per group. */
function toolGroups(): string[][] {
  const seen = new Set<string>();
  return (app.prefs.toolGroups ?? [])
    .map((g) => g.filter((id) => toolById(id) && !seen.has(id) && !!seen.add(id)).sort((a, b) => toolIndex(a) - toolIndex(b)))
    .filter((g) => g.length > 1);
}
const saveGroups = (groups: string[][]) => app.setPrefs({ toolGroups: groups.filter((g) => g.length > 1) });
const groupWith = (id: string, groups = toolGroups()) => groups.find((g) => g.includes(id));

/** Tools sharing a shortcut key go together (rectangle/ellipse select, dodge/burn, blur/sharpen/smudge...). */
function groupByKey() {
  const byKey = new Map<string, string[]>();
  for (const t of app.tools) byKey.set(t.key, [...(byKey.get(t.key) ?? []), t.id]);
  saveGroups([...byKey.values()]);
}

/** Most recently used first; a group shows the last of its tools that was used. */
const recent: string[] = [];
const frontOf = (g: string[]) => (g.includes(app.tool.id) ? app.tool.id : recent.find((id) => g.includes(id)) ?? g[0]);

function generalItems(): MenuItem[] {
  return [
    { label: 'Group Tools by Shortcut Key', onClick: groupByKey },
    { label: 'Ungroup All Tools', disabled: !toolGroups().length, onClick: () => saveGroups([]) },
    { sep: true },
    { label: 'Show Tool Names', checked: app.prefs.toolLabels, onClick: () => app.setPrefs({ toolLabels: !app.prefs.toolLabels }) },
    { label: 'One Column', disabled: app.prefs.toolCols === 1, onClick: () => app.setPrefs({ toolCols: 1 }) },
  ];
}

/** Right-click menu for a toolbox slot: a group lists its tools; any tool can start a group or join one. */
function toolMenu(t: Tool): MenuItem[] {
  const groups = toolGroups();
  const name = (id: string) => toolById(id)!.name;
  const g = groupWith(t.id, groups);
  if (g) {
    const others = app.tools.filter((x) => !g.includes(x.id));
    return [
      ...g.map((id) => ({ label: name(id), accel: toolById(id)!.key, checked: app.tool.id === id, onClick: () => app.setTool(id) })),
      { sep: true },
      { label: 'Add Tool to This Group', sub: others.map((x) => ({
        label: x.name, onClick: () => saveGroups(groups.map((gg) => (gg === g ? [...gg, x.id] : gg.filter((id) => id !== x.id)))),
      })) },
      { label: `Take ${t.name} Out of Group`, onClick: () => saveGroups(groups.map((gg) => (gg === g ? gg.filter((id) => id !== t.id) : gg))) },
      { label: 'Ungroup', onClick: () => saveGroups(groups.filter((gg) => gg !== g)) },
      { sep: true },
      ...generalItems(),
    ];
  }
  const loose = app.tools.filter((x) => x !== t && !groupWith(x.id, groups));
  return [
    { label: 'New Group With', sub: loose.length ? loose.map((x) => ({ label: x.name, onClick: () => saveGroups([...groups, [t.id, x.id]]) })) : [{ label: 'Every other tool is in a group', disabled: true }] },
    { label: 'Add to Group', sub: groups.length ? groups.map((gg) => ({ label: gg.map(name).join(' / '), onClick: () => saveGroups(groups.map((x) => (x === gg ? [...x, t.id] : x))) })) : [{ label: 'No groups yet', disabled: true }] },
    { sep: true },
    ...generalItems(),
  ];
}

function toolButton(t: Tool, group: string[] | undefined) {
  const on = group ? group.includes(app.tool.id) : t === app.tool;
  const more = group ? ` · right-click or hold for ${group.length - 1} more` : '';
  const b = h('button', {
    class: 'tool' + (group ? ' grouped' : '') + (on ? ' on' : ''), type: 'button', title: `${t.name} (${t.key})${more}`, 'aria-label': t.name,
    onclick: () => app.setTool(t.id),
  }, icon(t.icon), h('span', { class: 'tool-name' }, t.name));
  const openMenu = (x: number, y: number) => popupMenu(toolMenu(t), x, y);
  b.addEventListener('contextmenu', (e) => { e.preventDefault(); e.stopPropagation(); openMenu(e.clientX, e.clientY); });
  if (group) {
    // Press and hold a group to pick one of its tools, like Photoshop's flyouts.
    let timer = 0;
    const cancel = () => { clearTimeout(timer); timer = 0; };
    b.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      timer = window.setTimeout(() => { timer = 0; const r = b.getBoundingClientRect(); openMenu(r.right + 2, r.top); }, 400);
    });
    b.addEventListener('pointerup', cancel);
    b.addEventListener('pointerleave', cancel);
  }
  return b;
}

// ---------- the toolbox ----------

export function toolbox() {
  const el = h('nav', { class: 'toolbox', 'aria-label': 'Tools' });
  const grid = h('div', { class: 'tool-grid' });
  const render = () => {
    const groups = toolGroups();
    const shown = new Set<string[]>();
    const cells: HTMLElement[] = [];
    for (const t of app.tools) {
      const g = groupWith(t.id, groups);
      if (!g) { cells.push(toolButton(t, undefined)); continue; }
      if (shown.has(g)) continue;
      shown.add(g);
      cells.push(toolButton(toolById(frontOf(g))!, g));
    }
    grid.replaceChildren(...cells);
  };
  el.addEventListener('contextmenu', (e) => { e.preventDefault(); popupMenu(generalItems(), e.clientX, e.clientY); });
  const side = h('section', { class: 'side-options' }, sideOptions);
  const relayout = () => { side.hidden = app.prefs.optionsDock !== 'side'; layoutToolbox(el, clampCols(app.prefs.toolCols)); render(); };
  app.on('prefs', relayout);
  app.on('tool', () => { recent.splice(0, recent.length, app.tool.id, ...recent.filter((id) => id !== app.tool.id)); render(); });
  relayout();
  const fg = h('button', { class: 'sw fg', type: 'button', title: 'Foreground colour' });
  const bg = h('button', { class: 'sw bg', type: 'button', title: 'Background colour' });
  const syncColors = () => { fg.style.background = app.fg; bg.style.background = app.bg; };
  const showColor = () => { if (!app.prefs.dock.color) { app.prefs.dock.color = true; app.setPrefs({}); } };
  fg.addEventListener('click', showColor);
  bg.addEventListener('click', showColor);
  app.on('colors', syncColors);
  syncColors();
  el.append(grid, side, h('div', { class: 'grow' }),
    h('div', { class: 'swatch-stack' }, bg, fg),
    h('div', { class: 'swatch-btns' },
      h('button', { class: 'mini', type: 'button', title: 'Default colours (D)', onclick: () => { app.setColor('fg', '#000000'); app.setColor('bg', '#ffffff'); } }, icon('resetColors')),
      h('button', { class: 'mini', type: 'button', title: 'Swap colours (X)', onclick: () => { const f = app.fg; app.setColor('fg', app.bg); app.setColor('bg', f); } }, icon('swap'))));
  return el;
}
