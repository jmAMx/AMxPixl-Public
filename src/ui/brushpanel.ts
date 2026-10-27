import { app } from '../app';
import { pickFiles } from '../core/fileio';
import { ctx2d, newCanvas } from '../core/layers';
import { setSetting } from '../core/settings';
import { addCustomTip, getTip, listTips, removeCustomTip } from '../core/tips';
import { h } from './dom';
import { dialog, slider, toast } from './widgets';

/**
 * Brush settings (brush and eraser): tip shape, spacing, angle jitter and scatter, plus presets that save the whole
 * set (size, hardness, opacity, flow and the above) under a name.
 */

type BrushOpts = typeof app.opts.brush;
export interface BrushPreset { name: string; size: number; hardness: number; opacity: number; flow: number; tip: string; spacing: number; jitter: number; scatter: number }

const PRESETS_KEY = 'amxpixl.brushPresets';

export const BUILTIN_PRESETS: BrushPreset[] = [
  { name: 'Soft round', size: 40, hardness: 0.2, opacity: 1, flow: 1, tip: 'round', spacing: 12, jitter: 0, scatter: 0 },
  { name: 'Hard round', size: 16, hardness: 0.95, opacity: 1, flow: 1, tip: 'round', spacing: 10, jitter: 0, scatter: 0 },
  { name: 'Airbrush', size: 80, hardness: 0, opacity: 1, flow: 0.12, tip: 'round', spacing: 6, jitter: 0, scatter: 0 },
  { name: 'Chalk', size: 36, hardness: 1, opacity: 1, flow: 0.8, tip: 'chalk', spacing: 18, jitter: 1, scatter: 0.05 },
  { name: 'Charcoal', size: 30, hardness: 1, opacity: 0.9, flow: 0.7, tip: 'charcoal', spacing: 12, jitter: 0.08, scatter: 0 },
  { name: 'Spray', size: 60, hardness: 1, opacity: 1, flow: 0.6, tip: 'spray', spacing: 25, jitter: 1, scatter: 0.2 },
  { name: 'Splatter', size: 70, hardness: 1, opacity: 1, flow: 1, tip: 'splatter', spacing: 90, jitter: 1, scatter: 0.6 },
  { name: 'Grain texture', size: 90, hardness: 1, opacity: 0.6, flow: 0.5, tip: 'grain', spacing: 30, jitter: 1, scatter: 0.15 },
];

export function savedPresets(): BrushPreset[] {
  try { return JSON.parse(localStorage.getItem(PRESETS_KEY) || '[]'); } catch { return []; }
}
function storePresets(list: BrushPreset[]) {
  try { setSetting(PRESETS_KEY, JSON.stringify(list)); } catch { toast("Couldn't save brush presets (storage is full).", 'error'); }
}

export function applyPreset(o: BrushOpts, p: BrushPreset) {
  Object.assign(o, { size: p.size, hardness: p.hardness, opacity: p.opacity, flow: p.flow, tip: p.tip, spacing: p.spacing, jitter: p.jitter, scatter: p.scatter });
  app.saveOpts();
  app.emit('tool');
}

/** A small preview of a tip (or of a round brush at the given hardness). */
function tipThumb(id: string, hardness: number) {
  const c = newCanvas(40, 40);
  const x = ctx2d(c);
  x.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--text').trim() || '#ddd';
  const tip = getTip(id, () => { c.replaceWith(tipThumb(id, hardness)); });
  if (tip) {
    x.drawImage(tip, 4, 4, 32, 32);
    x.globalCompositeOperation = 'source-in';
    x.fillRect(0, 0, 40, 40);
  } else {
    const g = x.createRadialGradient(20, 20, 0, 20, 20, 16);
    g.addColorStop(0, x.fillStyle as string); g.addColorStop(Math.min(0.98, hardness), x.fillStyle as string); g.addColorStop(1, 'transparent');
    x.fillStyle = g; x.beginPath(); x.arc(20, 20, 16, 0, 7); x.fill();
  }
  return c;
}

/** A one-line text question; resolves to the text, or null if cancelled. */
export function askText(title: string, label: string, value: string): Promise<string | null> {
  return new Promise((res) => {
    const inp = h('input', { type: 'text', value, spellcheck: false });
    dialog({
      title, width: 380,
      body: h('label', { class: 'field wide' }, h('span', null, label), inp),
      onCancel: () => res(null),
      buttons: [{ label: 'Cancel', onClick: () => res(null) }, { label: 'OK', primary: true, onClick: () => res(inp.value) }],
    });
    setTimeout(() => { inp.focus(); inp.select(); }, 30);
  });
}

