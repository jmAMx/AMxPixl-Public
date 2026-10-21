import type { Xform } from './math';

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
}

export interface ShapeProps {
  kind: 'rect' | 'ellipse' | 'line';
  /** Rect/ellipse: box size. Line: end point relative to the start (may be negative). */
  w: number;
  h: number;
  fill: string | null;
  stroke: string | null;
  strokeWidth: number;
  radius: number;
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
  | { kind: 'photofilter'; color: string; density: number; preserve: boolean };

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
}

/**
 * A layer mask: an alpha-only pixel buffer (opaque = layer shows) with its own placement, so it can follow the
 * layer when moved. Density and feather are applied live when drawing, like Photoshop's mask properties.
 */
export interface Mask { key: string; t: Xform; enabled: boolean; density: number; feather: number }

/** Anything with a pixel buffer that tools can paint on: a raster layer or a mask. */
export interface PixelTarget { key: string; t: Xform }

/** An effect layer's settings: which effect, a random seed for its texture, and its parameter values. */
export interface FxParams { kind: string; seed: number; v: Record<string, number | string | boolean> }

export interface RasterLayer extends LayerBase { type: 'raster'; key: string; t: Xform }
export interface TextLayer extends LayerBase { type: 'text'; t: Xform; text: TextProps }
export interface ShapeLayer extends LayerBase { type: 'shape'; t: Xform; shape: ShapeProps }
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
  shape: 'rect' | 'ellipse' | 'poly';
  /** rect/ellipse: [x, y, w, h]; poly: [x0, y0, x1, y1, ...] in document pixels. */
  pts: number[];
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
}
