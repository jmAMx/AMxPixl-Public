import { measure, pathBounds } from './paths';
import type { TextProps } from './types';

const measureCtx = document.createElement('canvas').getContext('2d')!;

export function fontString(tp: TextProps) {
  return `${tp.italic ? 'italic ' : ''}${tp.weight} ${tp.size}px "${tp.font}", "Segoe UI", sans-serif`;
}

/** Text box in local pixels: normally from (0, 0); text on a path is boxed around its path (x/y may be negative). */
export interface TextLayout { lines: string[]; widths: number[]; x: number; y: number; w: number; h: number; lineH: number; ascent: number }

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
  if (tp.onPath) {
    // Letters stand on the path, so allow a font size of room all round.
    const b = pathBounds([tp.onPath.sub]) ?? { x: 0, y: 0, w: 1, h: 1 };
    const pad = tp.size * 1.2;
    return { lines, widths, x: b.x - pad, y: b.y - pad, w: b.w + pad * 2, h: b.h + pad * 2, lineH, ascent };
  }
  return { lines, widths, x: 0, y: 0, w: Math.max(1, ...widths), h: Math.max(1, lines.length * lineH), lineH, ascent };
}

/**
 * Draws text with its top-left at local (0, 0); the caller sets the transform. Text on a path is set letter by
 * letter along the curve, each letter standing on it and turned to follow it.
 */
export function drawText(ctx: CanvasRenderingContext2D, tp: TextProps, lay = layoutText(tp)) {
  ctx.font = fontString(tp);
  ctx.letterSpacing = `${tp.tracking}px`;
  ctx.fillStyle = tp.color;
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';
  if (tp.onPath) { drawOnPath(ctx, tp); return; }
  lay.lines.forEach((line, i) => {
    const lw = lay.widths[i];
    const x = tp.align === 'center' ? (lay.w - lw) / 2 : tp.align === 'right' ? lay.w - lw : 0;
    ctx.fillText(line, x, i * lay.lineH + lay.ascent);
  });
}

/**
 * Text on a path, letter by letter: where each one stands (the middle of its foot, on the path), how it's turned to
 * follow the curve, and its width with letter spacing. Letters past the ends of an open path are left out. Shared
 * by drawing and by Text to Outlines, so the outlines land exactly where the letters are drawn.
 */
export function pathLetters(tp: TextProps): { ch: string; x: number; y: number; angle: number; w: number }[] {
  const { sub, offset } = tp.onPath!;
  const path = measure(sub);
  const ctx = measureCtx;
  ctx.font = fontString(tp);
  ctx.letterSpacing = `${tp.tracking}px`;
  const chars = [...(tp.content || '').replace(/\n/g, ' ')];
  const adv = chars.map((ch) => ctx.measureText(ch).width + tp.tracking);
  const total = adv.reduce((a, b) => a + b, 0);
  let d = offset + (tp.align === 'center' ? (path.length - total) / 2 : tp.align === 'right' ? path.length - total : 0);
  const out = [];
  for (let i = 0; i < chars.length; i++) {
    const w = adv[i];
    const mid = d + w / 2;
    if (mid >= 0 && mid <= path.length || sub.closed) {
      const p = path.at(sub.closed ? ((mid % path.length) + path.length) % path.length : mid);
      out.push({ ch: chars[i], x: p.x, y: p.y, angle: p.angle, w });
    }
    d += w;
  }
  return out;
}

function drawOnPath(ctx: CanvasRenderingContext2D, tp: TextProps) {
  const letters = pathLetters(tp);
  ctx.letterSpacing = '0px';
  for (const l of letters) {
    ctx.save();
    ctx.translate(l.x, l.y);
    ctx.rotate(l.angle);
    ctx.fillText(l.ch, -l.w / 2 + tp.tracking / 2, 0);
    ctx.restore();
  }
}
