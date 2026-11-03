import { app } from '../app';
import * as A from '../actions';
import { Doc, flatLayers, newId } from '../core/document';
import type { PInfo, Tool } from '../tools/tool';
import { cropCanvas, ctx2d, newCanvas } from '../core/layers';
import { installedPlugins, PERMISSIONS, type InstalledPlugin } from '../core/plugins';
import { BLEND_MODES, type BlendMode, type Layer, type RasterLayer } from '../core/types';
import { h } from './dom';
import { applyEffect } from './dialogs';
import { icon, toast, type MenuItem } from './widgets';

/**
 * Script plugins run in a sandbox: each in its own iframe, sandboxed to scripts only (no same origin, so no access to
 * the app, its storage or the desktop bridge) with a content policy that blocks the network. The page talks to Pixl
 * only by messages, through the `pixl` object the bootstrap below gives it; every call is checked here against the
 * permissions the plugin declared (and agreed to when it was installed). A plugin's panel shows the same page.
 */

/**
 * Runs inside the plugin's page before its own script: the `pixl` API, as messages to Pixl. The desktop bridge's
 * objects the web view adds to every frame go first: requests through them can't leave the sandbox anyway (tested:
 * a write asked for from a plugin frame never happens), but a plugin has no business seeing them.
 */
const BOOTSTRAP = `(() => {
  for (const k of ['__TAURI_INTERNALS__', '__TAURI__', '__TAURI_IPC__', 'ipc']) { try { delete window[k]; } catch {} try { Object.defineProperty(window, k, { value: undefined }); } catch {} }
  try { if (window.chrome) Object.defineProperty(window.chrome, 'webview', { value: undefined }); } catch {}
  let seq = 0; const waiting = new Map(), commands = new Map(), handlers = { open: new Map(), export: new Map() }, tools = new Map();
  const call = (method, args) => new Promise((res, rej) => { const id = ++seq; waiting.set(id, { res, rej }); parent.postMessage({ pixl: 1, type: 'call', id, method, args }, '*'); });
  const img = (v) => v && new ImageData(v.data, v.width, v.height);
  // What goes wrong is shown in Pixl (a plugin's own console can't be seen): its script's errors, a tool's, a command's.
  const fail = (what, err) => parent.postMessage({ pixl: 1, type: 'failed', what, error: String((err && err.message) || err) }, '*');
  addEventListener('error', (e) => fail('its script', e.error || e.message));
  addEventListener('unhandledrejection', (e) => fail('its script', e.reason));
  addEventListener('message', async (e) => {
    const m = e.data; if (e.source !== parent || !m || m.pixl !== 1) return;
    if (m.type === 'result') { const w = waiting.get(m.id); if (!w) return; waiting.delete(m.id); if (m.ok) w.res(m.value); else w.rej(new Error(m.error)); }
    if (m.type === 'tool') { const t = tools.get(m.id); if (t && t[m.event]) { try { await t[m.event](m.point); } catch (err) { fail('the tool "' + m.id + '"', err); } } return; }
    if (m.type === 'request') {
      // Pixl asks: open a file of one of its formats (bytes in, layers out), or export the picture (bytes out).
      const reply = (ok, value) => parent.postMessage({ pixl: 1, type: 'response', id: m.id, ok, ...(ok ? { value } : { error: value }) }, '*');
      try {
        const f = handlers[m.kind] && handlers[m.kind].get(m.target);
        if (!f) throw new Error('nothing handles ' + m.kind + ' for "' + m.target + '"');
        reply(true, m.kind === 'open' ? await f(m.bytes, m.name) : await f(img(m.image)));
      } catch (err) { reply(false, String((err && err.message) || err)); }
      return;
    }
    if (m.type === 'command') {
      const f = commands.get(m.id);
      try { if (!f) throw new Error('nothing handles "' + m.id + '"'); await f(); }
      catch (err) { fail('the command "' + m.id + '"', err); }
    }
  });
  window.pixl = Object.freeze({
    onCommand: (id, f) => { commands.set(id, f); },
    onTool: (id, h) => { tools.set(id, h); },
    onOpen: (format, f) => { handlers.open.set(format, f); },
    onExport: (format, f) => { handlers.export.set(format, f); },
    image: () => call('image'),
    pixels: async (layerId, rect) => { const v = await call('pixels', { layerId, rect }); return v && Object.assign(img(v), { x: v.x, y: v.y }); },
    setPixels: (layerId, image, x = 0, y = 0, label) => call('setPixels', { layerId, x, y, width: image.width, height: image.height, data: image.data, label }),
    setLayer: (layerId, props) => call('setLayer', { layerId, props }),
    addLayer: (name, image) => call('addLayer', { name, width: image && image.width, height: image && image.height, data: image && image.data }),
    selection: async () => { const v = await call('selection'); return v && img(v); },
    run: (command, args) => call('run', { command, args }),
    toast: (text) => call('toast', { text: String(text) }),
    colors: () => call('colors'),
    setColors: (fg, bg) => call('setColors', { fg, bg }),
  });
  parent.postMessage({ pixl: 1, type: 'ready' }, '*');
})();`;

