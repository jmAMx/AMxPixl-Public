import { app } from '../app';
import type { Doc } from '../core/document';
import { mul, translate, xformMatrix, type Mat } from '../core/math';
import { view } from '../ui/canvasview';
import { h } from '../ui/dom';
import { clearSnapLines, snapPoint } from '../ui/snap';
import { seg, slider } from '../ui/widgets';
import type { PInfo } from './tool';

/**
 * Symmetry painting, shared by the Brush, Eraser and retouch tools: strokes are mirrored across a vertical line
 * (left/right), a horizontal one (top/bottom) or both (four ways), or turned around a point into several spokes
 * (radial). The lines cross at a centre you can drag on the canvas; it snaps to guides, the canvas middle and edges.
 */
const o = () => app.opts.symmetry;

export function symmetryControl(): HTMLElement {
  const s = o();
  const el = h('span', { class: 'opt symmetry-opt' }, h('span', { class: 'opt-label' }, 'Mirror'), seg([
    { v: 'off', label: 'Off', title: 'No symmetry' },
    { v: 'v', label: '↔', title: 'Mirror left and right, across the vertical line' },
    { v: 'h', label: '↕', title: 'Mirror top and bottom, across the horizontal line' },
    { v: 'both', label: '4-way', title: 'Mirror both ways: four copies of every stroke' },
    { v: 'radial', label: 'Radial', title: 'Turn copies around the centre, like spokes of a wheel' },
  ], s.mode, (v) => { s.mode = v; app.saveOpts(); app.emit('tool'); view.requestOverlay(); }));
  if (s.mode === 'radial') {
    el.append(slider({ label: 'Spokes', min: 2, max: 16, value: s.spokes, compact: true, onInput: (v) => { s.spokes = Math.round(v); view.requestOverlay(); }, onChange: () => app.saveOpts() }));
  }
  if (s.mode !== 'off') {
    el.append(h('button', {
      class: 'btn small', type: 'button', title: 'Put the centre back in the middle of the canvas (or drag the round handle on the canvas)',
      onclick: () => { s.cx = 0.5; s.cy = 0.5; app.saveOpts(); view.requestOverlay(); },
    }, 'Centre'));
  }
  return el;
}

const centreOf = (doc: Doc) => ({ x: o().cx * doc.width, y: o().cy * doc.height });

/** Where each dab is copied to (document-space maps), or undefined with symmetry off. */
export function symmetryCopies(doc: Doc): Mat[] | undefined {
  const s = o();
  if (s.mode === 'off') return undefined;
  const c = centreOf(doc);
  const about = (m: Mat) => mul(translate(c.x, c.y), mul(m, translate(-c.x, -c.y)));
  const flipX: Mat = [-1, 0, 0, 1, 0, 0], flipY: Mat = [1, 0, 0, -1, 0, 0];
  if (s.mode === 'v') return [about(flipX)];
  if (s.mode === 'h') return [about(flipY)];
  if (s.mode === 'both') return [about(flipX), about(flipY), about([-1, 0, 0, -1, 0, 0])];
  const n = Math.max(2, Math.round(s.spokes));
  return Array.from({ length: n - 1 }, (_, i) => about(xformMatrix({ x: 0, y: 0, sx: 1, sy: 1, rot: ((i + 1) * Math.PI * 2) / n })));
}

let dragging = false;

/** True (and starts moving the centre) when the press lands on the centre handle instead of painting. */
export function symmetryDown(p: PInfo): boolean {
  const doc = app.doc;
  if (!doc || o().mode === 'off') return false;
  const c = centreOf(doc), s = view.toScreen(c.x, c.y);
  if (Math.hypot(s.x - p.sx, s.y - p.sy) > 9) return false;
  dragging = true;
  return true;
}

/** Moves the centre while it's being dragged (snapping to guides and the canvas); true if it did. */
export function symmetryMove(p: PInfo): boolean {
  const doc = app.doc;
  if (!dragging || !doc) return false;
  const q = snapPoint(p.x, p.y);
  o().cx = Math.min(1, Math.max(0, q.x / doc.width));
  o().cy = Math.min(1, Math.max(0, q.y / doc.height));
  view.requestOverlay();
  return true;
}

export function symmetryUp(): boolean {
  if (!dragging) return false;
  dragging = false;
  clearSnapLines();
  app.saveOpts();
  view.requestOverlay();
  return true;
}

/** Dashed lines (or spokes) where strokes are repeated, and the round handle that moves their centre. */
export function drawSymmetryGuides(ctx: CanvasRenderingContext2D) {
  const doc = app.doc;
  const s = o();
  if (!doc || s.mode === 'off') return;
  const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#2EE6BE';
  const c = centreOf(doc), cs = view.toScreen(c.x, c.y);
  const a = view.toScreen(0, 0), b = view.toScreen(doc.width, doc.height);
  ctx.save();
  ctx.lineWidth = 1;
  ctx.setLineDash([6, 5]);
  ctx.strokeStyle = accent;
  ctx.globalAlpha = 0.8;
  ctx.beginPath();
  // Clip to the canvas so spokes stop at its edge.
  ctx.save();
  ctx.rect(a.x, a.y, b.x - a.x, b.y - a.y);
  ctx.clip();
  ctx.beginPath();
  const x = Math.round(cs.x) + 0.5, y = Math.round(cs.y) + 0.5;
  if (s.mode === 'v' || s.mode === 'both') { ctx.moveTo(x, a.y); ctx.lineTo(x, b.y); }
  if (s.mode === 'h' || s.mode === 'both') { ctx.moveTo(a.x, y); ctx.lineTo(b.x, y); }
  if (s.mode === 'radial') {
    const n = Math.max(2, Math.round(s.spokes)), len = Math.hypot(b.x - a.x, b.y - a.y);
    for (let i = 0; i < n; i++) {
      const t = -Math.PI / 2 + (i * Math.PI * 2) / n;
      ctx.moveTo(x, y); ctx.lineTo(x + Math.cos(t) * len, y + Math.sin(t) * len);
    }
  }
  ctx.stroke();
  ctx.restore();
  ctx.setLineDash([]);
  ctx.globalAlpha = 1;
  const hv = view.hover;
  const hot = dragging || (!!hv && Math.hypot(hv.sx - cs.x, hv.sy - cs.y) <= 9);
  ctx.fillStyle = hot ? accent : '#fff';
  ctx.beginPath(); ctx.arc(x, y, 5, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  ctx.restore();
}
