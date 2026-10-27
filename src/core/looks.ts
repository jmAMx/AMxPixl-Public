import type { FxValue } from './effects';
import type { AdjParams, BlendMode } from './types';
import { setSetting } from './settings';

/** One layer of a look: an effect (by kind + settings) or an adjustment (full settings). */
export interface LookItem {
  type: 'effect' | 'adjust';
  kind: string;
  name?: string;
  v?: Record<string, FxValue>;
  seed?: number;
  adj?: Partial<AdjParams>;
  opacity?: number;
  blend?: BlendMode;
  /** LUT adjustments carry their table as a PNG data URL. */
  lutData?: string;
}

/** A saved stack of effect/adjustment layers that can be dropped onto any image as one group. */
export interface Look { name: string; builtin?: boolean; items: LookItem[] }

export const BUILTIN_LOOKS: Look[] = [
  {
    name: 'VHS Tape', builtin: true, items: [
      { type: 'effect', kind: 'fade', v: { lift: 8, cut: 4, desat: 10, split: 25 } },
      { type: 'effect', kind: 'vhs' },
      { type: 'effect', kind: 'chromatic', v: { amount: 3, mode: 'linear', angle: 0 } },
      { type: 'effect', kind: 'grain', v: { amount: 18, size: 1.2 } },
    ],
  },
  {
    name: 'Old Film', builtin: true, items: [
      { type: 'effect', kind: 'fade', v: { lift: 12, cut: 6, desat: 30, split: 40, shadow: '#2a1f14', high: '#f0d9a8' } },
      { type: 'effect', kind: 'halation', v: { threshold: 70, radius: 14, strength: 60 } },
      { type: 'effect', kind: 'vignette', v: { amount: 45, size: 40, feather: 60 } },
      { type: 'effect', kind: 'dust', v: { amount: 35, scratches: 40 } },
      { type: 'effect', kind: 'grain', v: { amount: 35, size: 2, rough: 60 } },
    ],
  },
  {
    name: 'CRT Arcade', builtin: true, items: [
      { type: 'effect', kind: 'bloom', v: { threshold: 60, radius: 20, strength: 60 } },
      { type: 'effect', kind: 'chromatic', v: { amount: 4, mode: 'radial' } },
      { type: 'effect', kind: 'crt' },
      { type: 'effect', kind: 'grain', v: { amount: 10, size: 1 } },
    ],
  },
  {
    name: 'Newsprint', builtin: true, items: [
      { type: 'effect', kind: 'halftone', v: { size: 7, mode: 'mono', ink: '#1b1b1b', paper: '#efe8d8' } },
      { type: 'effect', kind: 'grain', v: { amount: 12, size: 1.5 } },
    ],
  },
  {
    name: 'Teal & Orange', builtin: true, items: [
      { type: 'adjust', kind: 'grade', adj: { kind: 'grade', balance: 0, shadows: { hue: 195, amount: 45, lum: -5 }, midtones: { hue: 30, amount: 10, lum: 0 }, highlights: { hue: 32, amount: 40, lum: 4 } } },
      { type: 'adjust', kind: 'vibrance', adj: { kind: 'vibrance', vibrance: 15, saturation: 0 } },
    ],
  },
  {
    name: 'Lo-fi Digital', builtin: true, items: [
      { type: 'effect', kind: 'compression', v: { block: 8, blocky: 55, chroma: 70, banding: 40 } },
      { type: 'effect', kind: 'glitch', v: { amount: 15, slices: 24, offset: 40, split: 6 } },
    ],
  },
  {
    name: 'Dreamy Mist', builtin: true, items: [
      { type: 'effect', kind: 'fade', v: { lift: 6, cut: 3, desat: 5, split: 20, shadow: '#3a3460', high: '#ffe1c4' } },
      { type: 'effect', kind: 'diffusion', v: { radius: 35, strength: 45, lift: 30 } },
      { type: 'effect', kind: 'lightleak', v: { intensity: 35, size: 55 } },
    ],
  },
];

const KEY = 'amxpixl.looks';

export function savedLooks(): Look[] {
  try { return JSON.parse(localStorage.getItem(KEY) || '[]') as Look[]; } catch { return []; }
}

export function storeLooks(list: Look[]) {
  try { setSetting(KEY, JSON.stringify(list)); return true; } catch { return false; }
}