interface Frame { p: InstalledPlugin; iframe: HTMLIFrameElement; wrap: HTMLElement; ready: Promise<void>; onReady: () => void }
const frames = new Map<string, Frame>();

/** The page a plugin runs in: Pixl's look, the API, then its script (kept from closing the script tag early). */
function page(p: InstalledPlugin) {
  const css = getComputedStyle(document.body), v = (n: string) => css.getPropertyValue(n).trim();
  const safe = (s: string) => s.replace(/<\/script/gi, '<\\/script');
  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:">
<style>:root { --bg: ${v('--bg')}; --panel: ${v('--panel')}; --text: ${v('--text')}; --dim: ${v('--text-dim')}; --accent: ${v('--accent')}; --border: ${v('--border')}; }
body { margin: 10px; font: 13px/1.4 system-ui, sans-serif; color: var(--text); background: var(--panel); }
button, input, select { font: inherit; color: var(--text); background: var(--bg); border: 1px solid var(--border); border-radius: 4px; padding: 3px 8px; }
button:hover { border-color: var(--accent); }</style></head><body>
<script>${safe(BOOTSTRAP)}</script><script>${safe(p.manifest.main ?? '')}</script></body></html>`;
}

/** A plugin's page, made the first time it's needed (a command, or its panel) and kept while Pixl runs. */
function frameFor(p: InstalledPlugin): Frame {
  const have = frames.get(p.manifest.id);
  if (have && have.p === p) return have;
  if (have) closeFrame(p.manifest.id);
  const iframe = h('iframe', { class: 'plugin-frame', title: p.manifest.name }) as HTMLIFrameElement;
  iframe.setAttribute('sandbox', 'allow-scripts');
  const panel = p.manifest.panel;
  const wrap = h('div', { class: 'plugin-panel', style: `width:${panel?.width ?? 320}px;height:${(panel?.height ?? 360) + 30}px` });
  const head = h('div', { class: 'plugin-panel-head' }, h('span', null, panel?.title ?? p.manifest.name),
    h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Close', onclick: () => { wrap.classList.add('away'); } }, icon('close')));
  dragBy(head, wrap);
  wrap.append(head, iframe);
  // Closed is off screen, not removed (moving or removing a frame would start its page again) nor display: none
  // (the web view slows the timers of hidden pages from another origin to a crawl).
  wrap.classList.add('away');
  document.body.append(wrap);
  let onReady = () => {};
  const ready = new Promise<void>((r) => { onReady = r; });
  iframe.srcdoc = page(p);
  const f = { p, iframe, wrap, ready, onReady };
  frames.set(p.manifest.id, f);
  return f;
}

function dragBy(handle: HTMLElement, el: HTMLElement) {
  handle.addEventListener('pointerdown', (e) => {
    if ((e.target as HTMLElement).closest('button')) return;
    const r = el.getBoundingClientRect(), x0 = e.clientX - r.left, y0 = e.clientY - r.top;
    handle.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => { el.style.left = `${Math.max(0, ev.clientX - x0)}px`; el.style.top = `${Math.max(0, ev.clientY - y0)}px`; el.style.right = 'auto'; };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', () => handle.removeEventListener('pointermove', move), { once: true });
  });
}

/** Ends a plugin's page (turned off, removed or updated). */
export function closeFrame(id: string) {
  const f = frames.get(id);
  if (!f) return;
  f.wrap.remove();
  frames.delete(id);
}

/** Runs one of a plugin's commands. */
export async function runPluginCommand(id: string, command: string) {
  const p = installedPlugins().find((x) => x.manifest.id === id && x.enabled);
  if (!p) return;
  const f = frameFor(p);
  await f.ready;
  f.iframe.contentWindow?.postMessage({ pixl: 1, type: 'command', id: command }, '*');
}

export function openPluginPanel(id: string) {
  const p = installedPlugins().find((x) => x.manifest.id === id && x.enabled);
  if (!p) return;
  frameFor(p).wrap.classList.remove('away');
}

// ---------- Pixl asking a plugin: file formats ----------

const requests = new Map<number, { frame: Frame; res: (v: unknown) => void; rej: (e: Error) => void }>();
let reqSeq = 0;

/** Asks a plugin's script something (open or export), with a minute to answer. */
async function request(p: InstalledPlugin, kind: 'open' | 'export', target: string, payload: Record<string, unknown>): Promise<unknown> {
  const f = frameFor(p);
  await f.ready;
  return new Promise((res, rej) => {
    const id = ++reqSeq;
    requests.set(id, { frame: f, res, rej });
    setTimeout(() => { if (requests.delete(id)) rej(new Error(`${p.manifest.name} didn't answer within a minute`)); }, 60000);
    f.iframe.contentWindow?.postMessage({ pixl: 1, type: 'request', id, kind, target, ...payload }, '*');
  });
}

