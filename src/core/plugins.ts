import { FX_DEFS, hex3, type FxDef, type FxParam, type FxValue } from './effects';
import { setSetting } from './settings';
import { unzip } from './unzip';

/**
 * Plugins, installed per user from a .pixlplugin file: a zip holding plugin.json (or plugin.json on its own). This
 * version takes effect plugins: GPU shaders with settings, which become effects like the built-in ones (Filter ›
 * Plugins, and editable effect layers). A shader runs in the graphics card's own sandbox, with no access to files.
 * Kept with the other settings (mirrored to the settings file), so updates keep them.
 */

/** The plugin API version this Pixl speaks; a plugin says which it needs ("pixl"). */
export const PLUGIN_API = 1;
/**
 * Permissions a script plugin may ask for, and what each lets it do (shown when installing). Shaders need none; a
 * script with none can still show its panel, read the image's size and layer list, and show messages.
 */
export const PERMISSIONS: Record<string, string> = {
  'pixels:read': 'see the pixels of your layers and the selection',
  'pixels:write': 'change layers and add new ones (each change is a step you can undo)',
  commands: 'run Pixl\'s own commands (filters, new layers, selections, undo)',
};

export interface PluginEffect {
  kind: string; label: string; params: FxParam[]; glsl: string;
  /** How far (document pixels) it reads around each pixel: a number, the key of a setting that says, or "anywhere". */
  margin?: number | string;
  /** Uses the random seed ("New variation"; re-rolls when animated), or moves with time (uTime) when animated. */
  seeded?: boolean; moves?: boolean;
}
export interface PluginManifest {
  id: string; name: string; version: string; author: string; description: string; pixl: number; permissions: string[]; effects: PluginEffect[];
  /** A script plugin's code (from its "main" file), run in a sandbox (core/pluginhost.ts). */
  main?: string;
  /** Commands it adds (Filter › Plugins), handled by its script. */
  commands: { id: string; label: string }[];
  /** A panel of its own, showing its script's page. */
  panel?: { title: string; width: number; height: number };
}
export interface InstalledPlugin { manifest: PluginManifest; enabled: boolean; installed: number }

const KEY = 'amxpixl.plugins';
let installed: InstalledPlugin[] = (() => {
  try { return (JSON.parse(localStorage.getItem(KEY) || '[]') as InstalledPlugin[]).filter((p) => p?.manifest?.id); } catch { return []; }
})();

export const installedPlugins = (): readonly InstalledPlugin[] => installed;
export const effectKind = (pluginId: string, kind: string) => `plugin:${pluginId}:${kind}`;
/** The plugin an effect kind comes from ("plugin:<id>:<kind>"), or null for a built-in one. */
export const pluginOfKind = (kind: string) => (kind.startsWith('plugin:') ? kind.slice(7, kind.lastIndexOf(':')) : null);

// ---------- reading a plugin file ----------

