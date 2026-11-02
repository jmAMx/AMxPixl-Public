import type { ChangeKind, Doc } from './core/document';
import { Project, type Layout } from './core/project';
import { autosave, clearRecovery } from './core/recovery';
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
  /** The order of the tools in the toolbox (tool ids), when it's been rearranged; tools added since go where they were. */
  toolOrder?: string[];
  /** Heights (CSS px) of dock panels sized by dragging the edge between them; the others size themselves. */
  panelHeights?: Record<string, number>;
  /** The tools' height in the toolbox when the tool options are beside them (dragged); unset = all the tools. */
  toolGridH?: number;
  /**
   * Shortcuts changed in Preferences: a menu command's id ("File › Save", or its own id) or "tool:<id>" to its keys
   * ('' for none). Anything not here keeps its own.
   */
  shortcuts?: Record<string, string>;
  /** Minutes between crash-recovery copies of unsaved work (0 = off); unset = every minute. */
  autosaveMin?: number;
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
  move: { autoSelect: false, mode: 'transform' as 'transform' | 'perspective' | 'warp' | 'rotate3d' | 'light3d', box: 'content' as 'content' | 'layer' | 'custom' },
  picker: { sample: 1 },
  /** Artboard tool: the space left between artboards lined up in a row or a column. */
  artboard: { gap: 100 },
};
export type ToolOpts = typeof DEFAULT_OPTS;

class App {
  /** Open files, one per tab, and the one shown. */
  projects: Project[] = [];
  project: Project | null = null;
  /** The image being worked on: the shown file's active artboard. */
  get doc(): Doc | null { return this.project?.active ?? null; }
  /** Every open image (every artboard of every file). */
  get docs(): Doc[] { return this.projects.flatMap((p) => p.docs); }
  fg = '#000000';
  bg = '#ffffff';
  recent: string[] = [];
  tool!: Tool;
  tools: Tool[] = [];
  opts: ToolOpts = structuredClone(DEFAULT_OPTS);
  prefs: Prefs = load<Prefs>('amxpixl.prefs', { theme: 'dark', glow: false, dock: { color: true, properties: true, layers: true, history: false }, rulers: false, guides: true, snap: true, pixelGrid: true, onion: false, toolCols: 1, toolLabels: false, toolGroups: [], optionsDock: 'top', tablet: DEFAULT_TABLET });
  /**
   * Set while a filter preview owns the canvas: the layer shows previewed pixels that aren't a history step yet, so
   * saving, undoing, switching images and the like wait (the rest of the window ignores the mouse meanwhile).
   */
  get busy() { return this.isBusy; }
  set busy(v: boolean) { this.isBusy = v; document.body.classList.toggle('previewing', v); }
  private isBusy = false;
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

  /** Opens an image in a new tab, as a file with one artboard. */
  addDoc(d: Doc): Project {
    const p = new Project(d.name, [{ doc: d, x: 0, y: 0 }]);
    this.addProject(p);
    return p;
  }

  addProject(p: Project, show = true) {
    for (const d of p.docs) this.watch(d);
    p.onLayout = (to, from) => this.layoutUndone(p, to, from);
    this.projects.push(p);
    if (show) this.setDoc(p.active); else this.emit('docs');
  }

  /**
   * Undo or redo changed `p`'s artboards, from layout `from` to `to`. Another file the step closed (one put into `p` as
   * copies) or opened (a copy of an artboard taken out of `p`) opens again or closes to match: it's only closed if
   * nothing was done in it since, so no work is lost (and only copies ever went across, so its artboards and history
   * are its own). One opened again is fitted to the window when it's next shown.
   */
  private layoutUndone(p: Project, to: Layout, from: Layout) {
    for (const d of p.docs) this.watch(d);
    const keep = new Set((to.tabs ?? []).map((t) => t.project));
    for (const t of to.tabs ?? []) {
      if (this.projects.includes(t.project) || t.project.closed) continue;
      t.project.active.fitted = false;
      this.addProject(t.project, false);
      // (Its recovery copy went when it closed: make one again.)
      t.project.active.touch('meta');
    }
    for (const t of from.tabs ?? []) {
      const q = t.project, h = q.history;
      if (keep.has(q) || !this.projects.includes(q) || h.index !== t.at || h.entries.length !== t.at) continue;
      this.parkProject(q, p);
    }
    this.emit('docs');
  }

  /**
   * Closes a file whose artboards went into `into` as copies (still in memory, for undo to open again). Its recovery
   * copy goes once `into`'s has been written, so a crash in between can't lose it.
   */
  parkProject(q: Project, into: Project) {
    const i = this.projects.indexOf(q);
    if (i < 0) return;
    if (this.project === q) this.setDoc(into.active);
    this.projects.splice(i, 1);
    autosave(into).then(() => clearRecovery(q)).catch(() => {});
    this.emit('docs');
  }

  /** Changes to an image are reported as the app's 'change' event. */
  watch(d: Doc) { d.onChange = (doc, kind) => this.emit('change', { doc, kind }); }

  /** Adds an image to a file as another artboard, at (x, y) among the others. (Not an undo step by itself.) */
  addArtboard(p: Project, d: Doc, x: number, y: number) {
    this.watch(d);
    p.add(d, x, y);
    this.emit('docs');
  }

  /** The file an image is an artboard of. */
  projectOf(d: Doc): Project | null { return this.projects.find((p) => p.has(d)) ?? null; }

  /**
   * The name to suggest when exporting an image: its file's name, or for one of several artboards the file's name and
   * the artboard's ("poster - Banner").
   */
  nameOf(d: Doc): string {
    const p = this.projectOf(d);
    if (!p) return d.name;
    return p.boards.length > 1 ? `${p.name.replace(/\.[^.]+$/, '')} - ${d.name}` : p.name;
  }

  /** Shows an image: switches to its file's tab, and to it there. */
  setDoc(d: Doc | null) {
    // A field still being typed in (say a text layer's text in Properties) commits to the document it belongs to.
    (document.activeElement as HTMLElement | null)?.blur?.();
    this.tool?.deactivate?.();
    const p = d ? this.projectOf(d) : null;
    if (p && d) p.setActive(d);
    this.project = p;
    this.emit('docs');
    this.tool?.activate?.();
  }

  /** Closes a file's tab. */
  removeProject(p: Project) {
    const i = this.projects.indexOf(p);
    if (i < 0) return;
    p.closed = true;
    this.projects.splice(i, 1);
    if (this.project === p) this.setDoc(this.projects[Math.min(i, this.projects.length - 1)]?.active ?? null);
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