/** The enabled plugin formats, each with its plugin. */
export function pluginFormats() {
  return installedPlugins().filter((p) => p.enabled && p.manifest.main).flatMap((p) => (p.manifest.formats ?? []).map((f) => ({ p, f })));
}

/** The file extension of a plugin export format ("plugin:<id>:<format>"): its first. */
export const pluginFormatExt = (format: string) => {
  const [, pid, fid] = format.split(':');
  return pluginFormats().find(({ p, f }) => p.manifest.id === pid && f.id === fid)?.f.extensions[0] ?? 'bin';
};

/** A plugin that opens files ending in `.ext`, if one is installed. */
export const formatOpening = (ext: string) => pluginFormats().find(({ f }) => f.open && f.extensions.includes(ext));

/**
 * Opens a file through the plugin whose format it is: its script gets the bytes and gives back the picture as layers
 * ({ width, height, layers: [{ name, image, x, y }] }), which become an image here.
 */
export async function openWithPlugin(file: File): Promise<Doc> {
  const ext = file.name.split('.').pop()!.toLowerCase(), fm = formatOpening(ext)!;
  const v = await request(fm.p, 'open', fm.f.id, { bytes: new Uint8Array(await file.arrayBuffer()), name: file.name }) as
    { width?: number; height?: number; layers?: { name?: string; image?: ImageData; x?: number; y?: number }[] } | null;
  const w = Math.round(Number(v?.width)), hh = Math.round(Number(v?.height));
  if (!v || !(w > 0 && hh > 0) || !Array.isArray(v.layers) || !v.layers.length) throw new Error(`${fm.p.manifest.name} gave back no picture (it should return width, height and layers)`);
  const doc = new Doc(file.name, w, hh);
  for (const [i, l] of v.layers.entries()) {
    if (!(l?.image instanceof ImageData)) throw new Error(`${fm.p.manifest.name}: layer ${i + 1} has no image`);
    const c = newCanvas(l.image.width, l.image.height);
    ctx2d(c).putImageData(l.image, 0, 0);
    doc.layers.push({ id: newId(), type: 'raster', name: String(l.name ?? `Layer ${i + 1}`).slice(0, 60), visible: true, opacity: 1, blend: 'normal', key: doc.addCanvas(c),
      t: { x: Math.round(Number(l.x) || 0), y: Math.round(Number(l.y) || 0), sx: 1, sy: 1, rot: 0 } });
  }
  doc.activeId = doc.layers[doc.layers.length - 1].id;
  doc.resetHistory('Open');
  return doc;
}

