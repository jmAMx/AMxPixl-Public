import { app } from '../app';
import { flipLayer, resetTransform, rasterizeLayer } from '../actions';
import { ADJ_LABELS, curveTable, histogram, type Histogram } from '../core/adjustments';
import type { Doc } from '../core/document';
import { ctx2d, localBounds, newCanvas } from '../core/layers';
import { renderDoc } from '../core/render';
import type { AdjParams, AdjustLayer, Channel, CurvePts, Layer, LevelsCh, PlacedLayer, ShapeLayer, TextLayer } from '../core/types';
import { h } from './dom';
import { allFontsLoaded, fontList, loadInstalledFonts } from './fonts';
import { checkbox, icon, numField, seg, slider } from './widgets';

const deg = (r: number) => (r * 180) / Math.PI;

/** Histogram of everything beneath a layer (what an adjustment layer receives), at a cheap preview size. */
function histBelow(doc: Doc, layer: Layer): Histogram {
  const i = doc.indexOf(layer.id);
  const s = Math.min(1, 320 / Math.max(doc.width, doc.height));
  const c = newCanvas(Math.max(1, doc.width * s), Math.max(1, doc.height * s));
  renderDoc(doc, c, [s, 0, 0, s, 0, 0], { layers: doc.layers.slice(0, i) });
  return histogram(ctx2d(c, true).getImageData(0, 0, c.width, c.height));
}

function drawHist(ctx: CanvasRenderingContext2D, hg: Histogram, ch: Channel, w: number, hh: number, color: string) {
  const data = ch === 'rgb' ? hg.l : hg[ch];
  ctx.fillStyle = color;
  const max = Math.log1p(hg.max);
  for (let i = 0; i < 256; i++) {
    const v = (Math.log1p(data[i]) / max) * hh;
    ctx.fillRect((i / 256) * w, hh - v, Math.ceil(w / 256), v);
  }
}

const CH_OPTS: { v: Channel; label: string }[] = [{ v: 'rgb', label: 'RGB' }, { v: 'r', label: 'Red' }, { v: 'g', label: 'Green' }, { v: 'b', label: 'Blue' }];
const CH_COLOR: Record<Channel, string> = { rgb: '#d8e2df', r: '#ff6b5e', g: '#4ade80', b: '#6fa4ff' };

