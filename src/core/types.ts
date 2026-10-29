import type { Envelope } from './envelope';
import type { Model3D } from './model3d';
import type { Rect, Xform } from './math';

export type BlendMode =
  | 'normal' | 'multiply' | 'screen' | 'overlay' | 'darken' | 'lighten' | 'color-dodge' | 'color-burn'
  | 'hard-light' | 'soft-light' | 'difference' | 'exclusion' | 'hue' | 'saturation' | 'color' | 'luminosity'
  /** Groups only: children blend straight into what's below, as if the group weren't there. */
  | 'pass-through';

export const BLEND_MODES: [BlendMode, string][] = [
  ['normal', 'Normal'], ['darken', 'Darken'], ['multiply', 'Multiply'], ['color-burn', 'Color Burn'],
  ['lighten', 'Lighten'], ['screen', 'Screen'], ['color-dodge', 'Color Dodge'], ['overlay', 'Overlay'],
  ['soft-light', 'Soft Light'], ['hard-light', 'Hard Light'], ['difference', 'Difference'], ['exclusion', 'Exclusion'],
  ['hue', 'Hue'], ['saturation', 'Saturation'], ['color', 'Color'], ['luminosity', 'Luminosity'],
];

export interface TextProps {
  content: string;
  font: string;
  size: number;
  weight: number;
  italic: boolean;
  color: string;
  align: 'left' | 'center' | 'right';
  lineHeight: number;
  tracking: number;
  /** False for hard pixel edges (pixel art). Missing means on. */
  antiAlias?: boolean;
  /** Text set along a curve (in the layer's own coordinates), starting `offset` pixels in. */
  onPath?: { sub: SubPath; offset: number } | null;
}

export interface ShapeProps {
  /** 'path': any outline (`subs`), e.g. text turned into outlines; reshaped with the Paths tool. */
  kind: 'rect' | 'ellipse' | 'line' | 'polygon' | 'star' | 'path';
  /** Path shapes: the outline in the layer's own pixels. */
  subs?: SubPath[];
  /** Polygon/star: number of corners (points), and a star's inner radius as a fraction of the outer. */
  sides?: number;
  inner?: number;
  /** Rect/ellipse: box size. Line: end point relative to the start (may be negative). */
  w: number;
  h: number;
  fill: string | null;
  stroke: string | null;
  strokeWidth: number;
  radius: number;
  /** False for hard pixel edges (pixel art). Missing means on. */
  antiAlias?: boolean;
}

export interface LevelsCh { inBlack: number; inWhite: number; gamma: number; outBlack: number; outWhite: number }
export type Channel = 'rgb' | 'r' | 'g' | 'b';
export type CurvePts = [number, number][];

export type AdjParams =
  | { kind: 'brightness'; brightness: number; contrast: number }
  | { kind: 'levels'; ch: Record<Channel, LevelsCh> }
  | { kind: 'curves'; ch: Record<Channel, CurvePts> }
  | { kind: 'huesat'; hue: number; sat: number; light: number }
  | { kind: 'vibrance'; vibrance: number; saturation: number }
  | { kind: 'exposure'; exposure: number; offset: number; gamma: number }
  | { kind: 'colorbalance'; shadows: [number, number, number]; midtones: [number, number, number]; highlights: [number, number, number] }
  | { kind: 'bw'; tint: string | null }
  | { kind: 'invert' }
  | { kind: 'threshold'; level: number }
  | { kind: 'posterize'; levels: number }
  /** Per colour range (reds, oranges, yellows, greens, aquas, blues, purples, magentas): [hue, saturation, lightness] -100..100. */
  | { kind: 'hsl'; bands: [number, number, number][] }
  | { kind: 'grade'; shadows: GradeWheel; midtones: GradeWheel; highlights: GradeWheel; balance: number }
  | { kind: 'gradmap'; dark: string; mid: string; light: string; useMid: boolean; reverse: boolean }
  /** Output channel rows of input percentages, e.g. r: [100, 0, 0]. */
  | { kind: 'mixer'; r: [number, number, number]; g: [number, number, number]; b: [number, number, number]; mono: boolean }
  | { kind: 'photofilter'; color: string; density: number; preserve: boolean }
  /** A loaded .cube colour lookup, stored as a packed image in the pixel pool under `key`. */
  | { kind: 'lut'; key: string | null; name: string; size: number; intensity: number };

/** One colour-grading wheel: tint direction (hue °), tint strength and brightness shift. */
export interface GradeWheel { hue: number; amount: number; lum: number }

export type AdjKind = AdjParams['kind'];

interface LayerBase {
  id: string;
  name: string;
  visible: boolean;
  opacity: number;
  blend: BlendMode;
  /** Clipping mask: only shows where the nearest non-clipped layer below has pixels. */
  clip?: boolean;
  mask?: Mask | null;
  styles?: LayerStyles | null;
  blendIf?: BlendIf | null;
  /** Blend in linear light, like GIMP 2.10+ (set on layers imported from GIMP so they look the same). */
  linear?: boolean;
}

/** Editable layer effects drawn from the layer's shape (sizes in document pixels, opacity 0..1). */
export interface LayerStyles {
  shadow: { on: boolean; color: string; opacity: number; angle: number; distance: number; size: number };
  glow: { on: boolean; color: string; opacity: number; size: number };
  innerGlow: { on: boolean; color: string; opacity: number; size: number };
  stroke: { on: boolean; color: string; opacity: number; size: number; position: 'outside' | 'inside' | 'center' };
  overlay: { on: boolean; color: string; opacity: number };
}