/** Exports the picture through a plugin format ("plugin:<id>:<format>"): its script turns the pixels into the file. */
export async function exportWithPlugin(format: string, picture: HTMLCanvasElement): Promise<Blob> {
  const [, pid, fid] = format.split(':');
  const fm = pluginFormats().find(({ p, f }) => p.manifest.id === pid && f.id === fid && f.export);
  if (!fm) throw new Error('that plugin format isn\'t installed');
  const image = ctx2d(picture, true).getImageData(0, 0, picture.width, picture.height);
  const out = await request(fm.p, 'export', fid, { image: { width: image.width, height: image.height, data: image.data } });
  if (!(out instanceof Uint8Array) && !(out instanceof ArrayBuffer)) throw new Error(`${fm.p.manifest.name} gave back no file (it should return bytes)`);
  return new Blob([out as BlobPart]);
}

// ---------- plugin tools ----------

/**
 * A plugin's tool: while it's chosen, presses, drags and letting go on the canvas go to the plugin's script (canvas
 * position, pressure, modifier keys); moves are sent at most once a frame. What the tool does, it does through the API.
 */
class PluginTool implements Tool {
  id: string; name: string; key = ''; icon = 'plugin' as const; hint: string;
  private pressed = false;
  private pending: PInfo | null = null;
  constructor(private p: InstalledPlugin, private t: { id: string; name: string; hint: string }) {
    this.id = `plugin:${p.manifest.id}:${t.id}`; this.name = t.name; this.hint = t.hint || `${t.name} (from the plugin ${p.manifest.name})`;
  }
  cursor() { return 'crosshair'; }
  private send(event: 'down' | 'move' | 'up', q: PInfo) {
    const f = frameFor(this.p);
    void f.ready.then(() => f.iframe.contentWindow?.postMessage({ pixl: 1, type: 'tool', id: this.t.id, event,
      point: { x: q.x, y: q.y, pressure: q.pressure, shift: q.shift, alt: q.alt, ctrl: q.ctrl } }, '*'));
  }
  down(q: PInfo) { this.pressed = true; this.send('down', q); }
  move(q: PInfo) {
    if (!this.pressed) return;
    if (!this.pending) requestAnimationFrame(() => { if (this.pending && this.pressed) this.send('move', this.pending); this.pending = null; });
    this.pending = q;
  }
  up(q: PInfo) { if (!this.pressed) return; this.pressed = false; this.pending = null; this.send('up', q); }
  cancel() { this.pressed = false; this.pending = null; }
}

/** Puts the enabled plugins' tools in the toolbox (after Pixl's own), and takes away those that are gone. */
export function refreshPluginTools() {
  const own = app.tools.filter((t) => !t.id.startsWith('plugin:'));
  const add = installedPlugins().filter((p) => p.enabled && p.manifest.main).flatMap((p) => (p.manifest.tools ?? []).map((t) => new PluginTool(p, t)));
  app.tools = [...own, ...add];
  if (app.tool?.id.startsWith('plugin:') && !add.some((t) => t.id === app.tool.id)) app.setTool('move');
  app.setPrefs({});
}

/** Filter › Plugins: each script plugin's commands, and its panel. */
export function pluginCommandItems(): MenuItem[] {
  const out: MenuItem[] = [];
  for (const p of installedPlugins()) {
    if (!p.enabled || !p.manifest.main) continue;
    for (const c of p.manifest.commands ?? []) out.push({ label: c.label, disabled: !app.doc, onClick: () => { void runPluginCommand(p.manifest.id, c.id); } });
    if (p.manifest.panel) out.push({ label: `${p.manifest.panel.title} panel`, onClick: () => openPluginPanel(p.manifest.id) });
  }
  return out;
}

// ---------- the API ----------

