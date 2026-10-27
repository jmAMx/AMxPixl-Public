import { h } from './dom';
import { ICONS, type IconName } from './icons';

export const icon = (name: IconName, cls = 'ico') => h('span', { class: cls, html: ICONS[name] });

let toastTimer = 0;
export function toast(msg: string, kind: 'info' | 'error' = 'info') {
  let el = document.querySelector<HTMLDivElement>('.toast');
  if (!el) { el = h('div', { class: 'toast' }); document.body.append(el); }
  el.textContent = msg;
  el.dataset.kind = kind;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => { el!.hidden = true; }, kind === 'error' ? 5200 : 2600);
}

// ---------- modal dialogs ----------

export interface DialogButton { label: string; primary?: boolean; danger?: boolean; onClick?: () => boolean | void | Promise<boolean | void> }

export interface DialogHandle { close(): void; el: HTMLElement }

let openDialogs = 0;
export const dialogOpen = () => openDialogs > 0;

export function dialog(o: { title: string; body: HTMLElement | HTMLElement[]; buttons: DialogButton[]; onCancel?: () => void; width?: number; modeless?: boolean }): DialogHandle {
  const backdrop = h('div', { class: 'backdrop' + (o.modeless ? ' modeless' : '') });
  const box = h('div', { class: 'dialog', role: 'dialog', 'aria-label': o.title, style: o.width ? `width:${o.width}px` : undefined });
  const foot = h('div', { class: 'dialog-foot' });
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    openDialogs--;
    backdrop.remove();
    window.removeEventListener('keydown', onKey, true);
  };
  const cancel = () => { o.onCancel?.(); close(); };
  const run = async (b: DialogButton) => {
    const r = await b.onClick?.();
    if (r !== false) close();
  };
  for (const b of o.buttons) {
    foot.append(h('button', { class: 'btn' + (b.primary ? ' primary' : '') + (b.danger ? ' danger' : ''), type: 'button', onclick: () => run(b) }, b.label));
  }
  const head = h('div', { class: 'dialog-head' }, h('h2', null, o.title), h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Close', onclick: cancel }, icon('close')));
  box.append(head, h('div', { class: 'dialog-body' }, ...(Array.isArray(o.body) ? o.body : [o.body])), foot);
  backdrop.append(box);
  if (!o.modeless) backdrop.addEventListener('pointerdown', (e) => { if (e.target === backdrop) cancel(); });
  const onKey = (e: KeyboardEvent) => {
    if (closed) return;
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancel(); }
    else if (e.key === 'Enter' && (e.target as HTMLElement)?.tagName !== 'TEXTAREA' && (e.target as HTMLElement)?.tagName !== 'BUTTON') {
      const p = o.buttons.find((b) => b.primary);
      if (p) { e.preventDefault(); e.stopPropagation(); run(p); }
    }
  };
  window.addEventListener('keydown', onKey, true);
  document.body.append(backdrop);
  openDialogs++;
  requestAnimationFrame(() => box.querySelector<HTMLElement>('input:not([type=checkbox]):not([type=range]), select, textarea, .btn.primary')?.focus());
  return { close, el: box };
}

export function ask(title: string, message: string, buttons: { id: string; label: string; primary?: boolean; danger?: boolean }[]): Promise<string> {
  return new Promise((res) => {
    dialog({
      title, width: 420,
      body: h('p', { class: 'dialog-msg' }, message),
      buttons: buttons.map((b) => ({ ...b, onClick: () => { res(b.id); } })),
      onCancel: () => res('cancel'),
    });
  });
}

// ---------- form controls ----------

export interface SliderOpts {
  label: string;
  min: number;
  max: number;
  step?: number;
  value: number;
  unit?: string;
  /** Shown/typed value = stored value * display (e.g. opacity 0..1 shown as 0..100). */
  display?: number;
  onInput: (v: number) => void;
  onChange?: (v: number) => void;
  compact?: boolean;
}

