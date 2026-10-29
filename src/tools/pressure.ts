import { app, type PressureTo, type Tablet } from '../app';
import type { BrushOpts } from '../core/brush';
import { h } from '../ui/dom';
import { popupMenu, type MenuItem } from '../ui/widgets';

/**
 * Drawing tablet controls: each painting tool's Pressure menu (what pen pressure changes on that tool) and the
 * Pen Tablet settings every painting tool shares (Edit › Pen Tablet, also inside each Pressure menu).
 */

type PressureOpts = { pressure: boolean; pressureTo?: PressureTo };

/** The stroke options for a tool's pressure settings. */
export const strokePressure = (o: PressureOpts): Pick<BrushOpts, 'pressure' | 'pressureTo' | 'minSize'> => ({
  pressure: o.pressure, pressureTo: o.pressureTo ?? 'size', minSize: app.prefs.tablet?.min ?? 0.1,
});

const setTablet = (p: Partial<Tablet>) => app.setPrefs({ tablet: { ...app.prefs.tablet, ...p } });

/** Edit › Pen Tablet: how the pen behaves in every painting tool. */
export function tabletMenuItems(): MenuItem[] {
  const t = app.prefs.tablet;
  const pick = <K extends keyof Tablet>(k: K, v: Tablet[K], label: string): MenuItem => ({ label, checked: t[k] === v, onClick: () => setTablet({ [k]: v }) });
  return [
    { label: 'Pressure Feel', sub: [pick('curve', 'soft', 'Soft (light touches count for more)'), pick('curve', 'normal', 'Normal'), pick('curve', 'firm', 'Firm (press harder for full effect)')] },
    { label: 'Lightest Touch Size', sub: [pick('min', 0, 'Down to nothing'), pick('min', 0.1, '10% of the brush'), pick('min', 0.25, '25% of the brush'), pick('min', 0.5, '50% of the brush')] },
    { label: 'Eraser End Erases', checked: t.eraser, onClick: () => setTablet({ eraser: !t.eraser }) },
    { label: 'Side Button', sub: [pick('side', 'pan', 'Pans the View'), pick('side', 'pick', 'Picks a Colour'), pick('side', 'none', 'Does Nothing')] },
    { label: 'Smoothing', sub: [pick('smooth', 0, 'Off'), pick('smooth', 1, 'Low'), pick('smooth', 2, 'Medium'), pick('smooth', 3, 'High')] },
    { sep: true },
    { label: 'Pressure needs Windows Ink on (Wacom: Tablet Properties › Mapping)', disabled: true },
  ];
}

const LABEL: Record<PressureTo | 'off', string> = { size: 'Size', opacity: 'Opacity', both: 'Size + opacity', off: 'Off' };

/**
 * A tool's Pressure button for the options bar: what pen pressure changes on it (size, opacity or both, or
 * nothing), with the shared Pen Tablet settings. `strength`: the tool has strength rather than opacity (retouch).
 */
export function pressureControl(o: PressureOpts, save: () => void, strength = false): HTMLElement {
  const name = (v: PressureTo | 'off') => (strength ? LABEL[v].replace('Opacity', 'Strength').replace('opacity', 'strength') : LABEL[v]);
  const cur = (): PressureTo | 'off' => (o.pressure ? o.pressureTo ?? 'size' : 'off');
  const btn = h('button', { class: 'btn small', type: 'button', title: 'What pen pressure changes when you use a drawing tablet, and the tablet settings' });
  const label = () => { btn.textContent = `Pressure: ${name(cur())}`; };
  const set = (v: PressureTo | 'off') => {
    if (v === 'off') o.pressure = false;
    else { o.pressure = true; o.pressureTo = v; }
    save();
    label();
  };
  btn.addEventListener('click', () => {
    const r = btn.getBoundingClientRect();
    const opt = (v: PressureTo | 'off'): MenuItem => ({ label: name(v), checked: cur() === v, onClick: () => set(v) });
    popupMenu([
      { label: 'Pen pressure changes', disabled: true },
      opt('size'), opt('opacity'), opt('both'), opt('off'),
      { sep: true },
      { label: 'Pen Tablet', sub: tabletMenuItems() },
    ], r.left, r.bottom + 2);
  });
  label();
  return btn;
}
