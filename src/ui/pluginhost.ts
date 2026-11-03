import { app } from '../app';
import * as A from '../actions';
import { flatLayers } from '../core/document';
import { cropCanvas, ctx2d, newCanvas } from '../core/layers';
import { installedPlugins, PERMISSIONS, type InstalledPlugin } from '../core/plugins';
import type { RasterLayer } from '../core/types';
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
  let seq = 0; const waiting = new Map(), commands = new Map();
  const call = (method, args) => new Promise((res, rej) => { const id = ++seq; waiting.set(id, { res, rej }); parent.postMessage({ pixl: 1, type: 'call', id, method, args }, '*'); });
  const img = (v) => v && new ImageData(v.data, v.width, v.height);
  addEventListener('message', async (e) => {
    const m = e.data; if (e.source !== parent || !m || m.pixl !== 1) return;
    if (m.type === 'result') { const w = waiting.get(m.id); if (!w) return; waiting.delete(m.id); if (m.ok) w.res(m.value); else w.rej(new Error(m.error)); }
    if (m.type === 'command') {
      const f = commands.get(m.id);
      try { if (!f) throw new Error('nothing handles "' + m.id + '"'); await f(); }
      catch (err) { parent.postMessage({ pixl: 1, type: 'failed', command: m.id, error: String((err && err.message) || err) }, '*'); }
    }
  });
  window.pixl = Object.freeze({
    onCommand: (id, f) => { commands.set(id, f); },
    image: () => call('image'),
    pixels: async (layerId, rect) => { const v = await call('pixels', { layerId, rect }); return v && Object.assign(img(v), { x: v.x, y: v.y }); },
    setPixels: (layerId, image, x = 0, y = 0, label) => call('setPixels', { layerId, x, y, width: image.width, height: image.height, data: image.data, label }),
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
  const m = e.data as { pixl?: number; type?: string; id?: number; method?: string; args?: Record<string, unknown>; command?: string; error?: string } | null;
  if (!f || !m || m.pixl !== 1) return;
  if (m.type === 'ready') { f.onReady(); return; }
  if (m.type === 'failed') { toast(`${f.p.manifest.name}: ${m.command} failed: ${m.error}`, 'error'); return; }
  if (m.type !== 'call') return;
  const reply = (ok: boolean, value: unknown) => f.iframe.contentWindow?.postMessage({ pixl: 1, type: 'result', id: m.id, ok, ...(ok ? { value } : { error: String(value) }) }, '*');
  handle(f.p, String(m.method), m.args ?? {}).then((v) => reply(true, v), (err) => reply(false, (err as Error)?.message ?? err));
});
