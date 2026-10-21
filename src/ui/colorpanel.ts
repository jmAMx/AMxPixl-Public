import { app } from '../app';
import { ctx2d } from '../core/layers';
import { hexToRgb, hsvToRgb, normHex, rgbToHex, rgbToHsv } from './color';
import { h } from './dom';
import { icon, numField } from './widgets';

const PRESETS = ['#000000', '#ffffff', '#808080', '#2ee6be', '#11a585', '#e53935', '#fb8c00', '#fdd835', '#43a047', '#1e88e5', '#5e35b1', '#d81b60'];

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
  const fgBtn = h('button', { class: 'tgt', type: 'button', onclick: () => setTarget('fg') }, h('span', { class: 'sw' }), 'Foreground');
  const bgBtn = h('button', { class: 'tgt', type: 'button', onclick: () => setTarget('bg') }, h('span', { class: 'sw' }), 'Background');
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
    const gr = x.createLinearGradient(0, 0, hueBar.width, 0);
    for (let i = 0; i <= 6; i++) { const [cr, cg, cb] = hsvToRgb(i * 60, 1, 1); gr.addColorStop(i / 6, `rgb(${cr},${cg},${cb})`); }
    x.fillStyle = gr;
    x.fillRect(0, 0, hueBar.width, hueBar.height);
    const px = (hue / 360) * hueBar.width;
    x.fillStyle = '#fff'; x.strokeStyle = '#000'; x.lineWidth = 1;
    x.fillRect(px - 2, 0, 4, hueBar.height); x.strokeRect(px - 2, 0.5, 4, hueBar.height - 1);
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
    recent.replaceChildren(...[...new Set([...app.recent, ...PRESETS])].slice(0, 18).map((col) =>
      h('button', { class: 'swatch', type: 'button', title: `${col} (Alt+click for background)`, style: `background:${col}`, onclick: (e: MouseEvent) => app.setColor(e.altKey ? 'bg' : target, col) })));
  };

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
  drag(hueBar, (x) => { hue = x * 359.9; });

  hex.addEventListener('change', () => { const v = normHex(hex.value); if (v) { app.setColor(target, v); } else hex.value = current(); });
  hex.addEventListener('keydown', (e) => { if (e.key === 'Enter') hex.blur(); });

  app.on('colors', () => { if (!selfSet) loadFromApp(); });
  loadFromApp();

  return h('div', { class: 'color-panel' },
    h('div', { class: 'tgt-row' }, fgBtn, bgBtn,
      h('button', { class: 'icon-btn', type: 'button', title: 'Swap colours (X)', onclick: () => { const f = app.fg; app.setColor('fg', app.bg); app.setColor('bg', f); } }, icon('swap'))),
    sv, hueBar,
    h('div', { class: 'rgb-row' }, h('label', { class: 'field' }, h('span', null, '#'), hex), r, g, b),
    recent);
}