/** Reads a .pixlplugin into a checked manifest, its shader files read in. Throws, saying what's wrong. */
export async function readPlugin(file: Blob): Promise<PluginManifest> {
  const buf = await file.arrayBuffer(), b = new Uint8Array(buf);
  let files = new Map<string, Uint8Array>(), base = '', json: string;
  if (b[0] === 0x50 && b[1] === 0x4b) {
    files = await unzip(buf);
    // plugin.json at the top, or in the one folder the zip holds.
    const at = files.has('plugin.json') ? 'plugin.json' : [...files.keys()].find((k) => /^[^/]+\/plugin\.json$/.test(k));
    if (!at) throw new Error('there\'s no plugin.json in it');
    base = at.slice(0, at.length - 'plugin.json'.length);
    json = new TextDecoder().decode(files.get(at));
  } else json = new TextDecoder().decode(b);
  let raw: unknown;
  try { raw = JSON.parse(json); } catch { throw new Error('its plugin.json isn\'t valid JSON'); }
  return check(raw, (path) => { const f = files.get(base + path.replace(/^\.?\//, '')); return f ? new TextDecoder().decode(f) : null; });
}

const str = (v: unknown, max: number) => typeof v === 'string' && v.trim() && v.length <= max ? v.trim() : null;
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function check(raw: unknown, readFile: (path: string) => string | null): PluginManifest {
  const m = raw as Record<string, unknown>;
  if (!m || typeof m !== 'object') throw new Error('its plugin.json isn\'t an object');
  const id = str(m.id, 64);
  if (!id || !/^[a-z0-9][a-z0-9.-]*$/i.test(id)) throw new Error('it needs an "id" of letters, digits, dots and dashes (like "com.example.duotone")');
  const name = str(m.name, 60);
  if (!name) throw new Error('it needs a "name"');
  const version = str(m.version, 20) ?? '1.0';
  const pixl = num(m.pixl) ?? 1;
  if (pixl > PLUGIN_API) throw new Error(`it needs a newer Pixl (plugin version ${pixl}; this Pixl takes ${PLUGIN_API})`);
  const permissions = [...new Set(Array.isArray(m.permissions) ? m.permissions.map(String) : [])];
  const unknown = permissions.filter((p) => !(p in PERMISSIONS));
  if (unknown.length) throw new Error(`it asks for ${unknown.map((p) => `"${p}"`).join(', ')}, which this version of Pixl can't give plugins`);
  const effects = (Array.isArray(m.effects) ? m.effects : []).map((e, i) => checkEffect(e as Record<string, unknown>, i, readFile));
  if (effects.length > 64) throw new Error('it has more than 64 effects');
  const kinds = new Set<string>();
  for (const e of effects) { if (kinds.has(e.kind)) throw new Error(`two effects are called "${e.kind}"`); kinds.add(e.kind); }
  // A script: its code, the commands it handles and its panel.
  const main = typeof m.main === 'string' ? readFile(m.main) : null;
  if (typeof m.main === 'string' && main === null) throw new Error(`its "main" file "${m.main}" isn't in the plugin`);
  if (main && main.length > 524288) throw new Error('its script is over 512 KB');
  const commands = (Array.isArray(m.commands) ? m.commands : []).map((c, i) => {
    const cid = str((c as Record<string, unknown>)?.id, 40);
    if (!cid || !/^[a-z0-9][a-z0-9-]*$/.test(cid)) throw new Error(`command ${i + 1} needs an "id" of lowercase letters, digits and dashes`);
    return { id: cid, label: str((c as Record<string, unknown>).label, 40) ?? cid };
  });
  const pw = m.panel as Record<string, unknown> | undefined;
  const panel = pw && typeof pw === 'object' ? { title: str(pw.title, 40) ?? name, width: Math.min(900, Math.max(200, num(pw.width) ?? 320)), height: Math.min(900, Math.max(120, num(pw.height) ?? 360)) } : undefined;
  if ((commands.length || panel) && !main) throw new Error('it has commands or a panel but no "main" script to run them');
  if (!effects.length && !main) throw new Error('it has nothing Pixl can use: no effects and no script');
  return { id, name, version, author: str(m.author, 80) ?? '', description: str(m.description, 400) ?? '', pixl, permissions, effects, ...(main ? { main } : {}), commands, ...(panel ? { panel } : {}) };
}

function checkEffect(e: Record<string, unknown>, i: number, readFile: (path: string) => string | null): PluginEffect {
  const at = `effect ${i + 1}`;
  if (!e || typeof e !== 'object') throw new Error(`${at} isn't an object`);
  const kind = str(e.kind, 40);
  if (!kind || !/^[a-z0-9][a-z0-9-]*$/.test(kind)) throw new Error(`${at} needs a "kind" of lowercase letters, digits and dashes`);
  const label = str(e.label, 40) ?? kind;
  const glsl = typeof e.glsl === 'string' ? e.glsl : typeof e.glslFile === 'string' ? readFile(e.glslFile) : null;
  if (!glsl) throw new Error(`"${kind}" needs its shader: "glsl" (the code) or "glslFile" (a file in the plugin)`);
  if (glsl.length > 65536) throw new Error(`"${kind}"'s shader is over 64 KB`);
  if (!/vec4\s+fx\s*\(/.test(glsl)) throw new Error(`"${kind}"'s shader needs a function "vec4 fx(vec2 p, vec2 d)"`);
  const params = (Array.isArray(e.params) ? e.params : []).map((p, j) => checkParam(p as Record<string, unknown>, `${kind}, setting ${j + 1}`));
  const margin = e.margin === 'anywhere' ? Infinity : num(e.margin) ?? (typeof e.margin === 'string' && params.some((p) => p.key === e.margin) ? e.margin : undefined);
  return { kind, label, params, glsl, margin, seeded: e.seeded === true, moves: e.moves === true };
}

function checkParam(p: Record<string, unknown>, at: string): FxParam {
  const key = str(p?.key, 30);
  // (Keys become GLSL names: u_<key>.)
  if (!key || !/^[a-z][a-z0-9_]*$/i.test(key)) throw new Error(`${at} needs a "key" of letters, digits and _ starting with a letter`);
  const label = str(p.label, 40) ?? key;
  switch (p.type) {
    case 'range': {
      const min = num(p.min) ?? 0, max = num(p.max) ?? 100;
      if (max <= min) throw new Error(`${at}: "max" must be more than "min"`);
      const value = Math.min(max, Math.max(min, num(p.value) ?? min));
      return { key, label, type: 'range', min, max, step: num(p.step) ?? undefined, value, unit: str(p.unit, 8) ?? undefined };
    }
    case 'bool': return { key, label, type: 'bool', value: p.value === true };
    case 'color': {
      const value = typeof p.value === 'string' && /^#[0-9a-f]{6}$/i.test(p.value) ? p.value : '#ffffff';
      return { key, label, type: 'color', value };
    }
    case 'select': {
      const options = Array.isArray(p.options) ? p.options.map((o) => (Array.isArray(o) ? [String(o[0]), String(o[1] ?? o[0])] : [String(o), String(o)]) as [string, string]) : [];
      if (options.length < 2) throw new Error(`${at}: a "select" needs at least two "options"`);
      const value = options.some(([v]) => v === p.value) ? String(p.value) : options[0][0];
      return { key, label, type: 'select', value, options };
    }
    default: throw new Error(`${at}: "type" must be "range", "bool", "color" or "select"`);
  }
}

// ---------- effects ----------

/** A plugin effect as an effect definition: each setting is a uniform of its own (u_<key>), declared for it. */
export function pluginFx(id: string, e: PluginEffect): FxDef {
  const decls = e.params.map((p) => `uniform ${p.type === 'color' ? 'vec3' : 'float'} u_${p.key};`).join('\n');
  const value = (p: FxParam, v: FxValue | undefined): number[] => {
    const x = v ?? p.value;
    if (p.type === 'color') return hex3(x);
    if (p.type === 'bool') return [x ? 1 : 0];
    if (p.type === 'select') return [Math.max(0, p.options.findIndex(([o]) => o === x))];
    return [Number(x)];
  };
  return {
    kind: effectKind(id, e.kind), label: e.label, group: 'Plugins', plugin: id, params: e.params, seeded: e.seeded, moves: e.moves,
    margin: e.margin === undefined ? undefined : (v) => (typeof e.margin === 'number' ? e.margin : Number(v[e.margin as string]) || 0),
    uniforms: (v) => Object.fromEntries(e.params.map((p) => [`u_${p.key}`, value(p, v[p.key])])) as never,
    glsl: `${decls}\n${e.glsl}`,
  };
}

/** Puts the enabled plugins' effects into the effect list (and takes the others out). */
export function registerPlugins() {
  for (let i = FX_DEFS.length - 1; i >= 0; i--) if (FX_DEFS[i].plugin) FX_DEFS.splice(i, 1);
  for (const p of installed) if (p.enabled) for (const e of p.manifest.effects) FX_DEFS.push(pluginFx(p.manifest.id, e));
}

const save = () => { try { setSetting(KEY, JSON.stringify(installed)); } catch { /* storage full: kept for this session */ } };

/** Installs a plugin (replacing one with the same id) and turns it on. */
export function installPlugin(m: PluginManifest) {
  installed = [...installed.filter((p) => p.manifest.id !== m.id), { manifest: m, enabled: true, installed: Date.now() }];
  save(); registerPlugins();
}

export function removePlugin(id: string) { installed = installed.filter((p) => p.manifest.id !== id); save(); registerPlugins(); }

export function setPluginEnabled(id: string, on: boolean) {
  installed = installed.map((p) => (p.manifest.id === id ? { ...p, enabled: on } : p));
  save(); registerPlugins();
}