export function propertiesPanel() {
  const body = h('div', { class: 'props-body' });
  let sig = '';
  let refreshers: (() => void)[] = [];
  let selfCommit = false;

  /** Commits an edit made from this panel without rebuilding the panel underneath the user. */
  const commitSelf = (label: string) => {
    selfCommit = true;
    try { app.doc!.commit(label); } finally { selfCommit = false; }
  };

  /** Live edit (while dragging) + undo step when released. */
  const edit = (l: Layer, label: string) => ({
    live: () => app.doc!.touch('meta'),
    done: () => commitSelf(label),
    l,
  });

  const section = (title: string, ...kids: (HTMLElement | null)[]) => h('div', { class: 'props-section' }, h('h3', null, title), ...kids);

  const transformSection = (l: PlacedLayer) => {
    const doc = app.doc!;
    const b = () => localBounds(l, doc.pool);
    const size = () => {
      if (l.type === 'shape') return { w: Math.abs(l.shape.w), h: Math.abs(l.shape.h) };
      const bb = b();
      return { w: Math.abs(bb.w * l.t.sx), h: Math.abs(bb.h * l.t.sy) };
    };
    const commit = commitSelf;
    const x = numField('X', l.t.x, (v) => { l.t = { ...l.t, x: v }; commit('Move'); }, { unit: 'px' });
    const y = numField('Y', l.t.y, (v) => { l.t = { ...l.t, y: v }; commit('Move'); }, { unit: 'px' });
    const setSize = (axis: 'w' | 'h', v: number) => {
      if (l.type === 'shape') l.shape = { ...l.shape, [axis]: Math.sign(l.shape[axis] || 1) * v };
      else {
        const bb = b();
        if (axis === 'w') l.t = { ...l.t, sx: Math.sign(l.t.sx) * (v / bb.w) };
        else l.t = { ...l.t, sy: Math.sign(l.t.sy) * (v / bb.h) };
      }
      commit('Resize layer');
    };
    const w = numField('W', size().w, (v) => setSize('w', Math.max(1, v)), { unit: 'px' });
    const hh = numField('H', size().h, (v) => setSize('h', Math.max(1, v)), { unit: 'px' });
    const a = numField('Angle', deg(l.t.rot), (v) => { l.t = { ...l.t, rot: (v * Math.PI) / 180 }; commit('Rotate'); }, { unit: '°', decimals: 1 });
    refreshers.push(() => { x.set(l.t.x); y.set(l.t.y); const s = size(); w.set(s.w); hh.set(s.h); a.set(deg(l.t.rot)); });
    let note: HTMLElement | null = null;
    if (l.type === 'raster') {
      const c = doc.canvasOf(l);
      const pct = Math.round(Math.abs(l.t.sx) * 100);
      note = h('p', { class: 'props-note' }, `Original pixels: ${c.width} × ${c.height}${pct !== 100 ? ` · shown at ${pct}%` : ''}. Scaling never touches the original.`);
    }
    return section('Transform',
      h('div', { class: 'grid2' }, x, y, w, hh),
      h('div', { class: 'grid2' }, a, h('div', { class: 'btn-row' },
        h('button', { class: 'icon-btn', type: 'button', title: 'Flip horizontal', onclick: () => flipLayer('h') }, icon('flipH')),
        h('button', { class: 'icon-btn', type: 'button', title: 'Flip vertical', onclick: () => flipLayer('v') }, icon('flipV')),
        h('button', { class: 'btn small', type: 'button', title: 'Original size, no rotation', onclick: () => resetTransform() }, 'Reset'))),
      note);
  };

  const colorInput = (value: string, onInput: (v: string) => void, onDone: () => void) => {
    const inp = h('input', { type: 'color', value, class: 'color-input' });
    inp.addEventListener('input', () => onInput(inp.value));
    inp.addEventListener('change', onDone);
    return h('span', { class: 'color-pair' }, inp,
      h('button', { class: 'btn small', type: 'button', title: 'Use the foreground colour', onclick: () => { inp.value = app.fg; onInput(app.fg); onDone(); } }, 'Use FG'));
  };

  const textSection = (l: TextLayer) => {
    const e = edit(l, 'Text style');
    const set = (patch: Partial<TextLayer['text']>, final = true) => { l.text = { ...l.text, ...patch }; e.live(); if (final) e.done(); };
    const content = h('textarea', { class: 'props-text', rows: 3, value: l.text.content, spellcheck: false });
    content.addEventListener('input', () => { set({ content: content.value }, false); l.name = content.value.split('\n')[0].slice(0, 32) || 'Text'; });
    content.addEventListener('change', () => commitSelf('Edit text'));
    content.addEventListener('keydown', (ev) => ev.stopPropagation());
    const font = h('select', { onchange: async () => {
      if (font.value === '__more') { font.value = l.text.font; if (await loadInstalledFonts()) build(true); return; }
      set({ font: font.value });
    } }, ...fontList().map((f) => h('option', { value: f, selected: f === l.text.font }, f)), allFontsLoaded() ? null : h('option', { value: '__more' }, 'Show all installed fonts…'));
    return section('Text',
      content,
      h('label', { class: 'field wide' }, h('span', null, 'Font'), font),
      h('div', { class: 'grid2' },
        numField('Size', l.text.size, (v) => set({ size: v }), { unit: 'px', min: 1, max: 2000 }),
        h('label', { class: 'field' }, h('span', null, 'Colour'), colorInput(l.text.color, (v) => set({ color: v }, false), e.done))),
      h('div', { class: 'btn-row' },
        seg([{ v: '400', label: 'Regular' }, { v: '700', label: 'Bold' }], String(l.text.weight) as '400' | '700', (v) => set({ weight: Number(v) })),
        seg([{ v: 'n', label: 'Normal' }, { v: 'i', label: 'Italic' }], l.text.italic ? 'i' : 'n', (v) => set({ italic: v === 'i' }))),
      h('div', { class: 'btn-row' }, seg([{ v: 'left', icon: 'alignL', title: 'Left' }, { v: 'center', icon: 'alignC', title: 'Centre' }, { v: 'right', icon: 'alignR', title: 'Right' }], l.text.align, (v) => set({ align: v }))),
      slider({ label: 'Line height', min: 0.6, max: 3, step: 0.05, value: l.text.lineHeight, onInput: (v) => set({ lineHeight: v }, false), onChange: e.done }),
      slider({ label: 'Tracking', min: -20, max: 100, step: 0.5, value: l.text.tracking, unit: 'px', onInput: (v) => set({ tracking: v }, false), onChange: e.done }),
      h('button', { class: 'btn small', type: 'button', onclick: () => rasterizeLayer() }, 'Rasterize text'));
  };

  const shapeSection = (l: ShapeLayer) => {
    const e = edit(l, 'Shape style');
    const set = (patch: Partial<ShapeLayer['shape']>, final = true) => { l.shape = { ...l.shape, ...patch }; e.live(); if (final) e.done(); };
    const s = l.shape;
    return section(s.kind === 'line' ? 'Line' : s.kind === 'ellipse' ? 'Ellipse' : 'Rectangle',
      s.kind !== 'line' ? h('div', { class: 'prop-line' }, checkbox('Fill', !!s.fill, (v) => set({ fill: v ? (l.shape.fill ?? app.fg) : null })),
        colorInput(s.fill ?? app.fg, (v) => set({ fill: v }, false), e.done)) : null,
      h('div', { class: 'prop-line' }, checkbox('Stroke', !!s.stroke, (v) => set({ stroke: v ? (l.shape.stroke ?? app.fg) : null })),
        colorInput(s.stroke ?? app.fg, (v) => set({ stroke: v }, false), e.done)),
      slider({ label: 'Stroke width', min: 0, max: 200, step: 0.5, value: s.strokeWidth, unit: 'px', onInput: (v) => set({ strokeWidth: v }, false), onChange: e.done }),
      s.kind === 'rect' ? slider({ label: 'Corner radius', min: 0, max: 1000, value: s.radius, unit: 'px', onInput: (v) => set({ radius: v }, false), onChange: e.done }) : null,
      h('button', { class: 'btn small', type: 'button', onclick: () => rasterizeLayer() }, 'Rasterize shape'));
  };

  const adjSection = (l: AdjustLayer) => {
    const label = ADJ_LABELS[l.adj.kind];
    const e = edit(l, label);
    const upd = <T extends AdjParams>(f: (a: T) => T, final = false) => { l.adj = f(structuredClone(l.adj) as T); e.live(); if (final) e.done(); };
    const sl = (lab: string, min: number, max: number, get: number, put: (v: number) => void, step = 1, unit?: string) =>
      slider({ label: lab, min, max, step, value: get, unit, onInput: (v) => { put(v); e.live(); }, onChange: e.done });
    const a = l.adj;
    const kids: (HTMLElement | null)[] = [];
    switch (a.kind) {
      case 'brightness':
        kids.push(sl('Brightness', -150, 150, a.brightness, (v) => upd<typeof a>((x) => ({ ...x, brightness: v }))),
          sl('Contrast', -100, 100, a.contrast, (v) => upd<typeof a>((x) => ({ ...x, contrast: v }))));
        break;
      case 'huesat':
        kids.push(sl('Hue', -180, 180, a.hue, (v) => upd<typeof a>((x) => ({ ...x, hue: v })), 1, '°'),
          sl('Saturation', -100, 100, a.sat, (v) => upd<typeof a>((x) => ({ ...x, sat: v }))),
          sl('Lightness', -100, 100, a.light, (v) => upd<typeof a>((x) => ({ ...x, light: v }))));
        break;
      case 'vibrance':
        kids.push(sl('Vibrance', -100, 100, a.vibrance, (v) => upd<typeof a>((x) => ({ ...x, vibrance: v }))),
          sl('Saturation', -100, 100, a.saturation, (v) => upd<typeof a>((x) => ({ ...x, saturation: v }))));
        break;
      case 'exposure':
        kids.push(sl('Exposure', -5, 5, a.exposure, (v) => upd<typeof a>((x) => ({ ...x, exposure: v })), 0.01),
          sl('Offset', -0.5, 0.5, a.offset, (v) => upd<typeof a>((x) => ({ ...x, offset: v })), 0.001),
          sl('Gamma', 0.1, 3, a.gamma, (v) => upd<typeof a>((x) => ({ ...x, gamma: v })), 0.01));
        break;
      case 'threshold':
        kids.push(sl('Level', 1, 255, a.level, (v) => upd<typeof a>((x) => ({ ...x, level: v }))));
        break;
      case 'posterize':
        kids.push(sl('Levels', 2, 64, a.levels, (v) => upd<typeof a>((x) => ({ ...x, levels: v }))));
        break;
      case 'invert':
        kids.push(h('p', { class: 'props-note' }, 'Inverts every colour below this layer. Lower the layer opacity to soften it.'));
        break;
      case 'bw':
        kids.push(h('div', { class: 'prop-line' }, checkbox('Tint', !!a.tint, (v) => upd<typeof a>((x) => ({ ...x, tint: v ? (x.tint ?? '#c8a46e') : null }), true)),
          colorInput(a.tint ?? '#c8a46e', (v) => upd<typeof a>((x) => ({ ...x, tint: v })), e.done)));
        break;
      case 'colorbalance': {
        let tone: 'shadows' | 'midtones' | 'highlights' = 'midtones';
        const box = h('div');
        const draw = () => {
          const cur = (l.adj as typeof a)[tone];
          box.replaceChildren(
            sl('Cyan ↔ Red', -100, 100, cur[0], (v) => upd<typeof a>((x) => { x[tone][0] = v; return x; })),
            sl('Magenta ↔ Green', -100, 100, cur[1], (v) => upd<typeof a>((x) => { x[tone][1] = v; return x; })),
            sl('Yellow ↔ Blue', -100, 100, cur[2], (v) => upd<typeof a>((x) => { x[tone][2] = v; return x; })));
        };
        draw();
        kids.push(seg([{ v: 'shadows', label: 'Shadows' }, { v: 'midtones', label: 'Midtones' }, { v: 'highlights', label: 'Highlights' }], tone, (v) => { tone = v; draw(); }), box);
        break;
      }
      case 'levels': kids.push(levelsUI(l, e)); break;
      case 'curves': kids.push(curvesUI(l, e)); break;
    }
    return section(label, ...kids);
  };

  const levelsUI = (l: AdjustLayer, e: ReturnType<typeof edit>) => {
    let ch: Channel = 'rgb';
    const hg = histBelow(app.doc!, l);
    const cv = h('canvas', { class: 'hist', width: 512, height: 160 });
    const box = h('div');
    const get = () => (l.adj as Extract<AdjParams, { kind: 'levels' }>).ch[ch];
    const put = (patch: Partial<LevelsCh>) => { const a = structuredClone(l.adj) as Extract<AdjParams, { kind: 'levels' }>; a.ch[ch] = { ...a.ch[ch], ...patch }; l.adj = a; e.live(); paint(); };
    const paint = () => {
      const x = ctx2d(cv);
      x.clearRect(0, 0, cv.width, cv.height);
      drawHist(x, hg, ch, cv.width, cv.height, CH_COLOR[ch] + '99');
      const c = get();
      x.fillStyle = 'rgba(0,0,0,.35)';
      x.fillRect(0, 0, (c.inBlack / 255) * cv.width, cv.height);
      x.fillRect((c.inWhite / 255) * cv.width, 0, cv.width, cv.height);
    };
    const draw = () => {
      const c = get();
      box.replaceChildren(
        slider({ label: 'Shadows in', min: 0, max: 253, value: c.inBlack, onInput: (v) => put({ inBlack: Math.min(v, get().inWhite - 2) }), onChange: e.done }),
        slider({ label: 'Midtones', min: 0.1, max: 9.99, step: 0.01, value: c.gamma, onInput: (v) => put({ gamma: v }), onChange: e.done }),
        slider({ label: 'Highlights in', min: 2, max: 255, value: c.inWhite, onInput: (v) => put({ inWhite: Math.max(v, get().inBlack + 2) }), onChange: e.done }),
        slider({ label: 'Output black', min: 0, max: 255, value: c.outBlack, onInput: (v) => put({ outBlack: v }), onChange: e.done }),
        slider({ label: 'Output white', min: 0, max: 255, value: c.outWhite, onInput: (v) => put({ outWhite: v }), onChange: e.done }));
      paint();
    };
    const auto = () => {
      // Clip 0.1% at each end of the luminance histogram, like Photoshop's Auto.
      const total = hg.l.reduce((s, v) => s + v, 0), cut = total * 0.001;
      let lo = 0, hi = 255, acc = 0;
      while (lo < 254 && (acc += hg.l[lo]) <= cut) lo++;
      acc = 0;
      while (hi > lo + 2 && (acc += hg.l[hi]) <= cut) hi--;
      ch = 'rgb';
      put({ inBlack: lo, inWhite: hi });
      e.done();
      build(true);
    };
    draw();
    return h('div', null,
      h('div', { class: 'btn-row' }, seg(CH_OPTS, ch, (v) => { ch = v; draw(); }), h('button', { class: 'btn small', type: 'button', title: 'Stretch the darkest and brightest tones', onclick: auto }, 'Auto')),
      cv, box);
  };

  const curvesUI = (l: AdjustLayer, e: ReturnType<typeof edit>) => {
    let ch: Channel = 'rgb';
    const hg = histBelow(app.doc!, l);
    const S = 512;
    const cv = h('canvas', { class: 'curve', width: S, height: S });
    const pts = (): CurvePts => (l.adj as Extract<AdjParams, { kind: 'curves' }>).ch[ch];
    const setPts = (p: CurvePts) => { const a = structuredClone(l.adj) as Extract<AdjParams, { kind: 'curves' }>; a.ch[ch] = p; l.adj = a; e.live(); paint(); };
    const k = S / 255;
    const paint = () => {
      const x = ctx2d(cv);
      x.clearRect(0, 0, S, S);
      drawHist(x, hg, ch, S, S, 'rgba(140,160,155,.22)');
      x.strokeStyle = 'rgba(140,160,155,.25)';
      x.lineWidth = 1;
      x.beginPath();
      for (let i = 1; i < 4; i++) { x.moveTo((S * i) / 4, 0); x.lineTo((S * i) / 4, S); x.moveTo(0, (S * i) / 4); x.lineTo(S, (S * i) / 4); }
      x.moveTo(0, S); x.lineTo(S, 0);
      x.stroke();
      const t = curveTable(pts());
      x.strokeStyle = CH_COLOR[ch];
      x.lineWidth = 3;
      x.beginPath();
      for (let i = 0; i < 256; i++) { const px = i * k, py = S - Math.max(0, Math.min(255, t[i])) * k; i ? x.lineTo(px, py) : x.moveTo(px, py); }
      x.stroke();
      for (const [px, py] of pts()) {
        x.fillStyle = '#fff';
        x.strokeStyle = '#000';
        x.lineWidth = 2;
        x.beginPath(); x.arc(px * k, S - py * k, 9, 0, Math.PI * 2); x.fill(); x.stroke();
      }
    };
    const toVal = (ev: PointerEvent) => {
      const r = cv.getBoundingClientRect();
      return { x: ((ev.clientX - r.left) / r.width) * 255, y: (1 - (ev.clientY - r.top) / r.height) * 255 };
    };
    let drag = -1;
    cv.addEventListener('pointerdown', (ev) => {
      const v = toVal(ev);
      const p = pts().map((q) => [...q] as [number, number]);
      const r = cv.getBoundingClientRect();
      const tol = (14 / r.width) * 255;
      drag = p.findIndex(([px, py]) => Math.hypot(px - v.x, py - v.y) < tol);
      if (drag < 0) {
        p.push([Math.round(v.x), Math.round(v.y)]);
        p.sort((a, b) => a[0] - b[0]);
        drag = p.findIndex(([px]) => px === Math.round(v.x));
        setPts(p);
      }
      cv.setPointerCapture(ev.pointerId);
    });
    cv.addEventListener('pointermove', (ev) => {
      if (drag < 0) return;
      const v = toVal(ev);
      const p = pts().map((q) => [...q] as [number, number]);
      const last = p.length - 1;
      if (drag > 0 && drag < last && (v.y < -30 || v.y > 285)) { p.splice(drag, 1); drag = -1; setPts(p); return; }
      const lo = drag > 0 ? p[drag - 1][0] + 1 : 0, hi = drag < last ? p[drag + 1][0] - 1 : 255;
      p[drag] = [Math.round(Math.max(lo, Math.min(hi, v.x))), Math.round(Math.max(0, Math.min(255, v.y)))];
      setPts(p);
    });
    cv.addEventListener('pointerup', () => { if (drag !== -2) e.done(); drag = -1; });
    cv.addEventListener('dblclick', (ev) => {
      const v = toVal(ev as PointerEvent);
      const p = pts().map((q) => [...q] as [number, number]);
      const i = p.findIndex(([px, py], j) => j > 0 && j < p.length - 1 && Math.hypot(px - v.x, py - v.y) < 10);
      if (i > 0) { p.splice(i, 1); setPts(p); e.done(); }
    });
    paint();
    return h('div', null,
      h('div', { class: 'btn-row' }, seg(CH_OPTS, ch, (v) => { ch = v; paint(); }),
        h('button', { class: 'btn small', type: 'button', onclick: () => { setPts([[0, 0], [255, 255]]); e.done(); } }, 'Reset')),
      cv, h('p', { class: 'props-note' }, 'Click to add a point, drag to shape the curve, drag a point off the graph (or double-click it) to remove it.'));
  };

  const build = (force = false) => {
    const doc = app.doc;
    const l = doc?.active ?? null;
    const s = signature();
    if (!force && s === sig) { refreshers.forEach((f) => f()); return; }
    sig = s;
    refreshers = [];
    if (!doc || !l) { body.replaceChildren(h('div', { class: 'empty-note' }, doc ? 'Select a layer to see its properties.' : 'No image open')); return; }
    const kids: (HTMLElement | null)[] = [];
    if (l.type === 'text') kids.push(textSection(l));
    if (l.type === 'shape') kids.push(shapeSection(l));
    if (l.type === 'adjust') kids.push(adjSection(l));
    if (l.type !== 'adjust') kids.push(transformSection(l));
    body.replaceChildren(...kids.filter(Boolean) as HTMLElement[]);
  };

  const signature = () => {
    const doc = app.doc, l = doc?.active;
    return doc && l ? `${l.id}|${l.type}|${doc.index}|${doc.entries.length}` : String(!!doc);
  };

  // Rebuild when the selected layer or the history position changes; otherwise just refresh numbers in place
  // (so a slider being dragged in here is never torn down mid-drag).
  app.on('docs', () => build(true));
  app.on('change', ({ doc, kind }) => {
    if (doc !== app.doc || kind === 'pixels') return;
    if (selfCommit) { sig = signature(); refreshers.forEach((f) => f()); return; }
    const el = document.activeElement;
    if (kind === 'meta' && el && body.contains(el) && el.tagName === 'TEXTAREA') return;
    build();
  });
  build(true);
  return body;
}