export function brushDialog(tool: 'brush' | 'eraser') {
  const o = app.opts[tool];
  const presets = h('div', { class: 'preset-grid' });
  const tips = h('div', { class: 'tip-grid' });
  const drawPresets = () => {
    const saved = savedPresets();
    presets.replaceChildren(
      ...[...BUILTIN_PRESETS.map((p) => ({ p, saved: false })), ...saved.map((p) => ({ p, saved: true }))].map(({ p, saved: s }) => {
        const b = h('button', { class: 'preset', type: 'button', title: `${p.name}: ${p.size}px`, onclick: () => { applyPreset(o, p); drawTips(); sync(); } },
          tipThumb(p.tip, p.hardness), h('span', null, p.name));
        if (s) b.append(h('span', { class: 'preset-x', title: 'Delete preset', onclick: (e: MouseEvent) => { e.stopPropagation(); storePresets(savedPresets().filter((x) => x.name !== p.name)); drawPresets(); } }, '×'));
        return b;
      }),
      h('button', { class: 'preset add', type: 'button', title: 'Save the current settings as a preset', onclick: async () => {
        const name = (await askText('Save brush preset', 'Name', 'My brush'))?.trim();
        if (!name) return;
        const list = savedPresets().filter((x) => x.name !== name);
        list.push({ name, size: o.size, hardness: o.hardness, opacity: o.opacity, flow: o.flow, tip: o.tip, spacing: o.spacing, jitter: o.jitter, scatter: o.scatter });
        storePresets(list);
        drawPresets();
      } }, h('span', { class: 'plus' }, '+'), h('span', null, 'Save current')),
    );
  };
  const drawTips = () => {
    tips.replaceChildren(
      ...listTips().map((t) => {
        const b = h('button', { class: 'tip' + (o.tip === t.id ? ' on' : ''), type: 'button', title: t.label, onclick: () => { o.tip = t.id; app.saveOpts(); drawTips(); } },
          tipThumb(t.id, o.hardness), h('span', null, t.label));
        if (t.id.startsWith('custom-')) b.append(h('span', { class: 'preset-x', title: 'Remove tip', onclick: (e: MouseEvent) => { e.stopPropagation(); removeCustomTip(t.id); if (o.tip === t.id) o.tip = 'round'; app.saveOpts(); drawTips(); } }, '×'));
        return b;
      }),
      h('button', { class: 'tip add', type: 'button', title: 'Make a tip from an image: dark areas paint', onclick: async () => {
        const [f] = await pickFiles('image');
        if (!f) return;
        try { o.tip = await addCustomTip(f.file); app.saveOpts(); drawTips(); } catch (err) { toast((err as Error).message, 'error'); }
      } }, h('span', { class: 'plus' }, '+'), h('span', null, 'From image…')),
    );
  };
  const holder = h('div', { class: 'brush-sliders' });
  // Presets change these too, so they're rebuilt to show the new values.
  const sync = () => {
    holder.replaceChildren(
      slider({ label: 'Spacing', min: 1, max: 200, value: o.spacing, unit: '%', onInput: (v) => { o.spacing = v; }, onChange: () => app.saveOpts() }),
      slider({ label: 'Angle jitter', min: 0, max: 100, value: o.jitter * 100, unit: '%', onInput: (v) => { o.jitter = v / 100; }, onChange: () => app.saveOpts() }),
      slider({ label: 'Scatter', min: 0, max: 200, value: o.scatter * 100, unit: '%', onInput: (v) => { o.scatter = v / 100; }, onChange: () => app.saveOpts() }));
  };
  drawPresets();
  drawTips();
  sync();
  dialog({
    title: tool === 'brush' ? 'Brushes' : 'Eraser brushes', width: 470, modeless: true,
    body: [
      h('div', { class: 'brush-sec' }, 'Presets'), presets,
      h('div', { class: 'brush-sec' }, 'Tip'), tips,
      holder,
      h('p', { class: 'dialog-note' }, 'Textured tips work best with some spacing and jitter. Size, hardness, opacity and flow are in the tool bar.'),
    ],
    buttons: [{ label: 'Done', primary: true, onClick: () => { app.emit('tool'); } }],
  });
}