/**
 * Blend If: fade the layer out by brightness. Each range is [black, black-feather, white-feather, white] on 0..255:
 * pixels darker than `black` or brighter than `white` vanish, fading in between.
 */
export interface BlendIf { on: boolean; self: [number, number, number, number]; under: [number, number, number, number] }

/**
 * Lossless warp of a raster layer, as control points in the layer's own pixel space. Perspective: 4 corners
 * (TL, TR, BR, BL). Mesh: an n x n grid, row by row.
 */
export interface Warp { kind: 'perspective' | 'mesh'; n: number; pts: number[] }

export interface Guide { axis: 'x' | 'y'; pos: number }

/**
 * A layer mask: an alpha-only pixel buffer (opaque = layer shows) with its own placement, so it can follow the
 * layer when moved. Density and feather are applied live when drawing, like Photoshop's mask properties.
 */
export interface Mask { key: string; t: Xform; enabled: boolean; density: number; feather: number }

/** Anything with a pixel buffer that tools can paint on: a raster layer or a mask. */
export interface PixelTarget { key: string; t: Xform }

/**
 * An effect layer's settings: which effect, a random seed for its texture, and its parameter values. With `motion`
 * on, the effect moves over the animation's frames: grain and damage re-roll, scanlines roll, dots drift.
 */
export interface FxParams { kind: string; seed: number; v: Record<string, number | string | boolean>; motion?: FxMotion }
/** `speed` scales the movement (1 = normal); `flicker` is how many times a second random textures change. */
export interface FxMotion { on: boolean; speed: number; flicker: number }

/** A point on a path, with its two Bézier handles (absolute positions; equal to the point when there's no curve). */
export interface PathPoint { x: number; y: number; ix: number; iy: number; ox: number; oy: number }
/** One continuous run of points; closed runs join the last point back to the first. */
export interface SubPath { closed: boolean; pts: PathPoint[] }
/** A vector path drawn with the Pen (document coordinates). */
export interface VPath { id: string; name: string; subs: SubPath[] }

/** One animation frame: which layers it shows or hides (others follow their own eye), and how long it's held. */
export interface AnimFrame { id: string; vis: Record<string, boolean>; ms?: number }
/** Frame animation: frames play in order at `fps` (a frame's own `ms` overrides its length). */
export interface Anim { fps: number; frames: AnimFrame[]; loop: boolean }

/** A layer with a position on the canvas. `box` is a bounding box set by hand (Move tool › Box › Custom), in its own pixels. */
interface PlacedBase extends LayerBase { t: Xform; box?: Rect | null }
/** `model`: a 3D layer, its picture turned into a lit 3D object (see model3d.ts); it can't be painted on. */
export interface RasterLayer extends PlacedBase { type: 'raster'; key: string; warp?: Warp | null; model?: Model3D | null }
/** `envelope`: a warp preset (arc, flag, bulge...) bending the text or shape; it stays editable and refits to edits. */
export interface TextLayer extends PlacedBase { type: 'text'; text: TextProps; envelope?: Envelope | null }
export interface ShapeLayer extends PlacedBase { type: 'shape'; shape: ShapeProps; envelope?: Envelope | null }
export interface AdjustLayer extends LayerBase { type: 'adjust'; adj: AdjParams }
export interface EffectLayer extends LayerBase { type: 'effect'; fx: FxParams }
export interface GroupLayer extends LayerBase { type: 'group'; children: Layer[]; open: boolean }

export type Layer = RasterLayer | TextLayer | ShapeLayer | AdjustLayer | EffectLayer | GroupLayer;
export type PlacedLayer = RasterLayer | TextLayer | ShapeLayer;
/** Layers that change what's beneath them instead of adding pixels. */
export type FilterLayer = AdjustLayer | EffectLayer;

export const isPlaced = (l: Layer | null | undefined): l is PlacedLayer => !!l && (l.type === 'raster' || l.type === 'text' || l.type === 'shape');
export const isFilter = (l: Layer | null | undefined): l is FilterLayer => !!l && (l.type === 'adjust' || l.type === 'effect');

/** One step of a selection: shapes are combined in order, added or subtracted. */
export interface SelOp {
  mode: 'add' | 'sub';
  shape: 'rect' | 'ellipse' | 'poly' | 'mask';
  /** rect/ellipse/mask: [x, y, w, h] (for a mask, its bounding box); poly: [x0, y0, x1, y1, ...] in document pixels. */
  pts: number[];
  /** mask: a document-sized alpha image in the pixel pool (opaque = selected, soft edges allowed). */
  key?: string;
}
export interface Selection { ops: SelOp[] }

/** Everything about a document except pixel data: cheap to clone, so undo snapshots it whole. */
export interface Meta {
  width: number;
  height: number;
  layers: Layer[];
  activeId: string | null;
  selection: Selection | null;
  counter: number;
  guides?: Guide[];
  /** Quick Mask mode: the selection being painted, as a document-sized alpha image in the pool. */
  quickMask?: string | null;
  /** Nearest neighbour keeps pixel art blocky when layers or the image are scaled. Missing means smooth. */
  resample?: 'smooth' | 'nearest';
  /** Frame animation (GIF/video), or none for a still image. */
  anim?: Anim | null;
  /** Pen paths, and which one the Pen and Paths panel work on. */
  paths?: VPath[];
  activePath?: string | null;
}
