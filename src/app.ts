import type { ChangeKind, Doc } from './core/document';
import type { Tool } from './tools/tool';
import { setSetting } from './core/settings';

type Events = {
  docs: void;
  change: { doc: Doc; kind: ChangeKind };
  view: void;
  tool: void;
  colors: void;
  options: void;
  prefs: void;
  recent: void;
  /** The animation frame shown changed (or playback started/stopped). */
  frame: void;
};

type Handler<T> = (v: T) => void;

export interface Prefs {
  theme: 'dark' | 'light'; glow: boolean; dock: Record<string, boolean>; rulers: boolean; guides: boolean; snap: boolean; pixelGrid: boolean; onion: boolean;
  /** Toolbox columns (drag its edge wider for a grid) and whether each tool shows its name. */
  toolCols: number; toolLabels: boolean;
  /** Tools that share one toolbox slot (tool ids), and where the tool options are shown. */
  toolGroups: string[][]; optionsDock: 'top' | 'side';
  /** Readouts in the status bar (View › Status Bar); missing in settings saved before they existed. */
  meters?: Meter[];
  /** Drawing tablet settings (Edit › Pen Tablet), shared by every painting tool. */
  tablet: Tablet;
}

/**
 * How a drawing tablet's pen behaves. `curve`: how pressure feels (soft = light touches count for more). `min`: the
 * smallest a pressure-sized dab gets, as a fraction of the brush size. `eraser`: the pen's eraser end erases.
 * `side`: what the pen's side button does while touching. `smooth`: how much brush strokes are steadied (0-3).
 */
export interface Tablet { curve: 'soft' | 'normal' | 'firm'; min: number; eraser: boolean; side: 'pan' | 'pick' | 'none'; smooth: number }
export const DEFAULT_TABLET: Tablet = { curve: 'normal', min: 0.1, eraser: true, side: 'pan', smooth: 0 };
/** The pen's raw pressure (0-1) through the chosen feel: soft makes light touches count for more, firm for less. */
export function feltPressure(raw: number, t: Tablet): number {
  return t.curve === 'soft' ? Math.pow(raw, 0.6) : t.curve === 'firm' ? Math.pow(raw, 1.6) : raw;
}
/** What pen pressure changes on a painting tool: its size, its opacity (or strength), or both. */
export type PressureTo = 'size' | 'opacity' | 'both';

/** A status bar readout: GPU, processor or memory use, by Pixl or the whole PC. */
export type Meter = 'gpu' | 'gpuPc' | 'cpu' | 'cpuPc' | 'mem' | 'memPc';
/** What the status bar shows unless changed: how busy the GPU is with Pixl's work. */
export const DEFAULT_METERS: Meter[] = ['gpu'];

const load = <T>(k: string, d: T): T => {
  try { const v = localStorage.getItem(k); return v ? { ...d, ...JSON.parse(v) } : d; } catch { return d; }
};
const store = (k: string, v: unknown) => { try { setSetting(k, JSON.stringify(v)); } catch { /* storage unavailable */ } };

export const DEFAULT_OPTS = {
  brush: { size: 24, hardness: 0.8, opacity: 1, flow: 1, pressure: true, pressureTo: 'size' as PressureTo, antiAlias: true, tip: 'round', spacing: 12, jitter: 0, scatter: 0 },
  eraser: { size: 40, hardness: 0.8, opacity: 1, flow: 1, pressure: false, pressureTo: 'size' as PressureTo, antiAlias: true, tip: 'round', spacing: 12, jitter: 0, scatter: 0 },
  select: { antiAlias: true },
  /**
   * Symmetry painting, shared by the Brush, Eraser and retouch tools: mirrored across a vertical and/or horizontal
   * line, or turned around a point into `spokes` copies. The centre is a fraction of the canvas (0.5 = the middle).
   */
  symmetry: { mode: 'off' as 'off' | 'v' | 'h' | 'both' | 'radial', spokes: 6, cx: 0.5, cy: 0.5 },
  pen: { mode: 'pen' as 'pen' | 'freehand', smooth: 50 },
  dodge: { size: 60, hardness: 0.3, strength: 0.35, range: 1, pressure: false, pressureTo: 'size' as PressureTo },
  burn: { size: 60, hardness: 0.3, strength: 0.35, range: 1, pressure: false, pressureTo: 'size' as PressureTo },
  blur: { size: 40, hardness: 0.5, strength: 0.7, range: 1, pressure: false, pressureTo: 'size' as PressureTo },
  sharpen: { size: 40, hardness: 0.5, strength: 0.4, range: 1, pressure: false, pressureTo: 'size' as PressureTo },
  smudge: { size: 30, hardness: 0.5, strength: 0.6, range: 1, pressure: false, pressureTo: 'size' as PressureTo },
  clone: { size: 40, hardness: 0.6, opacity: 1, flow: 1, pressure: false, pressureTo: 'size' as PressureTo, aligned: true, sampleAll: false },
  heal: { size: 40, hardness: 0.5, opacity: 1, flow: 1, pressure: false, pressureTo: 'size' as PressureTo, aligned: true, sampleAll: false },
  wand: { tolerance: 32, contiguous: true, sampleAll: true, antiAlias: true },
  fill: { tolerance: 32, contiguous: true, opacity: 1 },
  gradient: { kind: 'linear' as 'linear' | 'radial', toTransparent: false, opacity: 1 },
  text: { font: 'Segoe UI', size: 64, weight: 400, italic: false, align: 'left' as 'left' | 'center' | 'right', antiAlias: true },
  shape: { kind: 'rect' as 'rect' | 'ellipse' | 'line' | 'polygon' | 'star', fill: true, stroke: false, strokeWidth: 4, radius: 0, antiAlias: true, sides: 6, inner: 0.45 },
  move: { autoSelect: false, mode: 'transform' as 'transform' | 'perspective' | 'warp' | 'rotate3d', box: 'content' as 'content' | 'layer' | 'custom' },
  picker: { sample: 1 },
};
export type ToolOpts = typeof DEFAULT_OPTS;

