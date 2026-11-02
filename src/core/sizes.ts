/** Image sizes to pick from (New Image, the Artboard tool): a name, width and height. */
export const SIZE_PRESETS: [string, number, number][] = [
  ['Full HD 1920 × 1080', 1920, 1080],
  ['4K UHD 3840 × 2160', 3840, 2160],
  ['Square post 1080 × 1080', 1080, 1080],
  ['Portrait post 1080 × 1350', 1080, 1350],
  ['Story 1080 × 1920', 1080, 1920],
  ['YouTube thumbnail 1280 × 720', 1280, 720],
  ['Logo 1024 × 1024', 1024, 1024],
  ['Web banner 1500 × 500', 1500, 500],
  ['A4 @ 300 ppi 2480 × 3508', 2480, 3508],
  ['Letter @ 300 ppi 2550 × 3300', 2550, 3300],
];

/** Shapes to pick from, which keep the width and set the height: a name, then width : height. */
export const RATIOS: [string, number, number][] = [
  ['Square 1 : 1', 1, 1],
  ['Portrait 4 : 5', 4, 5],
  ['Photo 3 : 2', 3, 2],
  ['Photo 2 : 3', 2, 3],
  ['Classic 4 : 3', 4, 3],
  ['Wide 16 : 9', 16, 9],
  ['Story 9 : 16', 9, 16],
];

/** The largest image a canvas can hold: no side over 32,767 px and no more than 16,384 × 16,384 pixels in all. */
export const MAX_SIDE = 32767, MAX_AREA = 16384 * 16384;

/** Why an image of w × h can't be made, or null if it can. */
export function sizeProblem(w: number, h: number): string | null {
  w = Math.round(w); h = Math.round(h);
  if (w <= MAX_SIDE && h <= MAX_SIDE && w * h <= MAX_AREA) return null;
  return w > MAX_SIDE || h > MAX_SIDE
    ? `${w} × ${h} px is too big: an image can be at most ${MAX_SIDE.toLocaleString()} px wide or tall.`
    : `${w} × ${h} px is ${Math.round((w * h) / 1e6)} megapixels, too big: the most an image can have is ${Math.round(MAX_AREA / 1e6)} (16,384 × 16,384).`;
}

/**
 * A size picker: "Custom" (shown while the size matches nothing), the presets, and the ratios. Its value is "p:<i>" or
 * "r:<i>"; `onPick` gets the preset's size, or for a ratio, the height for the current width.
 */
export function sizeOptions(): { value: string; label: string; group: 'Sizes' | 'Ratios (keep the width)' }[] {
  return [
    ...SIZE_PRESETS.map(([l], i) => ({ value: `p:${i}`, label: l, group: 'Sizes' as const })),
    ...RATIOS.map(([l], i) => ({ value: `r:${i}`, label: l, group: 'Ratios (keep the width)' as const })),
  ];
}

/** The size a picker value gives for an image now `w` × `h` (a ratio keeps the width). */
export function pickSize(value: string, w: number, h: number): { w: number; h: number } {
  const [kind, n] = value.split(':');
  if (kind === 'p') { const p = SIZE_PRESETS[Number(n)]; if (p) return { w: p[1], h: p[2] }; }
  if (kind === 'r') { const r = RATIOS[Number(n)]; if (r) return { w, h: Math.max(1, Math.round((w * r[2]) / r[1])) }; }
  return { w, h };
}