const need = (p: InstalledPlugin, perm: string) => {
  if (!p.manifest.permissions.includes(perm)) throw new Error(`this plugin needs the "${perm}" permission (to ${PERMISSIONS[perm]})`);
};
const theDoc = () => { const d = app.doc; if (!d) throw new Error('no image is open'); return d; };
const rasterOf = (id: unknown): RasterLayer => {
  const l = theDoc().layer(String(id ?? theDoc().activeId));
  if (!l || l.type !== 'raster') throw new Error('that isn\'t an image layer');
  return l;
};

/** Pixl's own commands a plugin with the "commands" permission may run, by name. */
const COMMANDS: Record<string, (args: Record<string, unknown>) => unknown> = {
  newLayer: () => A.newLayer(), newGroup: () => A.newGroup(), duplicateLayer: () => A.duplicateLayer(), deleteLayer: () => A.deleteLayer(),
  mergeDown: () => A.mergeDown(), flatten: () => A.flattenImage(), selectAll: () => A.selectAll(), deselect: () => A.deselect(), invertSelection: () => A.invertSelection(),
  fill: (a) => A.fillWith(a.with === 'bg' ? 'bg' : 'fg'), undo: () => A.undo(), redo: () => A.redo(),
  // An effect (built in or a plugin's) applied to the selected layer, with its settings: "gblur", { radius: 4 }.
  filter: (a) => applyEffect(String(a.kind), (a.settings ?? {}) as Record<string, number | string | boolean>),
  selectLayer: (a) => { const d = theDoc(); if (!d.layer(String(a.id))) throw new Error('there\'s no such layer'); d.setActive(String(a.id)); d.touch('meta'); },
};

