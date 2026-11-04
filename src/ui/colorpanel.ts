import { app, DEFAULT_SWATCHES } from '../app';
import { ctx2d } from '../core/layers';
import { hexToRgb, hsvToRgb, normHex, rgbToHex, rgbToHsv } from './color';
import { h } from './dom';
import { icon, numField, popupMenu, type MenuItem } from './widgets';


/** HSV picker: saturation/value square + hue strip, editing the foreground (or background) colour. */
export function colorPanel() {
  let target: 'fg' | 'bg' = 'fg';
  let [hue, sat, val] = rgbToHsv(...hexToRgb(app.fg));
  const sv = h('canvas', { class: 'sv', width: 240, height: 140 });
  const hueBar = h('canvas', { class: 'hue', width: 240, height: 12 });
  const hex = h('input', { type: 'text', class: 'hex', spellcheck: false, maxLength: 7 });
  const r = numField('R', 0, () => fromRgb(), { min: 0, max: 255 });
  const g = numField('G', 0, () => fromRgb(), { min: 0, max: 255 });
  const b = numField('B', 0, () => fromRgb(), { min: 0, max: 255 });
  const fgBtn = h('button', { class: 'tgt', type: 'button', title: 'Foreground', onclick: () => setTarget('fg') }, h('span', { class: 'sw' }), h('span', { class: 'tgt-name' }, 'Foreground'));
  const bgBtn = h('button', { class: 'tgt', type: 'button', title: 'Background', onclick: () => setTarget('bg') }, h('span', { class: 'sw' }), h('span', { class: 'tgt-name' }, 'Background'));
  // In the compact form (a short panel) the hue strip stands upright beside the square.
  let upright = false;
  const recent = h('div', { class: 'swatches' });

  const current = () => app[target];

  const paintSV = () => {
    const x = ctx2d(sv);
    const [hr, hg, hb] = hsvToRgb(hue, 1, 1);
    x.fillStyle = `rgb(${hr},${hg},${hb})`;
    x.fillRect(0, 0, sv.width, sv.height);
    const w = x.createLinearGradient(0, 0, sv.width, 0);
    w.addColorStop(0, '#fff'); w.addColorStop(1, 'rgba(255,255,255,0)');
    x.fillStyle = w; x.fillRect(0, 0, sv.width, sv.height);
    const k = x.createLinearGradient(0, 0, 0, sv.height);
    k.addColorStop(0, 'rgba(0,0,0,0)'); k.addColorStop(1, '#000');
    x.fillStyle = k; x.fillRect(0, 0, sv.width, sv.height);
    const px = sat * sv.width, py = (1 - val) * sv.height;
    x.lineWidth = 2;
    x.strokeStyle = val > 0.55 && sat < 0.4 ? '#000' : '#fff';
    x.beginPath(); x.arc(px, py, 6, 0, Math.PI * 2); x.stroke();
  };

  const paintHue = () => {
    const x = ctx2d(hueBar);
    const len = upright ? hueBar.height : hueBar.width;
    const gr = upright ? x.createLinearGradient(0, 0, 0, len) : x.createLinearGradient(0, 0, len, 0);
    for (let i = 0; i <= 6; i++) { const [cr, cg, cb] = hsvToRgb(i * 60, 1, 1); gr.addColorStop(i / 6, `rgb(${cr},${cg},${cb})`); }
    x.fillStyle = gr;
    x.fillRect(0, 0, hueBar.width, hueBar.height);
    const p = (hue / 360) * len;
    x.fillStyle = '#fff'; x.strokeStyle = '#000'; x.lineWidth = 1;
    if (upright) { x.fillRect(0, p - 2, hueBar.width, 4); x.strokeRect(0.5, p - 2, hueBar.width - 1, 4); }
    else { x.fillRect(p - 2, 0, 4, hueBar.height); x.strokeRect(p - 2, 0.5, 4, hueBar.height - 1); }
  };

  const syncFields = () => {
    const c = current();
    const [cr, cg, cb] = hexToRgb(c);
    if (document.activeElement !== hex) hex.value = c;
    r.set(cr); g.set(cg); b.set(cb);
    (fgBtn.firstChild as HTMLElement).style.background = app.fg;
    (bgBtn.firstChild as HTMLElement).style.background = app.bg;
    fgBtn.classList.toggle('on', target === 'fg');
    bgBtn.classList.toggle('on', target === 'bg');
    // The swatches, the + square, then recent colours not among them: 18 squares in all, or more when there are more
    // swatches.
    const kept = app.swatches;
    const fill = app.recent.filter((c) => !kept.includes(c)).slice(0, Math.max(0, 17 - kept.length));
    const square = (col: string, isKept: boolean) => h('button', {
      class: 'swatch' + (isKept ? '' : ' recent'), type: 'button', style: `background:${col}`,
      title: `${col}${isKept ? '' : ' (recent)'}: Alt+click for background; right-click to ${isKept ? 'replace or remove it' : 'keep it as a swatch'}`,
      onclick: (e: MouseEvent) => app.setColor(e.altKey ? 'bg' : target, col),
      oncontextmenu: (e: MouseEvent) => { e.preventDefault(); popupMenu(isKept ? keptItems(col) : [{ label: 'Add to Swatches', swatch: col, onClick: () => app.setSwatches([...app.swatches, col]) }], e.clientX, e.clientY); },
    });
    const add = h('button', { class: 'swatch swatch-add', type: 'button', title: 'Add a swatch: the foreground or background colour, or a recent one',
      onclick: (e: MouseEvent) => { const r = (e.currentTarget as HTMLElement).getBoundingClientRect(); popupMenu(addItems(), r.left, r.bottom + 2); } }, icon('plus'));
    recent.replaceChildren(...kept.map((c) => square(c, true)), add, ...fill.map((c) => square(c, false)));
    queueMicrotask(() => fit()); // (how many there are changes how they fit)
  };

  /**
   * Colours to put in a swatch: the foreground, the background and the recent ones (those already a swatch can't be
   * chosen twice). `put` adds or replaces with the one chosen.
   */
  const choices = (put: (col: string) => void): MenuItem[] => {
    const item = (label: string, col: string): MenuItem => ({ label, swatch: col, disabled: app.swatches.includes(col), onClick: () => put(col) });
    const recents = app.recent.filter((c) => !app.swatches.includes(c));
    return [
      item(`Foreground (${app.fg})`, app.fg),
      item(`Background (${app.bg})`, app.bg),
      recents.length ? { label: 'Recent Colours', sub: recents.map((c) => item(c, c)) } : { label: 'No recent colours yet', disabled: true },
    ];
  };
  /** The + square's menu: add a colour, or go back to the starting set. */
  const addItems = (): MenuItem[] => [
    ...choices((col) => app.setSwatches([...app.swatches, col])),
    { sep: true },
    { label: 'Reset to Default Swatches', disabled: app.swatches.join() === DEFAULT_SWATCHES.join(), onClick: () => app.setSwatches(DEFAULT_SWATCHES) },
  ];
  /** A swatch's own menu (right-click): switch it for another colour, or remove it. */
  const keptItems = (col: string): MenuItem[] => [
    { label: 'Replace With', swatch: col, sub: choices((next) => app.setSwatches(app.swatches.map((c) => (c === col ? next : c)))) },
    { label: 'Remove Swatch', onClick: () => app.setSwatches(app.swatches.filter((c) => c !== col)) },
  ];

  let selfSet = false;
  const commit = () => {
    selfSet = true;
    app.setColor(target, rgbToHex(...hsvToRgb(hue, sat, val)));
    selfSet = false;
    paintSV(); paintHue(); syncFields();
  };

  const fromRgb = () => {
    const hx = rgbToHex(Number(r.input.value) || 0, Number(g.input.value) || 0, Number(b.input.value) || 0);
    [hue, sat, val] = rgbToHsv(...hexToRgb(hx));
    app.setColor(target, hx);
  };

  const loadFromApp = () => {
    const [nh, ns, nv] = rgbToHsv(...hexToRgb(current()));
    // Keep the hue when the colour is grey (hue is undefined there).
    if (ns > 0.001 && nv > 0.001) hue = nh;
    sat = ns; val = nv;
    paintSV(); paintHue(); syncFields();
  };

  const setTarget = (t: 'fg' | 'bg') => { target = t; loadFromApp(); };

  const drag = (el: HTMLCanvasElement, f: (x: number, y: number) => void) => {
    el.addEventListener('pointerdown', (e) => {
      el.setPointerCapture(e.pointerId);
      const go = (ev: PointerEvent) => {
        const rc = el.getBoundingClientRect();
        f(Math.max(0, Math.min(1, (ev.clientX - rc.left) / rc.width)), Math.max(0, Math.min(1, (ev.clientY - rc.top) / rc.height)));
        commit();
      };
      go(e);
      el.addEventListener('pointermove', go);
      el.addEventListener('pointerup', () => el.removeEventListener('pointermove', go), { once: true });
    });
  };
  drag(sv, (x, y) => { sat = x; val = 1 - y; });
  drag(hueBar, (x, y) => { hue = (upright ? y : x) * 359.9; });

  hex.addEventListener('change', () => { const v = normHex(hex.value); if (v) { app.setColor(target, v); } else hex.value = current(); });
  hex.addEventListener('keydown', (e) => { if (e.key === 'Enter') hex.blur(); });

  app.on('colors', () => { if (!selfSet) loadFromApp(); });
  loadFromApp();

  const rgbRow = h('div', { class: 'rgb-row' }, h('label', { class: 'field' }, h('span', null, '#'), hex), r, g, b);
  const tgtRow = h('div', { class: 'tgt-row' }, fgBtn, bgBtn,
    h('button', { class: 'icon-btn', type: 'button', title: 'Swap colours (X)', onclick: () => { const f = app.fg; app.setColor('fg', app.bg); app.setColor('bg', f); } }, icon('swap')));
  const root = h('div', { class: 'color-panel' }, tgtRow, sv, hueBar, rgbRow, recent);
  new ResizeObserver(() => fit()).observe(root);

  /**
   * Fitting a panel sized by hand. Shorter than it'd be on its own, it gives up room bit by bit: the square shrinks,
   * then the swatches shrink and the RGB row slides away, then the square shrinks some more, and below that it turns into one
   * row (the colours, the square and an upright hue strip) that keeps shrinking, to about a quarter of its own height.
   * Taller, the square grows.
   */
  const SV = 128, SV_MID = 72, SV_MIN = 40, SV_MAX = 300, GAP = 8;
  let shown = { svH: 0, upright: false }, tgtH = 28;
  function fit() {
    if (!root.clientWidth) return; // (its panel is closed)
    const sized = !!root.closest('.panel.sized');
    const collapse = (el: HTMLElement, room: number | null) => {
      el.style.height = room === null ? '' : `${Math.max(0, room - GAP)}px`;
      el.style.marginTop = room === null ? '' : `${Math.min(GAP, room)}px`;
    };
    let svH = SV, compact = false;
    // The swatches: rows of nine squares across the panel, wrapping into more, smaller columns (never cut off, and
    // always the panel's full width) when it's short, down to rows of eighteen.
    const swatch = (cols = 9) => recent.style.setProperty('--swc', String(cols));
    if (!sized) { swatch(); collapse(rgbRow, null); }
    else {
      const H = root.clientHeight, hueH = 12, W = root.clientWidth - 20;
      if (!root.classList.contains('compact')) tgtH = tgtRow.offsetHeight || tgtH;
      // The squares' height across `cols` columns: all of them, wrapped into rows.
      const n = recent.childElementCount || 18;
      const tall = (cols: number) => { const s = (W - (cols - 1) * 4) / cols, rows = Math.ceil(n / cols); return rows * s + (rows - 1) * 4; };
      const s1 = tall(18);
      // Room for the square, the swatches and the RGB row (those two with the gap above them).
      const rest = H - 18 - tgtH - GAP - GAP - hueH;
      if (rest < SV_MIN + GAP + s1) compact = true;
      else {
        let sw = GAP + tall(9), rgb = rgbRow.scrollHeight + GAP, over = SV + sw + rgb - rest;
        const cut = (have: number, floor: number) => { const c = Math.max(0, Math.min(over, have - floor)); over -= c; return have - c; };
        if (over <= 0) svH = Math.min(SV_MAX, SV - over);
        else { svH = cut(SV, SV_MID); sw = cut(sw, GAP + s1); rgb = cut(rgb, 0); svH = cut(svH, SV_MIN); }
        // Shorter, they wrap into more columns (smaller squares, fewer rows), always the panel's full width; the room
        // they don't need goes to the square.
        const room = sw - GAP;
        let cols = 9, used = tall(9);
        while (used > room && cols < 18) used = tall(++cols);
        swatch(cols);
        svH += Math.max(0, room - used);
        collapse(rgbRow, rgb);
      }
      if (compact) { svH = Math.max(16, H - 12); swatch(); collapse(rgbRow, null); }
    }
    root.classList.toggle('compact', compact);
    sv.style.height = `${svH}px`;
    hueBar.style.height = compact ? `${svH}px` : '';
    // Draw at the size shown, so the ring stays round.
    const w = Math.max(1, Math.round(sv.clientWidth)), hh = Math.round(svH);
    if (shown.svH === hh && shown.upright === compact && sv.width === w) return;
    shown = { svH: hh, upright: compact };
    upright = compact;
    sv.width = w; sv.height = hh;
    hueBar.width = compact ? 12 : 240; hueBar.height = compact ? hh : 12;
    paintSV(); paintHue();
  }
  return root;
}
