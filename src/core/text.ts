import type { TextProps } from './types';

const measureCtx = document.createElement('canvas').getContext('2d')!;

export function fontString(tp: TextProps) {
  return `${tp.italic ? 'italic ' : ''}${tp.weight} ${tp.size}px "${tp.font}", "Segoe UI", sans-serif`;
}

export interface TextLayout { lines: string[]; widths: number[]; w: number; h: number; lineH: number; ascent: number }

export function layoutText(tp: TextProps): TextLayout {
  const ctx = measureCtx;
  ctx.font = fontString(tp);
  ctx.letterSpacing = `${tp.tracking}px`;
  const lines = (tp.content || ' ').split('\n');
  const widths = lines.map((l) => ctx.measureText(l || ' ').width);
  const m = ctx.measureText('Hg');
  const asc = m.fontBoundingBoxAscent || tp.size * 0.8;
  const desc = m.fontBoundingBoxDescent || tp.size * 0.2;
  const lineH = tp.size * tp.lineHeight;
  const ascent = asc + (lineH - (asc + desc)) / 2;
  return { lines, widths, w: Math.max(1, ...widths), h: Math.max(1, lines.length * lineH), lineH, ascent };
}

/** Draws text with its top-left at local (0, 0); the caller sets the transform. */
export function drawText(ctx: CanvasRenderingContext2D, tp: TextProps, lay = layoutText(tp)) {
  ctx.font = fontString(tp);
  ctx.letterSpacing = `${tp.tracking}px`;
  ctx.fillStyle = tp.color;
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';
  lay.lines.forEach((line, i) => {
    const lw = lay.widths[i];
    const x = tp.align === 'center' ? (lay.w - lw) / 2 : tp.align === 'right' ? lay.w - lw : 0;
    ctx.fillText(line, x, i * lay.lineH + lay.ascent);
  });
}
