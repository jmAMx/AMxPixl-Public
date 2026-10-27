import type { ChangeKind, Doc } from './core/document';
import type { Tool } from './tools/tool';

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
}

const load = <T>(k: string, d: T): T => {
  try { const v = localStorage.getItem(k); return v ? { ...d, ...JSON.parse(v) } : d; } catch { return d; }
};
const store = (k: string, v: unknown) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage unavailable */ } };

export const DEFAULT_OPTS = {
  brush: { size: 24, hardness: 0.8, opacity: 1, flow: 1, pressure: true, antiAlias: true, tip: 'round', spacing: 12, jitter: 0, scatter: 0 },
  eraser: { size: 40, hardness: 0.8, opacity: 1, flow: 1, pressure: false, antiAlias: true, tip: 'round', spacing: 12, jitter: 0, scatter: 0 },
  select: { antiAlias: true },
  pen: { mode: 'pen' as 'pen' | 'freehand', smooth: 50 },
  dodge: { size: 60, hardness: 0.3, strength: 0.35, range: 1, pressure: false },
  burn: { size: 60, hardness: 0.3, strength: 0.35, range: 1, pressure: false },
  blur: { size: 40, hardness: 0.5, strength: 0.7, range: 1, pressure: false },
  sharpen: { size: 40, hardness: 0.5, strength: 0.4, range: 1, pressure: false },
  smudge: { size: 30, hardness: 0.5, strength: 0.6, range: 1, pressure: false },
  clone: { size: 40, hardness: 0.6, opacity: 1, flow: 1, pressure: false, aligned: true, sampleAll: false },
  heal: { size: 40, hardness: 0.5, opacity: 1, flow: 1, pressure: false, aligned: true, sampleAll: false },
  wand: { tolerance: 32, contiguous: true, sampleAll: true, antiAlias: true },
  fill: { tolerance: 32, contiguous: true, opacity: 1 },
  gradient: { kind: 'linear' as 'linear' | 'radial', toTransparent: false, opacity: 1 },
  text: { font: 'Segoe UI', size: 64, weight: 400, italic: false, align: 'left' as 'left' | 'center' | 'right', antiAlias: true },
  shape: { kind: 'rect' as 'rect' | 'ellipse' | 'line' | 'polygon' | 'star', fill: true, stroke: false, strokeWidth: 4, radius: 0, antiAlias: true, sides: 6, inner: 0.45 },
  move: { autoSelect: false, mode: 'transform' as 'transform' | 'perspective' | 'warp' },
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
  prefs: Prefs = load<Prefs>('amxpixl.prefs', { theme: 'dark', glow: false, dock: { color: true, properties: true, layers: true, history: false }, rulers: false, guides: true, snap: true, pixelGrid: true, onion: false, toolCols: 1, toolLabels: false, toolGroups: [], optionsDock: 'top' });
  /** Set while a modal filter preview or text edit owns the canvas. */
  busy = false;
  /** An animation is playing in the Timeline. */
  playing = false;

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