export function slider(o: SliderOpts) {
  const k = o.display ?? 1;
  const step = o.step ?? 1;
  const decimals = step < 1 ? Math.min(2, String(step).split('.')[1]?.length ?? 1) : 0;
  const fmt = (v: number) => (v * k).toFixed(decimals).replace(/\.0+$/, '');
  const range = h('input', { type: 'range', min: o.min * k, max: o.max * k, step, value: o.value * k });
  const num = h('input', { type: 'text', class: 'num', value: fmt(o.value), inputMode: 'decimal', spellcheck: false });
  const set = (v: number, final: boolean) => {
    v = Math.max(o.min, Math.min(o.max, v));
    range.value = String(v * k);
    if (document.activeElement !== num || final) num.value = fmt(v);
    o.onInput(v);
    if (final) o.onChange?.(v);
  };
  range.addEventListener('input', () => set(Number(range.value) / k, false));
  range.addEventListener('change', () => set(Number(range.value) / k, true));
  num.addEventListener('change', () => { const v = parseFloat(num.value); if (!isNaN(v)) set(v / k, true); else num.value = fmt(Number(range.value) / k); });
  num.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      const d = (e.key === 'ArrowUp' ? 1 : -1) * step * (e.shiftKey ? 10 : 1);
      set((Number(range.value) + d) / k, true);
    } else if (e.key === 'Enter') num.blur();
  });
  // Scrubby label: drag the label left/right to change the value, like Photoshop.
  const lab = h('label', { class: 'sl-label', title: 'Drag to adjust' }, o.label);
  lab.addEventListener('pointerdown', (e) => {
    const x0 = e.clientX, v0 = Number(range.value);
    const span = (o.max - o.min) * k;
    lab.setPointerCapture(e.pointerId);
    const mv = (ev: PointerEvent) => set((v0 + Math.round(((ev.clientX - x0) * span) / 300 / step) * step) / k, false);
    const upf = () => { lab.removeEventListener('pointermove', mv); set(Number(range.value) / k, true); };
    lab.addEventListener('pointermove', mv);
    lab.addEventListener('pointerup', upf, { once: true });
  });
  const el = h('div', { class: 'slider' + (o.compact ? ' compact' : '') }, lab, range, h('span', { class: 'num-wrap' }, num, o.unit ? h('span', { class: 'unit' }, o.unit) : null));
  return Object.assign(el, { setValue: (v: number) => { range.value = String(v * k); num.value = fmt(v); } });
}

export function numField(label: string, value: number, onChange: (v: number) => void, o: { unit?: string; step?: number; min?: number; max?: number; decimals?: number } = {}) {
  const dec = o.decimals ?? 0;
  const inp = h('input', { type: 'text', class: 'num', value: value.toFixed(dec), inputMode: 'decimal', spellcheck: false });
  const commit = () => {
    let v = parseFloat(inp.value);
    if (isNaN(v)) { inp.value = value.toFixed(dec); return; }
    if (o.min !== undefined) v = Math.max(o.min, v);
    if (o.max !== undefined) v = Math.min(o.max, v);
    value = v;
    inp.value = v.toFixed(dec);
    onChange(v);
  };
  inp.addEventListener('change', commit);
  inp.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { commit(); inp.blur(); }
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      inp.value = String((parseFloat(inp.value) || 0) + (e.key === 'ArrowUp' ? 1 : -1) * (o.step ?? 1) * (e.shiftKey ? 10 : 1));
      commit();
    }
  });
  const el = h('label', { class: 'field' }, h('span', null, label), h('span', { class: 'num-wrap' }, inp, o.unit ? h('span', { class: 'unit' }, o.unit) : null));
  return Object.assign(el, { input: inp, set: (v: number) => { value = v; if (document.activeElement !== inp) inp.value = v.toFixed(dec); } });
}

export function select<T extends string>(options: [T, string][], value: T, onChange: (v: T) => void, cls = '') {
  const s = h('select', { class: cls, onchange: () => onChange(s.value as T) }, ...options.map(([v, l]) => h('option', { value: v, selected: v === value }, l)));
  return s;
}

export function checkbox(label: string, checked: boolean, onChange: (v: boolean) => void, title?: string) {
  const inp = h('input', { type: 'checkbox', checked, onchange: () => onChange(inp.checked) });
  return h('label', { class: 'check', title }, inp, h('span', null, label));
}