async function handle(p: InstalledPlugin, method: string, a: Record<string, unknown>): Promise<unknown> {
  const name = p.manifest.name;
  switch (method) {
    case 'image': {
      const d = theDoc();
      return { name: d.name, width: d.width, height: d.height, activeLayer: d.activeId, selection: !!d.selection,
        layers: flatLayers(d.layers).map((l) => ({ id: l.id, name: l.name, type: l.type, visible: l.visible, opacity: l.opacity, blend: l.blend })) };
    }
    case 'pixels': {
      need(p, 'pixels:read');
      const l = rasterOf(a.layerId), c = theDoc().canvasOf(l);
      const r = a.rect as { x: number; y: number; width: number; height: number } | undefined;
      const x = Math.max(0, Math.round(r?.x ?? 0)), y = Math.max(0, Math.round(r?.y ?? 0));
      const w = Math.min(c.width - x, Math.round(r?.width ?? c.width)), hh = Math.min(c.height - y, Math.round(r?.height ?? c.height));
      if (w <= 0 || hh <= 0) return null;
      const im = ctx2d(c, true).getImageData(x, y, w, hh);
      return { width: w, height: hh, data: im.data, x, y };
    }
    case 'setPixels': {
      need(p, 'pixels:write');
      const d = theDoc(), l = rasterOf(a.layerId);
      if (l.warp || l.model) throw new Error('that layer is warped or 3D: apply or rasterize it first');
      const c = d.canvasOf(l), w = Number(a.width), hh = Number(a.height), data = a.data as Uint8ClampedArray;
      if (!(data instanceof Uint8ClampedArray) || data.length !== w * hh * 4) throw new Error('setPixels needs an ImageData (or width, height and RGBA data)');
      const x = Math.round(Number(a.x) || 0), y = Math.round(Number(a.y) || 0);
      const r = { x: Math.max(0, x), y: Math.max(0, y), w: 0, h: 0 };
      r.w = Math.min(c.width, x + w) - r.x; r.h = Math.min(c.height, y + hh) - r.y;
      if (r.w <= 0 || r.h <= 0) return false;
      const before = cropCanvas(c, r);
      ctx2d(c).putImageData(new ImageData(data as Uint8ClampedArray<ArrayBuffer>, w, hh), x, y);
      d.markPixels(l.key);
      d.commit(`${name}: ${String(a.label ?? 'change pixels').slice(0, 60)}`, [{ key: l.key, rect: r, before, after: null }]);
      return true;
    }
    case 'setLayer': {
      // A layer's name, eye, opacity and blend mode (the layers panel's own settings), as one undo step.
      need(p, 'pixels:write');
      const d = theDoc(), id = String(a.layerId), q = (a.props ?? {}) as Record<string, unknown>;
      if (!d.layer(id)) throw new Error('there\'s no such layer');
      const patch: Partial<Pick<Layer, 'name' | 'visible' | 'opacity' | 'blend'>> = {};
      if (q.name !== undefined) patch.name = String(q.name).slice(0, 60);
      if (q.visible !== undefined) patch.visible = !!q.visible;
      if (q.opacity !== undefined) patch.opacity = Math.max(0, Math.min(1, Number(q.opacity) || 0));
      if (q.blend !== undefined) {
        if (!BLEND_MODES.some(([b]) => b === q.blend)) throw new Error(`there's no blend mode "${q.blend}" (try: ${BLEND_MODES.map(([b]) => b).join(', ')})`);
        patch.blend = q.blend as BlendMode;
      }
      A.setLayerProp(id, patch, `${name}: layer settings`);
      return true;
    }
    case 'addLayer': {
      need(p, 'pixels:write');
      const d = theDoc(), l = d.newRasterLayer(String(a.name ?? name).slice(0, 60));
      if (a.data instanceof Uint8ClampedArray && Number(a.width) * Number(a.height) * 4 === a.data.length) {
        const im = new ImageData(a.data as Uint8ClampedArray<ArrayBuffer>, Number(a.width), Number(a.height));
        const c = newCanvas(Math.max(d.width, im.width), Math.max(d.height, im.height));
        ctx2d(c).putImageData(im, 0, 0);
        l.key = d.addCanvas(c);
      }
      d.insertLayer(l);
      d.commit(`${name}: add layer`);
      return l.id;
    }
    case 'selection': {
      need(p, 'pixels:read');
      const m = theDoc().selectionMask();
      return m ? { width: m.width, height: m.height, data: ctx2d(m, true).getImageData(0, 0, m.width, m.height).data } : null;
    }
    case 'run': {
      need(p, 'commands');
      const f = COMMANDS[String(a.command)];
      if (!f) throw new Error(`there's no command "${a.command}" (try: ${Object.keys(COMMANDS).join(', ')})`);
      theDoc();
      await f((a.args ?? {}) as Record<string, unknown>);
      return true;
    }
    case 'toast': toast(`${name}: ${String(a.text).slice(0, 200)}`); return true;
    case 'colors': return { fg: app.fg, bg: app.bg };
    case 'setColors': {
      const ok = (v: unknown) => typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v);
      if (ok(a.fg)) app.setColor('fg', String(a.fg));
      if (ok(a.bg)) app.setColor('bg', String(a.bg));
      return true;
    }
    default: throw new Error(`there's no "${method}" in Pixl's plugin API`);
  }
}

window.addEventListener('message', (e) => {
  const f = [...frames.values()].find((x) => x.iframe.contentWindow === e.source);
  const m = e.data as { pixl?: number; type?: string; id?: number; method?: string; args?: Record<string, unknown>; what?: string; error?: string } | null;
  if (!f || !m || m.pixl !== 1) return;
  if (m.type === 'ready') { f.onReady(); return; }
  if (m.type === 'failed') { toast(`${f.p.manifest.name}: ${m.what} failed: ${m.error}`, 'error'); return; }
  if (m.type === 'response') {
    const w = requests.get(Number(m.id));
    if (!w || w.frame !== f) return;
    requests.delete(Number(m.id));
    const r = m as unknown as { ok: boolean; value?: unknown; error?: string };
    if (r.ok) w.res(r.value); else w.rej(new Error(r.error));
    return;
  }
  if (m.type !== 'call') return;
  const reply = (ok: boolean, value: unknown) => f.iframe.contentWindow?.postMessage({ pixl: 1, type: 'result', id: m.id, ok, ...(ok ? { value } : { error: String(value) }) }, '*');
  handle(f.p, String(m.method), m.args ?? {}).then((v) => reply(true, v), (err) => reply(false, (err as Error)?.message ?? err));
});
