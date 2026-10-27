import { app } from '../app';
import { newId } from '../core/document';
import type { ShapeLayer } from '../core/types';
import { view } from '../ui/canvasview';
import { checkbox, numField, seg } from '../ui/widgets';
import type { PInfo, Tool } from './tool';

const NAMES = { rect: 'Rectangle', ellipse: 'Ellipse', line: 'Line', polygon: 'Polygon', star: 'Star' };

class ShapeTool implements Tool {
  id = 'shape'; name = 'Shape'; key = 'U'; icon = 'shape' as const;
  hint = 'Drag to draw a shape · Shift keeps it square / snaps lines to 45° · shapes stay sharp at any size';
  private drawing: { layer: ShapeLayer; x: number; y: number } | null = null;
  cursor() { return 'crosshair'; }

  options(bar: HTMLElement) {
    const o = app.opts.shape;
    const poly = o.kind === 'polygon' || o.kind === 'star';
    bar.append(
      seg([{ v: 'rect', icon: 'rect', title: 'Rectangle' }, { v: 'ellipse', icon: 'circle', title: 'Ellipse' }, { v: 'polygon', icon: 'polygon', title: 'Polygon' },
        { v: 'star', icon: 'star', title: 'Star' }, { v: 'line', icon: 'line', title: 'Line' }], o.kind, (v) => { o.kind = v; app.saveOpts(); app.emit('tool'); }),
      ...(poly ? [numField(o.kind === 'star' ? 'Points' : 'Sides', o.sides, (v) => { o.sides = Math.round(v); app.saveOpts(); }, { min: 3, max: 64 })] : []),
      ...(o.kind === 'star' ? [numField('Inner', Math.round(o.inner * 100), (v) => { o.inner = v / 100; app.saveOpts(); }, { unit: '%', min: 5, max: 100 })] : []),
      checkbox('Fill (FG)', o.fill, (v) => { o.fill = v; app.saveOpts(); }),
      checkbox('Stroke', o.stroke, (v) => { o.stroke = v; app.saveOpts(); }, 'Outline in the background colour (or foreground if there is no fill)'),
      numField('Width', o.strokeWidth, (v) => { o.strokeWidth = v; app.saveOpts(); }, { unit: 'px', min: 0, max: 500 }),
      numField('Radius', o.radius, (v) => { o.radius = v; app.saveOpts(); }, { unit: 'px', min: 0, max: 2000 }),
      checkbox('Anti-alias', o.antiAlias, (v) => {
        o.antiAlias = v; app.saveOpts();
        // Also applies to the selected shape.
        const doc = app.doc, a = doc?.active;
        if (doc && a?.type === 'shape' && (a.shape.antiAlias !== false) !== v) { a.shape = { ...a.shape, antiAlias: v }; doc.touch('meta'); doc.commit(v ? 'Anti-alias on' : 'Anti-alias off'); }
      }, 'Turn off for hard pixel edges (pixel art)'),
    );
  }

  down(p: PInfo) {
    const doc = app.doc!;
    const o = app.opts.shape;
    const isLine = o.kind === 'line';
    const fill = !isLine && o.fill ? app.fg : null;
    const stroke = isLine || o.stroke ? (fill ? app.bg : app.fg) : null;
    const layer: ShapeLayer = {
      id: newId(), type: 'shape', name: `${NAMES[o.kind]} ${doc.counter++}`, visible: true, opacity: 1, blend: 'normal',
      t: { x: Math.round(p.x), y: Math.round(p.y), sx: 1, sy: 1, rot: 0 },
      shape: { kind: o.kind, w: 0, h: 0, fill, stroke, strokeWidth: isLine ? Math.max(1, o.strokeWidth) : o.strokeWidth, radius: o.radius, ...(o.antiAlias ? {} : { antiAlias: false }),
        ...(o.kind === 'polygon' || o.kind === 'star' ? { sides: o.sides, inner: o.inner } : {}) },
    };
    doc.insertLayer(layer);
    this.drawing = { layer, x: layer.t.x, y: layer.t.y };
    doc.touch('meta');
  }

  move(p: PInfo) {
    const d = this.drawing;
    if (!d) return;
    let w = Math.round(p.x) - d.x, hh = Math.round(p.y) - d.y;
    if (p.shift) {
      if (d.layer.shape.kind === 'line') {
        const a = Math.round(Math.atan2(hh, w) / (Math.PI / 4)) * (Math.PI / 4), len = Math.hypot(w, hh);
        w = Math.round(Math.cos(a) * len); hh = Math.round(Math.sin(a) * len);
      } else {
        const s = Math.max(Math.abs(w), Math.abs(hh));
        w = Math.sign(w || 1) * s; hh = Math.sign(hh || 1) * s;
      }
    }
    d.layer.shape = { ...d.layer.shape, w, h: hh };
    app.doc!.touch('meta');
  }

  up() {
    const d = this.drawing;
    this.drawing = null;
    if (!d) return;
    const s = d.layer.shape;
    if (Math.abs(s.w) < 2 && Math.abs(s.h) < 2) { app.doc!.revert(); return; }
    if (s.kind !== 'line') {
      // Normalise so the box always grows right/down from its origin.
      d.layer.t = { ...d.layer.t, x: d.layer.t.x + Math.min(0, s.w), y: d.layer.t.y + Math.min(0, s.h) };
      d.layer.shape = { ...s, w: Math.abs(s.w), h: Math.abs(s.h) };
    }
    app.doc!.commit(`Add ${NAMES[s.kind].toLowerCase()}`);
    app.useColor(app.fg);
    view.requestOverlay();
  }
}

class HandTool implements Tool {
  id = 'hand'; name = 'Hand'; key = 'H'; icon = 'hand' as const;
  hint = 'Drag to pan · hold Space with any tool to pan · scroll wheel pans, Ctrl+wheel zooms';
  cursor() { return 'grab'; }
}

class ZoomTool implements Tool {
  id = 'zoom'; name = 'Zoom'; key = 'Z'; icon = 'zoom' as const;
  hint = 'Click to zoom in · Alt+click zooms out · Ctrl+0 fits · Ctrl+1 is 100%';
  cursor() { return 'zoom-in'; }
  down(p: PInfo) { view.zoomStep(p.alt ? -1 : 1, p.sx, p.sy); }
}

export const shapeTool = new ShapeTool();
export const handTool = new HandTool();
export const zoomTool = new ZoomTool();
