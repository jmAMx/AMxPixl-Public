import type { Xform } from './math';

export type BlendMode =
  | 'normal' | 'multiply' | 'screen' | 'overlay' | 'darken' | 'lighten' | 'color-dodge' | 'color-burn'
  | 'hard-light' | 'soft-light' | 'difference' | 'exclusion' | 'hue' | 'saturation' | 'color' | 'luminosity';

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
  | { kind: 'posterize'; levels: number };

export type AdjKind = AdjParams['kind'];

interface LayerBase {
  id: string;
  name: string;
  visible: boolean;
  opacity: number;
  blend: BlendMode;
}

export interface RasterLayer extends LayerBase { type: 'raster'; key: string; t: Xform }
export interface TextLayer extends LayerBase { type: 'text'; t: Xform; text: TextProps }
export interface ShapeLayer extends LayerBase { type: 'shape'; t: Xform; shape: ShapeProps }
export interface AdjustLayer extends LayerBase { type: 'adjust'; adj: AdjParams }

export type Layer = RasterLayer | TextLayer | ShapeLayer | AdjustLayer;
export type PlacedLayer = RasterLayer | TextLayer | ShapeLayer;

export const isPlaced = (l: Layer | null | undefined): l is PlacedLayer => !!l && l.type !== 'adjust';

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
