import { app } from '../app';
import type { Doc } from '../core/document';
import { view } from '../ui/canvasview';
import { h } from '../ui/dom';
import { seg } from '../ui/widgets';

/**
 * Symmetry painting, shared by the Brush, Eraser and retouch tools: strokes are mirrored across the canvas's
 * vertical centre line (left/right), its horizontal one (top/bottom), or both (four ways).
 */
export function symmetryControl(): HTMLElement {
  const o = app.opts.symmetry;
  return h('span', { class: 'opt' }, h('span', { class: 'opt-label' }, 'Mirror'), seg([
    { v: 'off', label: 'Off', title: 'No symmetry' },
    { v: 'v', label: '↔', title: 'Mirror left and right, across the canvas\'s vertical centre line' },
    { v: 'h', label: '↕', title: 'Mirror top and bottom, across the canvas\'s horizontal centre line' },
    { v: 'both', label: '4-way', title: 'Mirror both ways: four copies of every stroke' },
  ], o.mode, (v) => { o.mode = v; app.saveOpts(); view.requestOverlay(); }));
}

/** The mirror axes for a stroke on this document, or undefined with symmetry off. */
export function mirrorAxes(doc: Doc): { x?: number; y?: number } | undefined {
  const m = app.opts.symmetry.mode;
  if (m === 'off') return undefined;
  return { x: m === 'v' || m === 'both' ? doc.width / 2 : undefined, y: m === 'h' || m === 'both' ? doc.height / 2 : undefined };
}

/** Dashed lines on the canvas where strokes are mirrored. */
export function drawSymmetryAxes(ctx: CanvasRenderingContext2D) {
  const doc = app.doc;
  const ax = doc && mirrorAxes(doc);
  if (!ax) return;
  const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#2EE6BE';
  const a = view.toScreen(0, 0), b = view.toScreen(doc.width, doc.height);
  ctx.save();
  ctx.lineWidth = 1;
  ctx.setLineDash([6, 5]);
  ctx.strokeStyle = accent;
  ctx.globalAlpha = 0.8;
  ctx.beginPath();
  if (ax.x !== undefined) { const x = Math.round(view.toScreen(ax.x, 0).x) + 0.5; ctx.moveTo(x, a.y); ctx.lineTo(x, b.y); }
  if (ax.y !== undefined) { const y = Math.round(view.toScreen(0, ax.y).y) + 0.5; ctx.moveTo(a.x, y); ctx.lineTo(b.x, y); }
  ctx.stroke();
  ctx.restore();
}