export function seg<T extends string>(options: { v: T; label?: string; icon?: IconName; title?: string }[], value: T, onChange: (v: T) => void) {
  const el = h('div', { class: 'seg', role: 'radiogroup' });
  const draw = (cur: T) => {
    el.replaceChildren(...options.map((o) => h('button', {
      type: 'button', class: o.v === cur ? 'on' : '', title: o.title ?? o.label, 'aria-pressed': String(o.v === cur),
      onclick: () => { draw(o.v); onChange(o.v); },
    }, o.icon ? icon(o.icon) : null, o.label && !o.icon ? o.label : null)));
  };
  draw(value);
  return el;
}

// ---------- popup menus ----------

export interface MenuItem { label?: string; accel?: string; disabled?: boolean; checked?: boolean; sep?: boolean; onClick?: () => void; sub?: MenuItem[] }

let closeActivePopup: (() => void) | null = null;

export function popupMenu(items: MenuItem[], x: number, y: number, onClose?: () => void) {
  closeActivePopup?.();
  const el = buildMenu(items, () => close());
  document.body.append(el);
  // Opens down and to the right of the point; flips to the other side where it would run off screen.
  const r = el.getBoundingClientRect();
  el.style.left = `${placeAlong(x, x, r.width, innerWidth)}px`;
  // Too tall for either side: use the roomier one and scroll.
  const below = innerHeight - 4 - y, above = y - 4;
  if (r.height > below && r.height > above) {
    el.style.maxHeight = `${Math.max(below, above)}px`;
    el.style.top = `${below >= above ? y : 4}px`;
  } else el.style.top = `${placeAlong(y, y, r.height, innerHeight)}px`;
  const outside = (e: PointerEvent) => { if (!el.contains(e.target as Node)) close(); };
  const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
  const close = () => {
    el.remove();
    window.removeEventListener('pointerdown', outside, true);
    window.removeEventListener('keydown', key, true);
    window.removeEventListener('blur', close);
    if (closeActivePopup === close) closeActivePopup = null;
    onClose?.();
  };
  setTimeout(() => window.addEventListener('pointerdown', outside, true));
  window.addEventListener('keydown', key, true);
  window.addEventListener('blur', close);
  closeActivePopup = close;
  return close;
}

export const closePopups = () => closeActivePopup?.();

function buildMenu(items: MenuItem[], done: () => void): HTMLElement {
  const el = h('div', { class: 'menu', role: 'menu' });
  for (const it of items) {
    if (it.sep) { el.append(h('div', { class: 'menu-sep' })); continue; }
    const row = h('button', {
      type: 'button', class: 'menu-item' + (it.sub ? ' has-sub' : ''), role: 'menuitem', disabled: it.disabled,
      onclick: () => { if (it.sub) return; done(); it.onClick?.(); },
    },
    h('span', { class: 'menu-check' }, it.checked ? icon('check') : null),
    h('span', { class: 'menu-label' }, it.label ?? ''),
    h('span', { class: 'menu-accel' }, it.accel ?? (it.sub ? '›' : '')));
    if (it.sub) {
      const sub = buildMenu(it.sub, done);
      sub.classList.add('submenu');
      row.append(sub);
      // Submenus open beside their row, flipping left or shifting up to stay on screen.
      row.addEventListener('pointerenter', () => {
        sub.style.display = 'block';
        const rr = row.getBoundingClientRect(), s = sub.getBoundingClientRect();
        sub.style.left = `${placeAlong(rr.right - 2, rr.left + 2, s.width, innerWidth)}px`;
        sub.style.top = `${placeAlong(rr.top - 5, rr.bottom + 5, s.height, innerHeight, true)}px`;
        sub.style.display = '';
      });
    }
    el.append(row);
  }
  return el;
}

/**
 * Where a popup of `size` starts along one axis: after `start` if it fits, else ending at `end` (the other side),
 * else pinned to the screen edge. `shift` slides it back on screen instead of flipping (submenus going up).
 */
function placeAlong(start: number, end: number, size: number, limit: number, shift = false) {
  const m = 4;
  if (start + size <= limit - m) return start;
  if (shift) return Math.max(m, limit - m - size);
  if (end - size >= m) return end - size;
  return Math.max(m, limit - m - size);
}