class App {
  docs: Doc[] = [];
  doc: Doc | null = null;
  fg = '#000000';
  bg = '#ffffff';
  recent: string[] = [];
  tool!: Tool;
  tools: Tool[] = [];
  opts: ToolOpts = structuredClone(DEFAULT_OPTS);
  prefs: Prefs = load<Prefs>('amxpixl.prefs', { theme: 'dark', glow: false, dock: { color: true, properties: true, layers: true, history: false }, rulers: false, guides: true, snap: true, pixelGrid: true, onion: false, toolCols: 1, toolLabels: false, toolGroups: [], optionsDock: 'top', tablet: DEFAULT_TABLET });
  /** Set while a modal filter preview or text edit owns the canvas. */
  busy = false;
  /** An animation is playing in the Timeline. */
  playing = false;
  /** View › Depth Map: the canvas shows the depth map instead of the picture. */
  showDepth = false;

  private handlers = new Map<keyof Events, Set<Handler<never>>>();

  constructor() {
    const saved = load<Partial<ToolOpts>>('amxpixl.opts', {});
    for (const k of Object.keys(DEFAULT_OPTS) as (keyof ToolOpts)[]) {
      if (saved[k]) Object.assign(this.opts[k], saved[k]);
    }
    const colors = load('amxpixl.colors', { fg: '#000000', bg: '#ffffff', recent: [] as string[] });
    this.fg = colors.fg; this.bg = colors.bg; this.recent = colors.recent;
  }

  on<K extends keyof Events>(k: K, f: Handler<Events[K]>) {
    if (!this.handlers.has(k)) this.handlers.set(k, new Set());
    this.handlers.get(k)!.add(f as Handler<never>);
    return () => this.handlers.get(k)!.delete(f as Handler<never>);
  }

  emit<K extends keyof Events>(k: K, ...v: Events[K] extends void ? [] : [Events[K]]) {
    this.handlers.get(k)?.forEach((f) => (f as Handler<unknown>)(v[0]));
  }

  // ---------- documents ----------

  addDoc(d: Doc) {
    d.onChange = (doc, kind) => this.emit('change', { doc, kind });
    this.docs.push(d);
    this.setDoc(d);
  }

  setDoc(d: Doc | null) {
    this.tool?.deactivate?.();
    this.doc = d;
    this.emit('docs');
    this.tool?.activate?.();
  }

  removeDoc(d: Doc) {
    const i = this.docs.indexOf(d);
    if (i < 0) return;
    this.docs.splice(i, 1);
    if (this.doc === d) this.setDoc(this.docs[Math.min(i, this.docs.length - 1)] ?? null);
    else this.emit('docs');
  }

  // ---------- tools / colours / prefs ----------

  setTool(id: string) {
    const t = this.tools.find((x) => x.id === id);
    if (!t || t === this.tool) return;
    this.tool?.deactivate?.();
    this.tool = t;
    t.activate?.();
    this.emit('tool');
  }

  setColor(which: 'fg' | 'bg', hex: string) {
    this[which] = hex.toLowerCase();
    this.saveColors();
    this.emit('colors');
  }

  /** Remembers a colour that was actually used for painting. */
  useColor(hex: string) {
    this.recent = [hex, ...this.recent.filter((c) => c !== hex)].slice(0, 12);
    this.saveColors();
    this.emit('colors');
  }

  private saveColors() { store('amxpixl.colors', { fg: this.fg, bg: this.bg, recent: this.recent }); }

  saveOpts() { store('amxpixl.opts', this.opts); this.emit('options'); }

  setPrefs(p: Partial<Prefs>) {
    Object.assign(this.prefs, p);
    store('amxpixl.prefs', this.prefs);
    this.applyPrefs();
    this.emit('prefs');
  }

  applyPrefs() {
    document.documentElement.dataset.theme = this.prefs.theme;
    document.documentElement.classList.toggle('glow', this.prefs.glow);
  }
}

export const app = new App();
