// Types for Pixl's plugin API (plugin version 1), for editors that read TypeScript declarations: put this file
// next to your plugin's main.js (or reference it with /// <reference path="pixl.d.ts" />) to get completion and
// checking in plain JavaScript too. Every call returns a promise; see README.md for what each needs.

declare namespace Pixl {
  type BlendMode = 'normal' | 'darken' | 'multiply' | 'color-burn' | 'lighten' | 'screen' | 'color-dodge' | 'overlay'
    | 'soft-light' | 'hard-light' | 'difference' | 'exclusion' | 'hue' | 'saturation' | 'color' | 'luminosity';

  interface LayerInfo {
    id: string;
    name: string;
    /** 'raster' is an image layer, the only kind with pixels of its own. */
    type: 'raster' | 'group' | 'text' | 'shape' | 'adjust' | 'effect';
    visible: boolean;
    /** 0 to 1. */
    opacity: number;
    blend: BlendMode;
  }

  interface ImageInfo {
    name: string;
    width: number;
    height: number;
    /** The selected layer's id. */
    activeLayer: string;
    /** Whether anything is selected. */
    selection: boolean;
    /** Every layer, groups' contents included, bottom to top. */
    layers: LayerInfo[];
  }

  /** A layer's own pixels, and where they start in the layer. */
  interface LayerPixels extends ImageData { x: number; y: number }

  interface Rect { x: number; y: number; width: number; height: number }

  /** Where a tool was pressed, dragged or let go, in canvas pixels. */
  interface ToolPoint { x: number; y: number; pressure: number; shift: boolean; alt: boolean; ctrl: boolean }

  interface ToolHandlers {
    down?(point: ToolPoint): unknown;
    /** Only while the button is down, at most once a frame. */
    move?(point: ToolPoint): unknown;
    up?(point: ToolPoint): unknown;
  }

  /** What a format's onOpen gives back: the picture's size and its layers, bottom first. */
  interface OpenedImage {
    width: number;
    height: number;
    layers: { name?: string; image: ImageData; x?: number; y?: number }[];
  }

  interface Commands {
    newLayer: undefined; newGroup: undefined; duplicateLayer: undefined; deleteLayer: undefined; mergeDown: undefined;
    flatten: undefined; selectAll: undefined; deselect: undefined; invertSelection: undefined; undo: undefined; redo: undefined;
    fill: { with: 'fg' | 'bg' };
    selectLayer: { id: string };
    /** Any effect, built in or a plugin's, on the selected layer: { kind: 'gblur', settings: { radius: 4 } }. */
    filter: { kind: string; settings?: Record<string, number | string | boolean> };
  }

  interface API {
    onCommand(id: string, run: () => unknown): void;
    onTool(id: string, handlers: ToolHandlers): void;
    onOpen(format: string, open: (bytes: Uint8Array, name: string) => OpenedImage | Promise<OpenedImage>): void;
    onExport(format: string, save: (image: ImageData) => Uint8Array | ArrayBuffer | Promise<Uint8Array | ArrayBuffer>): void;

    image(): Promise<ImageInfo>;
    /** Needs "pixels:read". An image layer's own pixels (all, or a rectangle of them; null if it's outside the layer). */
    pixels(layerId: string, rect?: Rect): Promise<LayerPixels | null>;
    /** Needs "pixels:read". The selection the image's size (alpha: how selected), or null. */
    selection(): Promise<ImageData | null>;
    /** Needs "pixels:write". One undo step, named by label. */
    setPixels(layerId: string, image: ImageData, x?: number, y?: number, label?: string): Promise<boolean>;
    /** Needs "pixels:write". The layers panel's own settings, as one undo step. */
    setLayer(layerId: string, props: { name?: string; visible?: boolean; opacity?: number; blend?: BlendMode }): Promise<boolean>;
    /** Needs "pixels:write". A new image layer above the selected one; returns its id. */
    addLayer(name: string, image?: ImageData): Promise<string>;
    /** Needs "commands". */
    run<K extends keyof Commands>(command: K, ...args: Commands[K] extends undefined ? [] : [Commands[K]]): Promise<boolean>;

    toast(text: string): Promise<boolean>;
    /** The foreground and background colours, as "#rrggbb". */
    colors(): Promise<{ fg: string; bg: string }>;
    /** Either may be left out; each must be "#rrggbb". */
    setColors(fg?: string, bg?: string): Promise<boolean>;
  }
}

declare const pixl: Pixl.API;
